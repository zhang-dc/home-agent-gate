import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import type { Channel, ChannelStatus, InboundMessage } from "../../core/envelope.js";
import { MAX_OUTBOX_PER_USER, mergeOutbox, type OutboxEntry } from "../../core/outbox.js";
import { createLogger } from "../../util/logger.js";
import { PREPARE_FAILED_RET, WeixinApiClient, WeixinApiError } from "./api.js";
import { DEFAULT_CDN_BASE_URL, downloadImageToFile } from "./media.js";
import {
  MessageItemType,
  MessageType,
  MessageState,
  SESSION_EXPIRED_ERRCODE,
  TypingStatus,
  type ImageItem,
  type MessageItem,
  type WeixinMessage,
} from "./types.js";

const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
const SESSION_PAUSE_MS = 60 * 60_000;

export interface WeixinChannelConfig {
  accountId: string;
  baseUrl: string;
  token: string;
  /** When non-empty, only these user ids may talk to the bot. */
  allowFrom: string[];
  /** Directory for cursor / context-token persistence. */
  stateDir: string;
}

interface PersistedState {
  getUpdatesBuf?: string;
  /** userId -> context_token; must be echoed on every outbound send. */
  contextTokens?: Record<string, string>;
  /** userId -> when that context_token arrived, so we can log its age on every send. */
  contextTokenAtMs?: Record<string, number>;
  /**
   * userId -> sends the platform refused because the window was closed.
   * Flushed on the user's next inbound message (that's what reopens it).
   */
  outbox?: Record<string, OutboxEntry[]>;
}

export class WeixinChannel implements Channel {
  readonly id: string;
  private api: WeixinApiClient;
  private log;
  private abort = new AbortController();
  private state: PersistedState = {};
  private statePath: string;
  private typingTickets = new Map<string, string>();
  private loop?: Promise<void>;
  private stats = { startedAtMs: 0, lastPollOkAtMs: 0, lastInboundAtMs: 0, inboundCount: 0, lastErrorAtMs: 0, lastError: "" };

  constructor(private cfg: WeixinChannelConfig) {
    this.id = `weixin:${cfg.accountId}`;
    this.log = createLogger(this.id);
    this.api = new WeixinApiClient({ baseUrl: cfg.baseUrl, token: cfg.token });
    this.statePath = path.join(cfg.stateDir, `weixin-${cfg.accountId}.json`);
    try {
      if (fs.existsSync(this.statePath)) {
        this.state = JSON.parse(fs.readFileSync(this.statePath, "utf-8")) as PersistedState;
      }
    } catch {
      this.state = {};
    }
  }

  async start(onMessage: (msg: InboundMessage) => void): Promise<void> {
    try {
      await this.api.notifyStart();
    } catch (err) {
      this.log.warn(`notifyStart failed (continuing): ${String(err)}`);
    }
    this.log.info(
      `started (buf=${this.state.getUpdatesBuf ? "resumed" : "fresh"}, allowFrom=${this.cfg.allowFrom.length || "any"})`,
    );
    this.stats.startedAtMs = Date.now();
    this.loop = this.pollLoop(onMessage);
  }

  async stop(): Promise<void> {
    this.abort.abort();
    try {
      await this.api.notifyStop();
    } catch {
      // best-effort
    }
    await this.loop?.catch(() => {});
    this.log.info("stopped");
  }

  private async pollLoop(onMessage: (msg: InboundMessage) => void): Promise<void> {
    let timeoutMs: number | undefined;
    let failures = 0;
    const signal = this.abort.signal;

    while (!signal.aborted) {
      try {
        const resp = await this.api.getUpdates({
          getUpdatesBuf: this.state.getUpdatesBuf ?? "",
          timeoutMs,
          abortSignal: signal,
        });
        if (signal.aborted) return;

        if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0) {
          timeoutMs = resp.longpolling_timeout_ms;
        }

        const failed = (resp.ret !== undefined && resp.ret !== 0) || (resp.errcode !== undefined && resp.errcode !== 0);
        if (failed) {
          if (resp.errcode === SESSION_EXPIRED_ERRCODE || resp.ret === SESSION_EXPIRED_ERRCODE) {
            this.log.error(
              `bot session expired (errcode ${SESSION_EXPIRED_ERRCODE}) — pausing 60min; re-scan QR to re-bind if this persists`,
            );
            failures = 0;
            await sleep(SESSION_PAUSE_MS, signal);
            continue;
          }
          failures += 1;
          this.log.error(`getUpdates failed: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""}`);
          await sleep(failures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS, signal);
          if (failures >= MAX_CONSECUTIVE_FAILURES) failures = 0;
          continue;
        }
        failures = 0;
        this.stats.lastPollOkAtMs = Date.now();

        if (resp.get_updates_buf) {
          this.state.getUpdatesBuf = resp.get_updates_buf;
          this.persist();
        }

        for (const raw of resp.msgs ?? []) {
          const inbound = await this.normalize(raw);
          if (inbound) onMessage(inbound);
        }
      } catch (err) {
        if (signal.aborted) return;
        failures += 1;
        this.stats.lastErrorAtMs = Date.now();
        this.stats.lastError = String(err).slice(0, 300);
        this.log.error(`poll error (${failures}/${MAX_CONSECUTIVE_FAILURES}): ${String(err)}`);
        try {
          await sleep(failures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS, signal);
        } catch {
          return;
        }
        if (failures >= MAX_CONSECUTIVE_FAILURES) failures = 0;
      }
    }
  }

  private async normalize(msg: WeixinMessage): Promise<InboundMessage | undefined> {
    const from = msg.from_user_id ?? "";
    if (!from) return undefined;
    // Defensive: ignore echoes of our own bot messages and unfinished streams.
    if (msg.message_type === MessageType.BOT) return undefined;
    if (msg.message_state !== undefined && msg.message_state !== MessageState.FINISH) return undefined;

    if (msg.context_token) {
      this.state.contextTokens = { ...this.state.contextTokens, [from]: msg.context_token };
      this.state.contextTokenAtMs = { ...this.state.contextTokenAtMs, [from]: Date.now() };
      this.persist();
      // This message is what reopens the send window — flush anything the
      // platform refused while it was closed (scheduled pushes, alerts).
      if (this.cfg.allowFrom.length === 0 || this.cfg.allowFrom.includes(from)) {
        void this.flushOutbox(from).catch((err) => this.log.error(`outbox flush failed: ${String(err)}`));
      }
    }

    if (this.cfg.allowFrom.length > 0 && !this.cfg.allowFrom.includes(from)) {
      this.log.warn(`dropping message from unauthorized user ${from}`);
      return undefined;
    }

    const text = bodyFromItemList(msg.item_list);
    const imagePath = await this.downloadInboundImage(msg.item_list, from);
    if (!text && !imagePath) {
      this.log.info(`inbound from ${from}: no usable content (types=${msg.item_list?.map((i) => i.type).join(",")}), ignored`);
      return undefined;
    }

    this.log.info(`inbound from ${from}: ${text.length} chars${imagePath ? ` + image ${path.basename(imagePath)}` : ""}`);
    this.stats.lastInboundAtMs = Date.now();
    this.stats.inboundCount += 1;
    return {
      chatKey: `${this.id}:${from}`,
      from,
      text,
      ...(imagePath ? { imagePath } : {}),
      timestampMs: msg.create_time_ms,
    };
  }

  /**
   * Download the first inbound image, direct or quoted: CDN fetch +
   * AES-128-ECB decrypt, saved under state/media. Failures are logged and
   * treated as "no image" so a bad download never blocks the text.
   */
  private async downloadInboundImage(itemList: MessageItem[] | undefined, from: string): Promise<string | undefined> {
    let img: ImageItem | undefined;
    for (const item of itemList ?? []) {
      if (item.type === MessageItemType.IMAGE && item.image_item) {
        img = item.image_item;
        break;
      }
      const refItem = item.ref_msg?.message_item;
      if (item.type === MessageItemType.TEXT && refItem?.type === MessageItemType.IMAGE && refItem.image_item) {
        img = refItem.image_item as ImageItem;
        break;
      }
    }
    if (!img) return undefined;
    try {
      return await downloadImageToFile(img, DEFAULT_CDN_BASE_URL, path.join(this.cfg.stateDir, "media"));
    } catch (err) {
      this.log.error(`image download failed (from=${from}): ${String(err)}`);
      return undefined;
    }
  }

  /**
   * Send text, queueing it when the platform's send window is closed.
   *
   * WeChat bots cannot push proactively: a send is only accepted while a
   * `context_token` from the user's *latest* inbound message is still valid —
   * an old one gets ret=-2 "prepare failed". So a scheduled push that lands
   * after a quiet stretch cannot be delivered at all; queueing it and flushing
   * on the next inbound message is the only way not to lose it.
   */
  async sendText(to: string, text: string): Promise<void> {
    try {
      await this.deliver(to, text);
      return;
    } catch (err) {
      if (!isWindowClosed(err)) throw err;
      this.log.warn(
        `sendText 被拒（${err instanceof WeixinApiError ? `ret=${err.ret}` : "unknown"}），` +
          `重新 notifyStart 后重试一次`,
      );
    }

    // 2026-09-16 实测：同一个 context_token、同一份报文，重启网关（即重新调
    // notifystart）前被拒 ret=-2，重启后立刻发成功。所以 "prepare failed" 更像
    // 是"这个 bot 客户端没在线"，而不是 token 过期 —— 先补一次 notifystart 再重试。
    try {
      await this.api.notifyStart();
      await this.deliver(to, text);
      this.log.info("notifyStart 后重发成功");
      return;
    } catch (retryErr) {
      if (!isWindowClosed(retryErr)) throw retryErr;
      this.enqueue(to, text);
      this.log.warn(
        `出站窗口仍然关闭（notifyStart 也没救回来），已排队 ${this.state.outbox?.[to]?.length ?? 0} 条，` +
          `等对方下次发消息补发`,
      );
    }
  }

  private async deliver(to: string, text: string): Promise<void> {
    const contextToken = this.state.contextTokens?.[to];
    if (!contextToken) {
      this.log.warn(`sendText: no context token for ${to}; sending without context`);
    }
    // Token age on every send: the platform documents no TTL for context_token,
    // so this log is how we learn empirically where the window actually closes.
    const tokenAtMs = this.state.contextTokenAtMs?.[to];
    const ageLabel = tokenAtMs ? `${((Date.now() - tokenAtMs) / 3_600_000).toFixed(1)}h` : "unknown";
    await this.api.sendMessage({
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: `home-agent-gate-${crypto.randomUUID()}`,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
        ...(contextToken ? { context_token: contextToken } : {}),
      },
    });
    this.log.info(`outbound ok (${text.length} chars, context_token age ${ageLabel})`);
  }

  private enqueue(to: string, text: string): void {
    const outbox = { ...this.state.outbox };
    const queue = [...(outbox[to] ?? []), { text, queuedAtMs: Date.now() }];
    outbox[to] = queue.slice(-MAX_OUTBOX_PER_USER);
    this.state.outbox = outbox;
    this.persist();
  }

  /**
   * Flush queued sends after an inbound message reopened the window. Each entry
   * is prefixed with when it was originally due, so a day-old push does not
   * read as fresh news.
   *
   * ★ 合并后再发，不逐条轰。2026-09-21 实测：窗口重开后连发 10 条，第 11 条起
   * 又被拒 ret=-2 —— 一个 context_token 的额度就那么多，逐条补发必然发不完，
   * 剩下的继续烂在队列里，下次说话再重复一轮（这就是「又没推送」的根因）。
   * 合并成尽量少的消息后，一个 token 足够把积压清干净。
   */
  private async flushOutbox(to: string): Promise<void> {
    const queue = this.state.outbox?.[to];
    if (!queue?.length) return;
    const batches = mergeOutbox(queue);
    this.log.info(`outbox: 窗口已打开，${queue.length} 条合并为 ${batches.length} 条补发`);
    for (const [i, text] of batches.entries()) {
      try {
        await this.deliver(to, text);
      } catch (err) {
        // 合并批次无法精确映射回原条目，失败就整队保留，下次重试（宁可重发不可丢）
        this.log.error(`outbox: 第 ${i + 1}/${batches.length} 批补发失败，队列保留: ${String(err)}`);
        return;
      }
    }
    const outbox = { ...this.state.outbox };
    delete outbox[to];
    this.state.outbox = outbox;
    this.persist();
  }

  async setTyping(to: string, typing: boolean): Promise<void> {
    try {
      let ticket = this.typingTickets.get(to);
      if (!ticket) {
        const cfg = await this.api.getConfig({
          ilinkUserId: to,
          contextToken: this.state.contextTokens?.[to],
        });
        if (!cfg.typing_ticket) return;
        ticket = cfg.typing_ticket;
        this.typingTickets.set(to, ticket);
      }
      await this.api.sendTyping({
        ilinkUserId: to,
        typingTicket: ticket,
        status: typing ? TypingStatus.TYPING : TypingStatus.CANCEL,
      });
    } catch (err) {
      // Typing is cosmetic; refresh the ticket next time and move on.
      this.typingTickets.delete(to);
      this.log.debug(`setTyping failed: ${String(err)}`);
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    fs.writeFileSync(this.statePath, JSON.stringify(this.state), "utf-8");
  }

  /** Runtime health snapshot for the admin panel. */
  status(): ChannelStatus {
    return {
      id: this.id,
      accountId: this.cfg.accountId,
      baseUrl: this.cfg.baseUrl,
      allowFrom: this.cfg.allowFrom,
      outboxPending: Object.values(this.state.outbox ?? {}).reduce((n, q) => n + q.length, 0),
      contextTokenAgeMs: Object.values(this.state.contextTokenAtMs ?? {}).reduce(
        (oldest, at) => Math.max(oldest, Date.now() - at),
        0,
      ),
      ...this.stats,
    };
  }
}

/**
 * 出站被拒是否属于「窗口关了」—— ret=-2 prepare failed（context_token 不可用）
 * 或 errcode=-14 会话超时。这两种排队等下次入站补发，其它错误照常抛。
 */
function isWindowClosed(err: unknown): boolean {
  return err instanceof WeixinApiError && (err.ret === PREPARE_FAILED_RET || err.errcode === SESSION_EXPIRED_ERRCODE);
}

/** Extract a text body: plain text, quoted-reply context, or voice transcript. */
function bodyFromItemList(itemList?: MessageItem[]): string {
  if (!itemList?.length) return "";
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      const text = String(item.text_item.text);
      const ref = item.ref_msg;
      if (!ref) return text;
      const parts: string[] = [];
      if (ref.title) parts.push(ref.title);
      if (ref.message_item) {
        const refBody = bodyFromItemList([ref.message_item]);
        if (refBody) parts.push(refBody);
      }
      return parts.length ? `[引用: ${parts.join(" | ")}]\n${text}` : text;
    }
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      return item.voice_item.text;
    }
  }
  return "";
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}
