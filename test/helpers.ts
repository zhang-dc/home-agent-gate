import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ReasoningBackend, TurnRequest, TurnResult } from "../src/core/backend.js";
import type { Channel, ChannelStatus, InboundMessage } from "../src/core/envelope.js";
import { Dispatcher } from "../src/core/dispatcher.js";
import { KVFile } from "../src/core/kv-store.js";
import { SessionStore } from "../src/core/session-store.js";

export function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "home-agent-gate-test-"));
}

/**
 * Backend whose turns stay pending until the test releases them, so queueing
 * behaviour can be observed. Every call is recorded.
 */
export class FakeBackend implements ReasoningBackend {
  calls: TurnRequest[] = [];
  private pending: Array<(r: TurnResult) => void> = [];
  private counter = 0;
  /** When true, turns resolve immediately with `reply`. */
  auto = false;

  constructor(
    readonly id = "fake",
    private reply: (req: TurnRequest) => string = (req) => `reply:${req.prompt}`,
  ) {}

  runTurn(req: TurnRequest): Promise<TurnResult> {
    this.calls.push(req);
    const sessionId = req.sessionId ?? `${this.id}-s${++this.counter}`;
    const result: TurnResult = { text: this.reply(req), sessionId, isError: false };
    if (this.auto) return Promise.resolve(result);
    return new Promise((resolve, reject) => {
      req.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      this.pending.push(() => resolve(result));
    });
  }

  /** Resolve the oldest pending turn. */
  release(): void {
    const next = this.pending.shift();
    if (!next) throw new Error("no pending turn");
    next(undefined as unknown as TurnResult);
  }

  get pendingCount(): number {
    return this.pending.length;
  }
}

export class FakeChannel implements Channel {
  readonly id = "fake:test";
  sent: Array<{ to: string; text: string }> = [];
  typing: Array<{ to: string; typing: boolean }> = [];
  onMessage?: (msg: InboundMessage) => void;

  async start(onMessage: (msg: InboundMessage) => void): Promise<void> {
    this.onMessage = onMessage;
  }
  async stop(): Promise<void> {}
  async sendText(to: string, text: string): Promise<void> {
    this.sent.push({ to, text });
  }
  async setTyping(to: string, typing: boolean): Promise<void> {
    this.typing.push({ to, typing });
  }
  status(): ChannelStatus {
    return {
      id: this.id,
      accountId: "test",
      allowFrom: [],
      startedAtMs: 0,
      lastPollOkAtMs: 0,
      lastInboundAtMs: 0,
      inboundCount: 0,
      lastErrorAtMs: 0,
      lastError: "",
    };
  }
  texts(): string[] {
    return this.sent.map((s) => s.text);
  }
}

export function makeDispatcher(backends: Record<string, ReasoningBackend>, defaultProfile?: string) {
  const dir = tmpDir();
  const channel = new FakeChannel();
  const sessions = new SessionStore(path.join(dir, "sessions.json"), 0);
  const activeProfiles = new KVFile(path.join(dir, "active.json"));
  const dispatcher = new Dispatcher(channel, {
    profiles: new Map(Object.entries(backends)),
    defaultProfile: defaultProfile ?? Object.keys(backends)[0]!,
    sessions,
    activeProfiles,
  });
  return { dispatcher, channel, sessions, activeProfiles, dir };
}

export const CHAT = "fake:test:alice";

export function msg(text: string, chatKey = CHAT): InboundMessage {
  return { chatKey, from: chatKey.split(":").slice(2).join(":"), text };
}
