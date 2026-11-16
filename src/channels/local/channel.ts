import http from "node:http";
import readline from "node:readline";

import type { Channel, ChannelStatus, InboundMessage } from "../../core/envelope.js";
import { createLogger } from "../../util/logger.js";

/** Reply collection ends after this much quiet time with no turn running. */
const QUIET_MS = 400;
const STDIN_USER = "console";

export interface LocalChannelConfig {
  accountId: string;
  /** Read lines from the terminal (only when stdin is a TTY). */
  stdin: boolean;
  http?: { bind: string; port: number; timeoutSeconds: number };
}

interface Waiter {
  texts: string[];
  resolve: (texts: string[]) => void;
  timer?: NodeJS.Timeout;
}

/**
 * Local demo channel — needs no platform account.
 *
 *  - stdin: type a line, get the reply printed. Commands (/ctx, /new, ...) work as on any channel.
 *  - HTTP:  POST /chat {"text": "...", "user": "alice"} -> {"replies": ["..."]}
 *           The request is held until the turn finishes (the reply arrives and
 *           the typing indicator goes off), or until timeoutSeconds.
 *
 * chatKey is "local:<accountId>:<user>" ("console" for stdin).
 */
export class LocalChannel implements Channel {
  readonly id: string;
  private log;
  private rl?: readline.Interface;
  private server?: http.Server;
  private onMessage?: (msg: InboundMessage) => void;
  private typing = new Map<string, boolean>();
  private waiters = new Map<string, Set<Waiter>>();
  private stats = { startedAtMs: 0, lastInboundAtMs: 0, inboundCount: 0, lastErrorAtMs: 0, lastError: "" };

  constructor(private cfg: LocalChannelConfig) {
    this.id = `local:${cfg.accountId}`;
    this.log = createLogger(this.id);
  }

  /** Bound HTTP port (useful when configured with port 0 in tests). */
  get httpPort(): number | undefined {
    const addr = this.server?.address();
    return addr && typeof addr === "object" ? addr.port : undefined;
  }

  async start(onMessage: (msg: InboundMessage) => void): Promise<void> {
    this.onMessage = onMessage;
    this.stats.startedAtMs = Date.now();

    if (this.cfg.http) {
      const { bind, port } = this.cfg.http;
      this.server = http.createServer((req, res) => {
        this.handleHttp(req, res).catch((err) => {
          this.noteError(err);
          if (!res.headersSent) json(res, 500, { error: String(err instanceof Error ? err.message : err) });
        });
      });
      await new Promise<void>((resolve, reject) => {
        this.server!.once("error", reject);
        this.server!.listen(port, bind, () => resolve());
      });
      this.log.info(`HTTP listening on http://${bind}:${this.httpPort}/chat`);
    }

    if (this.cfg.stdin && process.stdin.isTTY) {
      this.rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "you> " });
      this.rl.on("line", (line) => {
        const text = line.trim();
        if (text) this.receive(STDIN_USER, text);
        else this.rl?.prompt();
      });
      console.log("\nHome Agent Gate local channel ready. Type a message (try /ctx, /status, /new). Ctrl+C to quit.\n");
      this.rl.prompt();
    } else if (this.cfg.stdin) {
      this.log.info("stdin is not a TTY, terminal input disabled");
    }
  }

  async stop(): Promise<void> {
    this.rl?.close();
    for (const set of this.waiters.values()) for (const w of set) this.finish(w);
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  async sendText(to: string, text: string): Promise<void> {
    if (to === STDIN_USER && this.rl) {
      process.stdout.write(`\nbot> ${text.replace(/\n/g, "\n     ")}\n\n`);
      this.rl.prompt();
    }
    for (const w of this.waiters.get(to) ?? []) {
      w.texts.push(text);
      this.armQuietTimer(to, w);
    }
  }

  async setTyping(to: string, typing: boolean): Promise<void> {
    this.typing.set(to, typing);
    if (to === STDIN_USER && this.rl && typing) process.stdout.write("  (thinking...)\n");
    for (const w of this.waiters.get(to) ?? []) {
      if (typing) {
        clearTimeout(w.timer);
        w.timer = undefined;
      } else if (w.texts.length) {
        this.armQuietTimer(to, w);
      }
    }
  }

  status(): ChannelStatus {
    return {
      id: this.id,
      accountId: this.cfg.accountId,
      allowFrom: ["local"],
      lastPollOkAtMs: Date.now(),
      ...this.stats,
    };
  }

  // ------------------------------------------------------------------

  private receive(user: string, text: string): void {
    this.stats.inboundCount += 1;
    this.stats.lastInboundAtMs = Date.now();
    this.onMessage?.({ chatKey: `${this.id}:${user}`, from: user, text, timestampMs: Date.now() });
  }

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://local");
    if (req.method === "GET" && url.pathname === "/healthz") return json(res, 200, { ok: true });
    if (req.method !== "POST" || url.pathname !== "/chat") return json(res, 404, { error: "not found" });

    let body: { text?: unknown; user?: unknown };
    try {
      body = JSON.parse((await readBody(req, 256 * 1024)).toString("utf-8") || "{}") as typeof body;
    } catch {
      return json(res, 400, { error: "invalid JSON" });
    }
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const user = typeof body.user === "string" && /^[\w.-]{1,64}$/.test(body.user) ? body.user : "http";
    if (!text) return json(res, 400, { error: "text is required" });

    const replies = await new Promise<string[]>((resolve) => {
      const w: Waiter = { texts: [], resolve };
      const set = this.waiters.get(user) ?? new Set<Waiter>();
      set.add(w);
      this.waiters.set(user, set);
      const timeout = setTimeout(() => this.finish(w, user), (this.cfg.http?.timeoutSeconds ?? 600) * 1000);
      // Client went away before the reply: stop collecting for it.
      res.on("close", () => {
        if (!res.writableEnded) this.finish(w, user);
      });
      const done = w.resolve;
      w.resolve = (texts) => {
        clearTimeout(timeout);
        done(texts);
      };
      this.receive(user, text);
    });
    json(res, 200, { replies });
  }

  /** Finish once the reply has arrived and nothing has been running for QUIET_MS. */
  private armQuietTimer(user: string, w: Waiter): void {
    if (this.typing.get(user)) return;
    clearTimeout(w.timer);
    w.timer = setTimeout(() => this.finish(w, user), QUIET_MS);
  }

  private finish(w: Waiter, user?: string): void {
    clearTimeout(w.timer);
    if (user) this.waiters.get(user)?.delete(w);
    else for (const set of this.waiters.values()) set.delete(w);
    w.resolve(w.texts);
  }

  private noteError(e: unknown): void {
    this.stats.lastErrorAtMs = Date.now();
    this.stats.lastError = String(e instanceof Error ? e.message : e);
    this.log.warn(this.stats.lastError);
  }
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
