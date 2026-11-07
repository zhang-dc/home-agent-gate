/**
 * A reasoning backend runs one conversational turn inside a harness
 * (Claude Code via Agent SDK, Codex via `codex exec`, ...). Context
 * management (compaction, memory, CLAUDE.md, skills) is the harness's
 * job — the gateway only tracks the opaque session id for continuity.
 */

export interface TurnRequest {
  prompt: string;
  /** Local image files attached to this turn (paths also referenced in prompt). */
  images?: string[];
  /** Harness session to resume; undefined starts a fresh session. */
  sessionId?: string;
  abortSignal?: AbortSignal;
}

export interface TurnResult {
  text: string;
  /** Session id to persist for the next turn (may equal the input one). */
  sessionId?: string;
  isError: boolean;
  costUsd?: number;
  numTurns?: number;
}

export interface ReasoningBackend {
  readonly id: string;
  runTurn(req: TurnRequest): Promise<TurnResult>;
}
