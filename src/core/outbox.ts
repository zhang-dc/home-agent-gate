/**
 * Shared helper for channels that cannot always push (WeChat send window,
 * QQ proactive-message limits): undeliverable texts are queued per user and
 * flushed, merged, on the user's next inbound message.
 */

export interface OutboxEntry {
  text: string;
  queuedAtMs: number;
}

/** Per-user cap: enough to hold a few days of scheduled pushes, not unbounded. */
export const MAX_OUTBOX_PER_USER = 30;

/** Max chars of one merged message; matches chunkText's default. */
const MERGED_MAX_CHARS = 3500;

/** MM-DD HH:mm in local time. */
function stamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Merge queued entries into as few messages as possible, in original order,
 * each prefixed with "[延迟推送 MM-DD HH:mm]" so a day-old push does not read
 * as fresh news. An entry that alone exceeds the limit gets its own batch
 * (the channel chunks it further when sending).
 *
 * Why merge: one WeChat context_token only allows a limited number of sends;
 * flushing a backlog one entry at a time runs out halfway and leaves the rest
 * stuck in the queue.
 */
export function mergeOutbox(queue: OutboxEntry[], maxChars = MERGED_MAX_CHARS): string[] {
  const batches: string[] = [];
  let cur = "";
  for (const entry of queue) {
    const block = `[延迟推送 ${stamp(entry.queuedAtMs)}]\n${entry.text}`;
    if (!cur) {
      cur = block;
    } else if (cur.length + block.length + 2 <= maxChars) {
      cur += `\n\n${block}`;
    } else {
      batches.push(cur);
      cur = block;
    }
  }
  if (cur) batches.push(cur);
  return batches;
}
