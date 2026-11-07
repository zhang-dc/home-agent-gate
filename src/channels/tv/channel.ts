import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import type { Channel, ChannelStatus, InboundMessage } from "../../core/envelope.js";
import { markdownToPlainText } from "../../core/render.js";
import { createLogger } from "../../util/logger.js";

/** Messages kept on screen and in the state file. */
const HISTORY_MAX = 60;
/** Max hold time of a long poll (the client's timeout should be longer). */
const LONG_POLL_MS = 25_000;
/** Recording cap: 16 kHz mono 16-bit is ~1.9 MB per minute. */
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

export interface TvChannelConfig {
  accountId: string;
  bind: string;
  port: number;
  /** The client's X-TV-Token header must equal this. */
  token: string;
  /** whisper.cpp `whisper-server` /inference URL; omit to disable /tv/asr. */
  asrUrl?: string;
  asrLanguage: string;
  /** User id of the single shared conversation. */
  chatId: string;
  stateDir: string;
}

interface ChatEntry {
  seq: number;
  role: "user" | "assistant";
  text: string;
  atMs: number;
}

/**
 * TV / kiosk channel: a custom big-screen client (e.g. a home-screen
 * launcher app on an Android TV box) talks to the agent over LAN HTTP.
 *
 * Unlike WeChat / QQ the client is not push-capable, so replies are kept in
 * memory (+ a state file) and fetched by long polling:
 *
 *   POST /tv/chat {text}                    send a message into the Dispatcher (same queueing / sessions / commands)
 *   POST /tv/reset                          "new conversation": clear history + start a fresh session
 *   GET  /tv/events?since=<seq>&typing=0|1  returns when there are messages newer than <seq> or the
 *                                           typing state differs from what the client has; holds up to 25 s
 *                                           -> { messages: ChatEntry[], typing: boolean, last: number }
 *   POST /tv/asr  (body: audio/wav)         forwarded to whisper.cpp, -> { text }
 *
 * Every request must carry the header X-TV-Token. The protocol is specific to
 * our own client app; write a client against the endpoints above.
 */
export class TvChannel implements Channel {
  readonly id: string;
  private log;
  private server?: http.Server;
  private onMessage?: (msg: InboundMessage) => void;
  private history: ChatEntry[] = [];
  private seq = 0;
  private typing = false;
  /** The /new triggered by /tv/reset replies with an ack; the cleared screen should not show it. */
  private swallowResetAck = false;
  private waiters = new Set<() => void>();
  private statePath: string;
  private stats = { startedAtMs: 0, lastInboundAtMs: 0, inboundCount: 0, lastErrorAtMs: 0, lastError: "", asrCount: 0 };

  constructor(private cfg: TvChannelConfig) {
    this.id = `tv:${cfg.accountId}`;
    this.log = createLogger(this.id);
    this.statePath = path.join(cfg.stateDir, `tv-${cfg.accountId}.json`);
    try {
      const saved = JSON.parse(fs.readFileSync(this.statePath, "utf-8")) as { history?: ChatEntry[] };
      this.history = saved.history ?? [];
      this.seq = this.history.at(-1)?.seq ?? 0;
    } catch {
      this.history = [];
    }
  }

  get httpPort(): number | undefined {
    const addr = this.server?.address();
    return addr && typeof addr === "object" ? addr.port : undefined;
  }

  async start(onMessage: (msg: InboundMessage) => void): Promise<void> {
    this.onMessage = onMessage;
    this.stats.startedAtMs = Date.now();
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        this.noteError(e);
        if (!res.headersSent) json(res, 500, { error: String(e instanceof Error ? e.message : e) });
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.cfg.port, this.cfg.bind, () => resolve());
    });
    this.log.info(`listening on ${this.cfg.bind}:${this.httpPort}`);
  }

  async stop(): Promise<void> {
    for (const w of this.waiters) w();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  async sendText(_to: string, text: string): Promise<void> {
    if (this.swallowResetAck) {
      this.swallowResetAck = false;
      return;
    }
    this.push("assistant", markdownToPlainText(text));
  }

  async setTyping(_to: string, typing: boolean): Promise<void> {
    if (this.typing === typing) return;
    this.typing = typing;
    this.wake();
  }

  status(): ChannelStatus {
    return {
      id: this.id,
      accountId: this.cfg.accountId,
      allowFrom: ["token"],
      ...this.stats,
      // The panel uses this as "channel alive": the HTTP server is listening.
      lastPollOkAtMs: this.server?.listening ? Date.now() : 0,
    };
  }

  // ------------------------------------------------------------------

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://tv");
    if (!this.authorized(req)) return json(res, 401, { error: "bad token" });
    const chatKey = `${this.id}:${this.cfg.chatId}`;

    if (req.method === "POST" && url.pathname === "/tv/chat") {
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString("utf-8") || "{}") as { text?: string };
      const text = (body.text ?? "").trim();
      if (!text) return json(res, 400, { error: "empty" });
      const entry = this.push("user", text);
      this.stats.inboundCount++;
      this.stats.lastInboundAtMs = Date.now();
      this.onMessage?.({ chatKey, from: this.cfg.chatId, text, timestampMs: Date.now() });
      return json(res, 200, { seq: entry.seq });
    }

    if (req.method === "POST" && url.pathname === "/tv/reset") {
      // Clear the on-screen history, then let the Dispatcher start a new session.
      this.history = [];
      this.persist();
      this.swallowResetAck = true;
      this.onMessage?.({ chatKey, from: this.cfg.chatId, text: "/new", timestampMs: Date.now() });
      return json(res, 200, { ok: true, seq: this.seq });
    }

    if (req.method === "GET" && url.pathname === "/tv/events") {
      const since = Number(url.searchParams.get("since") ?? 0);
      const typingSeen = url.searchParams.get("typing") === "1";
      const ready = () => this.seq > since || this.typing !== typingSeen;
      if (!ready()) {
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            this.waiters.delete(done);
            resolve();
          };
          const timer = setTimeout(done, LONG_POLL_MS);
          this.waiters.add(done);
          res.on("close", done);
        });
      }
      return json(res, 200, {
        messages: this.history.filter((m) => m.seq > since),
        typing: this.typing,
        last: this.seq,
      });
    }

    if (req.method === "POST" && url.pathname === "/tv/asr") {
      if (!this.cfg.asrUrl) return json(res, 501, { error: "asr not configured" });
      const audio = await readBody(req, MAX_AUDIO_BYTES);
      const text = await this.transcribe(audio);
      this.stats.asrCount++;
      return json(res, 200, { text });
    }

    return json(res, 404, { error: "not found" });
  }

  private authorized(req: http.IncomingMessage): boolean {
    const got = Buffer.from(String(req.headers["x-tv-token"] ?? ""));
    const want = Buffer.from(this.cfg.token);
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  }

  private push(role: ChatEntry["role"], text: string): ChatEntry {
    const entry: ChatEntry = { seq: ++this.seq, role, text, atMs: Date.now() };
    this.history.push(entry);
    if (this.history.length > HISTORY_MAX) this.history.splice(0, this.history.length - HISTORY_MAX);
    this.persist();
    this.wake();
    return entry;
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      fs.writeFileSync(this.statePath, JSON.stringify({ history: this.history }), "utf-8");
    } catch (e) {
      this.noteError(e);
    }
  }

  private wake(): void {
    for (const w of [...this.waiters]) w();
  }

  /** whisper-server /inference: multipart wav upload, response_format=json -> {text}. */
  private async transcribe(wav: Buffer): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "speech.wav");
    form.append("language", this.cfg.asrLanguage);
    form.append("response_format", "json");
    form.append("temperature", "0");
    const r = await fetch(this.cfg.asrUrl!, { method: "POST", body: form });
    if (!r.ok) throw new Error(`asr HTTP ${r.status}`);
    const out = (await r.json()) as { text?: string };
    // whisper breaks lines on pauses; show one utterance as one line.
    const text = (out.text ?? "").trim().replace(/\s*\n\s*/g, "，");
    return isHallucination(text) ? "" : text;
  }

  private noteError(e: unknown): void {
    this.stats.lastErrorAtMs = Date.now();
    this.stats.lastError = String(e instanceof Error ? e.message : e);
    this.log.warn(this.stats.lastError);
  }
}

/**
 * Whisper "hallucinations": on near-silent audio it emits subtitle credits
 * that are frequent in its training data. A whole utterance matching one of
 * these is treated as "nothing recognized".
 */
const HALLUCINATIONS = [
  /优优独播剧场/, /YoYo Television Series/i, /请不吝(点赞|订阅)/, /点赞.{0,4}订阅.{0,4}(转发|打赏)/, /明镜与点点/,
  /字幕(由|志愿者|组|制作)/, /^(谢谢|感谢)(大家|您)?(的)?(观看|收看|收听)[。！!]?$/, /^thank(s| you) for watching/i,
  /^(中文字幕|字幕|subtitles? by)/i, /^[\s。，、…\.!?！？]*$/,
];

export function isHallucination(text: string): boolean {
  return HALLUCINATIONS.some((re) => re.test(text));
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
