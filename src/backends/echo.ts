import crypto from "node:crypto";

import type { ReasoningBackend, TurnRequest, TurnResult } from "../core/backend.js";

/**
 * Zero-dependency demo backend: repeats the prompt and counts turns per
 * session. Lets you try the whole gateway (queueing, /ctx, /new, /handoff,
 * panel) without any model credentials.
 */
export class EchoBackend implements ReasoningBackend {
  readonly id = "echo";
  private turns = new Map<string, number>();

  async runTurn(req: TurnRequest): Promise<TurnResult> {
    const sessionId = req.sessionId ?? `echo-${crypto.randomUUID()}`;
    const n = (this.turns.get(sessionId) ?? 0) + 1;
    this.turns.set(sessionId, n);
    return { text: `[echo #${n}] ${req.prompt}`, sessionId, isError: false, numTurns: 1 };
  }
}
