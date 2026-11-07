import fs from "node:fs";
import path from "node:path";

interface SessionEntry {
  sessionId: string;
  updatedAtMs: number;
}

/**
 * Maps chatKey -> harness session id, persisted as one JSON file so
 * conversations survive gateway restarts. Sessions older than
 * `idleResetMinutes` are treated as expired and a fresh session starts.
 */
export class SessionStore {
  private entries = new Map<string, SessionEntry>();

  constructor(
    private filePath: string,
    private idleResetMinutes: number,
  ) {
    try {
      if (fs.existsSync(filePath)) {
        const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, SessionEntry>;
        for (const [k, v] of Object.entries(raw)) {
          if (v && typeof v.sessionId === "string") this.entries.set(k, v);
        }
      }
    } catch {
      // Corrupt store — start empty; sessions are recoverable convenience state.
    }
  }

  get(chatKey: string): string | undefined {
    const entry = this.entries.get(chatKey);
    if (!entry) return undefined;
    if (this.idleResetMinutes > 0) {
      const ageMinutes = (Date.now() - entry.updatedAtMs) / 60_000;
      if (ageMinutes > this.idleResetMinutes) return undefined;
    }
    return entry.sessionId;
  }

  set(chatKey: string, sessionId: string): void {
    this.entries.set(chatKey, { sessionId, updatedAtMs: Date.now() });
    this.persist();
  }

  reset(chatKey: string): void {
    this.entries.delete(chatKey);
    this.persist();
  }

  /** All stored entries (including idle-expired ones), for the panel. */
  snapshot(): Array<{ key: string; sessionId: string; updatedAtMs: number }> {
    return [...this.entries.entries()].map(([key, v]) => ({ key, ...v }));
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(Object.fromEntries(this.entries), null, 2), "utf-8");
  }
}
