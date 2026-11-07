import type { Channel, InboundMessage } from "./envelope.js";
import type { ReasoningBackend } from "./backend.js";
import { SessionStore } from "./session-store.js";
import { KVFile } from "./kv-store.js";
import { chunkText, markdownToPlainText } from "./render.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("dispatcher");

interface ChatState {
  queue: InboundMessage[];
  running: boolean;
  abort?: AbortController;
}

export interface DispatcherOptions {
  /** Named contexts: profile name -> backend instance. */
  profiles: Map<string, ReasoningBackend>;
  defaultProfile: string;
  sessions: SessionStore;
  /** chatKey -> active profile name, persisted. */
  activeProfiles: KVFile;
  /** Sent as the reply when a turn errors out. */
  errorNotice?: string;
  /** Max queued messages per chat while a turn is running. */
  maxQueue?: number;
}

/** One inbound message's contribution to the merged turn prompt. */
function renderPromptPart(m: InboundMessage): string {
  if (!m.imagePath) return m.text;
  const imageNote = `[用户发来一张图片，已保存在本地: ${m.imagePath} —— 请先用读取工具查看图片内容再回答]`;
  return m.text ? `${m.text}\n${imageNote}` : imageNote;
}

export const HANDOFF_BRIEF_PROMPT =
  "现在要把这段对话交接给另一个助手继续。请把到目前为止的任务背景、关键结论、涉及的文件/数据/代码位置、未完成事项，写成一份简洁的交接简报（纯文本，400 字以内）。只输出简报本身，不要任何开场白。";

/**
 * Wires one channel to a set of named reasoning contexts (profiles).
 * Turns within a chat run strictly serially; each profile keeps its own
 * harness session, so switching contexts never loses either side.
 *
 * Commands: /ctx (list) · /ctx use <name> · /handoff <name> [附言] ·
 * /new (reset active profile's session) · /stop · /status
 */
export class Dispatcher {
  private chats = new Map<string, ChatState>();

  constructor(
    private channel: Channel,
    private opts: DispatcherOptions,
  ) {}

  private activeProfile(chatKey: string): string {
    const saved = this.opts.activeProfiles.get(chatKey);
    return saved && this.opts.profiles.has(saved) ? saved : this.opts.defaultProfile;
  }

  // ------------------------------------------------------------------
  // Panel control surface
  // ------------------------------------------------------------------

  profileNames(): string[] {
    return [...this.opts.profiles.keys()];
  }

  /** Every chat known from runtime state, session store, or profile store. */
  snapshotChats(): Array<{
    chatKey: string;
    activeProfile: string;
    running: boolean;
    queueLength: number;
    sessions: Record<string, { sessionId: string; updatedAtMs: number }>;
  }> {
    const chatKeys = new Set<string>(this.chats.keys());
    for (const [k] of this.opts.activeProfiles.entries()) chatKeys.add(k);
    for (const { key } of this.opts.sessions.snapshot()) {
      const hash = key.lastIndexOf("#");
      if (hash > 0) chatKeys.add(key.slice(0, hash));
    }
    return [...chatKeys].sort().map((chatKey) => {
      const state = this.chats.get(chatKey);
      const sessions: Record<string, { sessionId: string; updatedAtMs: number }> = {};
      for (const { key, sessionId, updatedAtMs } of this.opts.sessions.snapshot()) {
        if (key.startsWith(`${chatKey}#`)) {
          sessions[key.slice(chatKey.length + 1)] = { sessionId, updatedAtMs };
        }
      }
      return {
        chatKey,
        activeProfile: this.activeProfile(chatKey),
        running: state?.running ?? false,
        queueLength: state?.queue.length ?? 0,
        sessions,
      };
    });
  }

  /** Panel action: switch a chat's active context. */
  setActiveProfile(chatKey: string, profile: string): { ok: boolean; error?: string } {
    if (!this.opts.profiles.has(profile)) return { ok: false, error: `unknown profile: ${profile}` };
    this.opts.activeProfiles.set(chatKey, profile);
    log.info(`${chatKey}: context switch via panel -> ${profile}`);
    return { ok: true };
  }

  /** Panel action: drop one profile's session so the next turn starts fresh. */
  resetSession(chatKey: string, profile: string): { ok: boolean; error?: string } {
    if (!this.opts.profiles.has(profile)) return { ok: false, error: `unknown profile: ${profile}` };
    this.opts.sessions.reset(this.sessionKey(chatKey, profile));
    log.info(`${chatKey}: session reset via panel (${profile})`);
    return { ok: true };
  }

  /** Panel action: abort the chat's running turn. */
  stopTurn(chatKey: string): { ok: boolean; error?: string } {
    const state = this.chats.get(chatKey);
    if (!state?.running || !state.abort) return { ok: false, error: "该聊天当前没有运行中的任务" };
    state.abort.abort();
    return { ok: true };
  }

  /**
   * Panel action: run a handoff. The brief + the target's reply are sent
   * to the chat's user on the channel, same as the /handoff command.
   */
  triggerHandoff(chatKey: string, target: string, note: string): { ok: boolean; error?: string } {
    if (!this.opts.profiles.has(target)) return { ok: false, error: `unknown profile: ${target}` };
    const state = this.chats.get(chatKey) ?? { queue: [], running: false };
    this.chats.set(chatKey, state);
    if (state.running) return { ok: false, error: "该聊天有任务在跑，先停止或等它结束" };
    const from = chatKey.split(":").slice(2).join(":");
    if (!from) return { ok: false, error: `无法从 chatKey 解析用户: ${chatKey}` };
    void this.runHandoff({ chatKey, from, text: "" }, state, target, note);
    return { ok: true };
  }

  /**
   * Panel action: deliver text straight to the chat's user, with no model
   * turn at all. For scheduled jobs whose output is already final (a script
   * digest, a link, an alert) — no tokens spent, and one less thing that can
   * fail. Fire-and-forget: send errors are logged, not surfaced.
   */
  sendDirect(chatKey: string, text: string): { ok: boolean; error?: string } {
    const from = chatKey.split(":").slice(2).join(":");
    if (!from) return { ok: false, error: `无法从 chatKey 解析用户: ${chatKey}` };
    if (!text.trim()) return { ok: false, error: "text 不能为空" };
    log.info(`${chatKey}: direct send (${text.length} chars)`);
    void this.reply({ chatKey, from, text: "" }, text);
    return { ok: true };
  }

  /**
   * Panel action: inject a synthetic user message into a chat (scheduled
   * jobs / external triggers). Goes through the same queue as real input,
   * so the reply is delivered to the user on the channel.
   */
  injectMessage(chatKey: string, text: string): { ok: boolean; error?: string } {
    const from = chatKey.split(":").slice(2).join(":");
    if (!from) return { ok: false, error: `无法从 chatKey 解析用户: ${chatKey}` };
    if (!text.trim()) return { ok: false, error: "text 不能为空" };
    log.info(`${chatKey}: inject via panel: ${text.slice(0, 80)}`);
    this.handleInbound({ chatKey, from, text, timestampMs: Date.now() });
    return { ok: true };
  }

  private sessionKey(chatKey: string, profile: string): string {
    return `${chatKey}#${profile}`;
  }

  handleInbound = (msg: InboundMessage): void => {
    const state = this.chats.get(msg.chatKey) ?? { queue: [], running: false };
    this.chats.set(msg.chatKey, state);

    if (this.handleCommand(msg, state)) return;

    const maxQueue = this.opts.maxQueue ?? 10;
    if (state.running) {
      if (state.queue.length >= maxQueue) {
        log.warn(`${msg.chatKey}: queue full, dropping message`);
        void this.reply(msg, "排队消息太多了，这条先不处理，稍后再发。");
        return;
      }
      state.queue.push(msg);
      log.info(`${msg.chatKey}: turn in progress, queued (${state.queue.length})`);
      return;
    }

    void this.runLoop(msg, state);
  };

  /** Returns true when the message was a command and has been handled. */
  private handleCommand(msg: InboundMessage, state: ChatState): boolean {
    const text = msg.text.trim();
    if (!text.startsWith("/")) return false;
    const [cmd = "", ...rest] = text.split(/\s+/);

    switch (cmd) {
      case "/new":
      case "/reset": {
        const profile = this.activeProfile(msg.chatKey);
        this.opts.sessions.reset(this.sessionKey(msg.chatKey, profile));
        void this.reply(msg, `好的，「${profile}」已开启新会话。`);
        return true;
      }
      case "/stop": {
        if (state.running && state.abort) {
          state.abort.abort();
          void this.reply(msg, "正在停止当前任务…");
        } else {
          void this.reply(msg, "当前没有正在运行的任务。");
        }
        return true;
      }
      case "/status": {
        void this.reply(msg, this.renderStatus(msg.chatKey, state));
        return true;
      }
      case "/ctx": {
        const sub = rest[0];
        if (!sub || sub === "list") {
          void this.reply(msg, this.renderCtxList(msg.chatKey));
          return true;
        }
        if (sub === "use") {
          this.switchProfile(msg, rest[1]);
          return true;
        }
        void this.reply(msg, "用法：/ctx 列出上下文，/ctx use <名字> 切换。");
        return true;
      }
      case "/use": {
        this.switchProfile(msg, rest[0]);
        return true;
      }
      case "/handoff": {
        const target = rest[0];
        const note = rest.slice(1).join(" ");
        if (!target || !this.opts.profiles.has(target)) {
          void this.reply(msg, `用法：/handoff <目标上下文> [附言]。可选：${[...this.opts.profiles.keys()].join("、")}`);
          return true;
        }
        if (state.running) {
          void this.reply(msg, "当前有任务在跑，等它结束（或 /stop）后再交接。");
          return true;
        }
        void this.runHandoff(msg, state, target, note);
        return true;
      }
      default:
        // Unknown slash command — let the model see it (could be a skill).
        return false;
    }
  }

  private switchProfile(msg: InboundMessage, target?: string): void {
    if (!target || !this.opts.profiles.has(target)) {
      void this.reply(msg, `没有这个上下文。可选：${[...this.opts.profiles.keys()].join("、")}`);
      return;
    }
    const current = this.activeProfile(msg.chatKey);
    if (current === target) {
      void this.reply(msg, `已经在「${target}」上下文了。`);
      return;
    }
    this.opts.activeProfiles.set(msg.chatKey, target);
    const hasSession = this.opts.sessions.get(this.sessionKey(msg.chatKey, target)) != null;
    log.info(`${msg.chatKey}: context switch ${current} -> ${target}`);
    void this.reply(msg, `已切到「${target}」（${hasSession ? "继续上次会话" : "新会话"}）。「${current}」的会话保留着，随时切回。`);
  }

  private renderCtxList(chatKey: string): string {
    const active = this.activeProfile(chatKey);
    const lines = [...this.opts.profiles.entries()].map(([name, backend]) => {
      const mark = name === active ? "▶" : "・";
      const session = this.opts.sessions.get(this.sessionKey(chatKey, name));
      return `${mark} ${name}（${backend.id}）${session ? " — 有会话" : ""}`;
    });
    return `上下文列表：\n${lines.join("\n")}\n\n/ctx use <名字> 切换，/handoff <名字> 交接。`;
  }

  private renderStatus(chatKey: string, state: ChatState): string {
    const active = this.activeProfile(chatKey);
    const sessionId = this.opts.sessions.get(this.sessionKey(chatKey, active));
    return [
      `上下文: ${active}`,
      `运行中: ${state.running ? "是" : "否"}`,
      `排队: ${state.queue.length}`,
      `会话: ${sessionId ?? "(新)"}`,
    ].join("\n");
  }

  private async runLoop(first: InboundMessage, state: ChatState): Promise<void> {
    state.running = true;
    let current: InboundMessage | undefined = first;
    try {
      while (current) {
        // Merge anything that queued up while we were idle-checking into one turn.
        const merged = [current, ...state.queue.splice(0)];
        const prompt = merged.map(renderPromptPart).join("\n\n");
        const images = merged.flatMap((m) => (m.imagePath ? [m.imagePath] : []));
        await this.runTurn(merged[merged.length - 1]!, prompt, images, state);
        current = state.queue.shift();
      }
    } finally {
      state.running = false;
      state.abort = undefined;
    }
  }

  private async runTurn(msg: InboundMessage, prompt: string, images: string[], state: ChatState): Promise<void> {
    const profile = this.activeProfile(msg.chatKey);
    const backend = this.opts.profiles.get(profile)!;
    const sessionKey = this.sessionKey(msg.chatKey, profile);
    const abort = new AbortController();
    state.abort = abort;
    const sessionId = this.opts.sessions.get(sessionKey);
    log.info(`${msg.chatKey}: turn start (ctx=${profile}, session=${sessionId ?? "new"}, ${prompt.length} chars)`);

    void this.channel.setTyping(msg.from, true).catch(() => {});
    try {
      const result = await backend.runTurn({
        prompt,
        ...(images.length ? { images } : {}),
        sessionId,
        abortSignal: abort.signal,
      });
      if (result.sessionId) this.opts.sessions.set(sessionKey, result.sessionId);

      const cost = result.costUsd != null ? ` cost=$${result.costUsd.toFixed(4)}` : "";
      log.info(`${msg.chatKey}: turn done (ctx=${profile}, error=${result.isError}${cost})`);

      const text = result.text.trim() || (result.isError ? "" : "(空回复)");
      if (result.isError) {
        await this.reply(msg, this.opts.errorNotice ?? `出错了：${text || "未知错误"}`);
      } else {
        await this.reply(msg, text);
      }
    } catch (err) {
      if (abort.signal.aborted) {
        log.info(`${msg.chatKey}: turn aborted by /stop`);
        await this.reply(msg, "已停止。");
      } else {
        log.error(`${msg.chatKey}: turn failed: ${String(err)}`);
        await this.reply(msg, this.opts.errorNotice ?? "出错了，这条消息没有处理成功。");
      }
    } finally {
      void this.channel.setTyping(msg.from, false).catch(() => {});
    }
  }

  /**
   * Handoff: ask the current context to write a brief of the conversation
   * so far, switch to the target context, and seed its next turn with the
   * brief. Both sessions are preserved.
   */
  private async runHandoff(msg: InboundMessage, state: ChatState, target: string, note: string): Promise<void> {
    state.running = true;
    const abort = new AbortController();
    state.abort = abort;
    const from = this.activeProfile(msg.chatKey);

    try {
      if (from === target) {
        await this.reply(msg, `已经在「${target}」上下文了，不需要交接。`);
        return;
      }

      let brief = "";
      const fromSession = this.opts.sessions.get(this.sessionKey(msg.chatKey, from));
      if (fromSession) {
        await this.reply(msg, `正在让「${from}」整理交接简报…`);
        void this.channel.setTyping(msg.from, true).catch(() => {});
        const fromBackend = this.opts.profiles.get(from)!;
        const briefResult = await fromBackend.runTurn({
          prompt: HANDOFF_BRIEF_PROMPT,
          sessionId: fromSession,
          abortSignal: abort.signal,
        });
        if (briefResult.sessionId) this.opts.sessions.set(this.sessionKey(msg.chatKey, from), briefResult.sessionId);
        if (!briefResult.isError) brief = briefResult.text.trim();
      }

      this.opts.activeProfiles.set(msg.chatKey, target);
      log.info(`${msg.chatKey}: handoff ${from} -> ${target} (brief=${brief.length} chars)`);

      const seedParts = [
        brief ? `[交接简报 — 来自「${from}」上下文]\n${brief}` : `[从「${from}」上下文切换过来，无历史简报]`,
        note || "请确认收到交接，简单说说你接下来的理解和计划。",
      ];
      const targetBackend = this.opts.profiles.get(target)!;
      const targetKey = this.sessionKey(msg.chatKey, target);
      const result = await targetBackend.runTurn({
        prompt: seedParts.join("\n\n"),
        sessionId: this.opts.sessions.get(targetKey),
        abortSignal: abort.signal,
      });
      if (result.sessionId) this.opts.sessions.set(targetKey, result.sessionId);

      if (result.isError) {
        await this.reply(msg, `已切到「${target}」，但它的首轮出错了：${result.text || "未知错误"}`);
      } else {
        await this.reply(msg, `【已交接到「${target}」】\n${result.text.trim()}`);
      }
    } catch (err) {
      if (abort.signal.aborted) {
        await this.reply(msg, "交接已停止。");
      } else {
        log.error(`${msg.chatKey}: handoff failed: ${String(err)}`);
        await this.reply(msg, "交接失败，上下文没有切换。");
      }
    } finally {
      void this.channel.setTyping(msg.from, false).catch(() => {});
      state.running = false;
      state.abort = undefined;
      const next = state.queue.shift();
      if (next) void this.runLoop(next, state);
    }
  }

  private async reply(msg: InboundMessage, text: string): Promise<void> {
    const plain = markdownToPlainText(text);
    for (const chunk of chunkText(plain)) {
      try {
        await this.channel.sendText(msg.from, chunk);
      } catch (err) {
        log.error(`${msg.chatKey}: send failed: ${String(err)}`);
        return;
      }
    }
  }
}
