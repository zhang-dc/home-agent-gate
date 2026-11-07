import fs from "node:fs";
import path from "node:path";

import { QQBot, type ReplyTarget } from "@tencent-connect/qqbot-nodejs";

import type { Channel, ChannelStatus, InboundMessage } from "../../core/envelope.js";
import { MAX_OUTBOX_PER_USER, mergeOutbox, type OutboxEntry } from "../../core/outbox.js";
import { chunkText } from "../../core/render.js";
import { createLogger } from "../../util/logger.js";

/**
 * QQ 开放平台的被动回复窗口：用户消息后 60 分钟内、每条最多 5 次回复。
 * 留点余量，超出就当主动消息发。
 */
const PASSIVE_WINDOW_MS = 55 * 60_000;
const PASSIVE_MAX_REPLIES = 4;
const QQ_MAX_CHARS = 1800;

export interface QQBotChannelConfig {
  accountId: string;
  appId: string;
  appSecret: string;
  /** When non-empty, only these user openids may talk to the bot. */
  allowFrom: string[];
  stateDir: string;
}

interface PersistedState {
  /** openid -> 最近一条入站消息，用来做被动回复（最稳的一种发送）。 */
  lastInbound?: Record<string, { msgId: string; atMs: number; replies: number }>;
  /** openid -> 三种发送都被拒的消息，等对方下次发消息时合并补发。 */
  outbox?: Record<string, OutboxEntry[]>;
}

/**
 * QQ 机器人私聊（C2C）渠道，基于腾讯官方 SDK @tencent-connect/qqbot-nodejs（WebSocket，
 * 出站连接，不需要公网回调）。群聊暂不接：群里的消息直接忽略。
 *
 * 发送按「被动回复 → 主动消息 → 唤醒消息 → 排队」逐级降级。2026-10-09 实测三种都能发，
 * 但 QQ 对主动消息有频率限制、文档也不保证长期可用，所以降级链 + outbox 一个都不能省。
 */
export class QQBotChannel implements Channel {
  readonly id: string;
  private bot: QQBot;
  private loop?: Promise<void>;
  private log;
  private state: PersistedState = {};
  private statePath: string;
  private stats = {
    startedAtMs: 0,
    readyAtMs: 0,
    lastInboundAtMs: 0,
    inboundCount: 0,
    lastErrorAtMs: 0,
    lastError: "",
    lastSendMode: "",
  };

  constructor(private cfg: QQBotChannelConfig) {
    this.id = `qqbot:${cfg.accountId}`;
    this.log = createLogger(this.id);
    this.statePath = path.join(cfg.stateDir, `qqbot-${cfg.accountId}.json`);
    try {
      if (fs.existsSync(this.statePath)) {
        this.state = JSON.parse(fs.readFileSync(this.statePath, "utf-8")) as PersistedState;
      }
    } catch {
      this.state = {};
    }
    const sdkLog = createLogger(`${this.id}:sdk`);
    this.bot = new QQBot({
      appId: cfg.appId,
      appSecret: cfg.appSecret,
      accountId: cfg.accountId,
      logger: {
        debug: (...a: unknown[]) => sdkLog.debug(a.map(String).join(" ")),
        info: (...a: unknown[]) => sdkLog.debug(a.map(String).join(" ")),
        warn: (...a: unknown[]) => sdkLog.warn(a.map(String).join(" ")),
        error: (...a: unknown[]) => sdkLog.error(a.map(String).join(" ")),
      },
    });
  }

  async start(onMessage: (msg: InboundMessage) => void): Promise<void> {
    this.bot.on("ready", () => {
      this.stats.readyAtMs = Date.now();
      this.log.info("gateway READY");
    });
    this.bot.on("resumed", () => this.log.info("gateway resumed"));
    this.bot.on("error", (err) => {
      this.stats.lastErrorAtMs = Date.now();
      this.stats.lastError = String(err).slice(0, 300);
      this.log.error(`sdk error: ${String(err)}`);
    });
    this.bot.on("message", (_ctx, msg) => {
      if (msg.kind !== "c2c") {
        this.log.info(`ignoring ${msg.kind} message (only c2c is wired)`);
        return;
      }
      const from = msg.senderId;
      if (this.cfg.allowFrom.length > 0 && !this.cfg.allowFrom.includes(from)) {
        this.log.warn(`dropping message from unauthorized user ${from}`);
        return;
      }
      this.state.lastInbound = { ...this.state.lastInbound, [from]: { msgId: msg.messageId, atMs: Date.now(), replies: 0 } };
      this.persist();
      void this.flushOutbox(from).catch((err) => this.log.error(`outbox flush failed: ${String(err)}`));

      const text = msg.content.trim();
      if (!text) {
        this.log.info(`inbound from ${from}: no text (attachments=${msg.attachments?.length ?? 0}), ignored`);
        return;
      }
      this.log.info(`inbound from ${from}: ${text.length} chars`);
      this.stats.lastInboundAtMs = Date.now();
      this.stats.inboundCount += 1;
      const ts = Date.parse(msg.timestamp);
      onMessage({ chatKey: `${this.id}:${from}`, from, text, ...(Number.isFinite(ts) ? { timestampMs: ts } : {}) });
    });

    this.stats.startedAtMs = Date.now();
    // SDK 的 start() 要等连接被 stop() 才 resolve（里面自带重连），不能 await，否则网关主流程卡死在这
    this.loop = this.bot.start().catch((err) => {
      this.stats.lastErrorAtMs = Date.now();
      this.stats.lastError = `start: ${String(err)}`.slice(0, 300);
      this.log.error(`sdk transport exited: ${String(err)}`);
    });
    this.log.info(`started (allowFrom=${this.cfg.allowFrom.length || "any"})`);
  }

  async stop(): Promise<void> {
    this.bot.stop();
    await this.loop;
    this.log.info("stopped");
  }

  async sendText(to: string, text: string): Promise<void> {
    // dispatcher 按 3500 分块；QQ 单条上限文档没写死，再切小一档，免得超长被拒后整条烂在队列里
    for (const piece of chunkText(text, QQ_MAX_CHARS)) {
      if (await this.deliver(to, piece)) continue;
      this.enqueue(to, piece);
      this.log.warn(`三种发送都被拒，已排队 ${this.state.outbox?.[to]?.length ?? 0} 条，等对方下次发消息补发`);
    }
  }

  /** 逐级降级发送；全部失败返回 false（由调用方决定排队）。 */
  private async deliver(to: string, text: string): Promise<boolean> {
    const attempts: Array<[string, () => Promise<unknown>]> = [];
    const last = this.state.lastInbound?.[to];
    if (last && Date.now() - last.atMs < PASSIVE_WINDOW_MS && last.replies < PASSIVE_MAX_REPLIES) {
      attempts.push([
        "passive",
        async () => {
          await this.bot.sendText({ scope: "c2c", targetId: to, msgId: last.msgId }, text);
          last.replies += 1;
          this.persist();
        },
      ]);
    }
    const target: ReplyTarget = { scope: "c2c", targetId: to };
    attempts.push(["proactive", () => this.bot.sendText(target, text)]);
    attempts.push(["wakeup", () => this.bot.sendWakeup(target, text)]);

    for (const [mode, send] of attempts) {
      try {
        await send();
        this.stats.lastSendMode = mode;
        this.log.info(`outbound ok via ${mode} (${text.length} chars)`);
        return true;
      } catch (err) {
        this.stats.lastErrorAtMs = Date.now();
        this.stats.lastError = `${mode}: ${String(err)}`.slice(0, 300);
        this.log.warn(`outbound via ${mode} rejected: ${String(err)}`);
      }
    }
    return false;
  }

  private enqueue(to: string, text: string): void {
    const outbox = { ...this.state.outbox };
    outbox[to] = [...(outbox[to] ?? []), { text, queuedAtMs: Date.now() }].slice(-MAX_OUTBOX_PER_USER);
    this.state.outbox = outbox;
    this.persist();
  }

  /** 对方刚发了消息（被动回复窗口重开），把积压合并成尽量少的几条补发。 */
  private async flushOutbox(to: string): Promise<void> {
    const queue = this.state.outbox?.[to];
    if (!queue?.length) return;
    const batches = mergeOutbox(queue);
    this.log.info(`outbox: ${queue.length} 条合并为 ${batches.length} 条补发`);
    for (const [i, text] of batches.entries()) {
      if (!(await this.deliver(to, text))) {
        this.log.error(`outbox: 第 ${i + 1}/${batches.length} 批补发失败，队列保留`);
        return;
      }
    }
    const outbox = { ...this.state.outbox };
    delete outbox[to];
    this.state.outbox = outbox;
    this.persist();
  }

  async setTyping(to: string, typing: boolean): Promise<void> {
    if (!typing) return;
    const last = this.state.lastInbound?.[to];
    if (!last || Date.now() - last.atMs > PASSIVE_WINDOW_MS) return;
    try {
      await this.bot.sendTyping({ scope: "c2c", targetId: to, msgId: last.msgId });
    } catch (err) {
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
      appId: this.cfg.appId,
      allowFrom: this.cfg.allowFrom,
      outboxPending: Object.values(this.state.outbox ?? {}).reduce((n, q) => n + q.length, 0),
      ...this.stats,
      // 面板拿它判「渠道活着」。WebSocket 没有轮询，SDK 自己管心跳/RESUME，READY 过就算在线。
      lastPollOkAtMs: this.stats.readyAtMs ? Date.now() : 0,
    };
  }
}
