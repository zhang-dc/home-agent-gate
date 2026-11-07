/**
 * Channel-agnostic message envelopes.
 * Channels normalize inbound platform messages into InboundMessage;
 * the dispatcher hands replies back to the channel for delivery.
 */

export interface InboundMessage {
  /**
   * Stable identity of the conversation: "<channel>:<accountId>:<userId>",
   * e.g. "weixin:mybot:<userId>". The panel relies on this shape to recover
   * the user id (everything after the second colon).
   */
  chatKey: string;
  /** Platform user id of the sender (replies are sent to this id). */
  from: string;
  /** Plain-text body (voice messages arrive as their transcript). */
  text: string;
  /** Local path of a downloaded+decrypted inbound image, when present. */
  imagePath?: string;
  /** Epoch ms when the platform created the message. */
  timestampMs?: number;
}

/** Runtime health snapshot shown by the admin panel. */
export interface ChannelStatus {
  id: string;
  accountId: string;
  /** Allowed senders; empty = anyone. Free-form labels are fine. */
  allowFrom: string[];
  startedAtMs: number;
  /** Last time the channel proved it is alive (poll ok / socket ready / server listening). */
  lastPollOkAtMs: number;
  lastInboundAtMs: number;
  inboundCount: number;
  lastErrorAtMs: number;
  lastError: string;
  [extra: string]: unknown;
}

/** A channel connects one platform account and delivers replies. */
export interface Channel {
  readonly id: string;
  start(onMessage: (msg: InboundMessage) => void): Promise<void>;
  stop(): Promise<void>;
  sendText(to: string, text: string): Promise<void>;
  /** Best-effort typing indicator; channels without one may no-op. */
  setTyping(to: string, typing: boolean): Promise<void>;
  status(): ChannelStatus;
}
