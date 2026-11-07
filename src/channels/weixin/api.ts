import crypto from "node:crypto";

import { createLogger } from "../../util/logger.js";
import type { BaseInfo, GetConfigResp, GetUpdatesResp, SendMessageReq } from "./types.js";

const log = createLogger("weixin-api");

/**
 * The server identifies channel clients via iLink headers. We mirror the
 * official openclaw-weixin channel build (ilink_appid "bot", version 2.4.4)
 * since bot tokens were issued against that channel contract.
 */
const ILINK_APP_ID = "bot";
const CHANNEL_VERSION = "2.4.4";
const BOT_AGENT = "agentgate/0.1";

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_API_TIMEOUT_MS = 15_000;
const DEFAULT_CONFIG_TIMEOUT_MS = 10_000;

/** iLink-App-ClientVersion: uint32 0x00MMNNPP from "M.N.P". */
function buildClientVersion(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map((p) => parseInt(p, 10));
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

function baseInfo(): BaseInfo {
  return { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT };
}

/** X-WECHAT-UIN header: random uint32 -> decimal string -> base64. */
function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

/** Headers every iLink request carries (GET requests send only these). */
export function ilinkCommonHeaders(): Record<string, string> {
  return {
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": String(buildClientVersion(CHANNEL_VERSION)),
  };
}

/** Headers for JSON POSTs; the bot token is omitted during QR login. */
export function ilinkPostHeaders(token?: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    "X-WECHAT-UIN": randomWechatUin(),
    ...ilinkCommonHeaders(),
  };
}

export interface WeixinApiClientOptions {
  baseUrl: string;
  token: string;
}

/**
 * The API answers HTTP 200 and puts the real verdict in the body, so a send can
 * fail while looking perfectly healthy. Every write path parses the body and
 * throws this instead — 2026-09-16 we found five scheduled pushes "delivered ok"
 * in the log that the server had actually rejected with ret=-2.
 */
export class WeixinApiError extends Error {
  constructor(
    message: string,
    readonly ret?: number,
    readonly errcode?: number,
  ) {
    super(message);
    this.name = "WeixinApiError";
  }
}

/** ret=-2 "prepare failed": no usable context_token, i.e. the send window is closed. */
export const PREPARE_FAILED_RET = -2;

function assertBodyOk(label: string, rawText: string): void {
  let body: { ret?: number; errcode?: number; errmsg?: string };
  try {
    body = JSON.parse(rawText) as typeof body;
  } catch {
    return; // Non-JSON success bodies exist; nothing to verify.
  }
  const ret = body.ret ?? 0;
  const errcode = body.errcode ?? 0;
  if (ret === 0 && errcode === 0) return;
  throw new WeixinApiError(
    `${label} rejected: ret=${ret} errcode=${errcode} errmsg=${body.errmsg ?? ""}`,
    ret,
    errcode,
  );
}

export class WeixinApiClient {
  private baseUrl: string;

  constructor(private opts: WeixinApiClientOptions) {
    this.baseUrl = opts.baseUrl.endsWith("/") ? opts.baseUrl : `${opts.baseUrl}/`;
  }

  private headers(): Record<string, string> {
    return ilinkPostHeaders(this.opts.token);
  }

  private async post(params: {
    endpoint: string;
    body: unknown;
    timeoutMs: number;
    label: string;
    abortSignal?: AbortSignal;
  }): Promise<string> {
    const url = new URL(params.endpoint, this.baseUrl);
    const signal =
      params.abortSignal != null
        ? AbortSignal.any([params.abortSignal, AbortSignal.timeout(params.timeoutMs)])
        : AbortSignal.timeout(params.timeoutMs);
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(params.body),
      signal,
    });
    const rawText = await res.text();
    if (!res.ok) {
      throw new Error(`${params.label} ${res.status}: ${rawText.slice(0, 500)}`);
    }
    return rawText;
  }

  /**
   * Long-poll for new messages. A client-side timeout or an external abort
   * returns an empty response (ret=0) so the caller can just loop.
   */
  async getUpdates(params: {
    getUpdatesBuf: string;
    timeoutMs?: number;
    abortSignal?: AbortSignal;
  }): Promise<GetUpdatesResp> {
    const timeoutMs = params.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
    try {
      const rawText = await this.post({
        endpoint: "ilink/bot/getupdates",
        body: { get_updates_buf: params.getUpdatesBuf, base_info: baseInfo() },
        timeoutMs,
        label: "getUpdates",
        abortSignal: params.abortSignal,
      });
      return JSON.parse(rawText) as GetUpdatesResp;
    } catch (err) {
      if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
        log.debug(`getUpdates: ${params.abortSignal?.aborted ? "aborted" : "long-poll timeout"}`);
        return { ret: 0, msgs: [], get_updates_buf: params.getUpdatesBuf };
      }
      throw err;
    }
  }

  async sendMessage(body: SendMessageReq): Promise<void> {
    const raw = await this.post({
      endpoint: "ilink/bot/sendmessage",
      body: { ...body, base_info: baseInfo() },
      timeoutMs: DEFAULT_API_TIMEOUT_MS,
      label: "sendMessage",
    });
    assertBodyOk("sendMessage", raw);
  }

  async getConfig(params: { ilinkUserId: string; contextToken?: string }): Promise<GetConfigResp> {
    const rawText = await this.post({
      endpoint: "ilink/bot/getconfig",
      body: {
        ilink_user_id: params.ilinkUserId,
        context_token: params.contextToken,
        base_info: baseInfo(),
      },
      timeoutMs: DEFAULT_CONFIG_TIMEOUT_MS,
      label: "getConfig",
    });
    return JSON.parse(rawText) as GetConfigResp;
  }

  async sendTyping(params: { ilinkUserId: string; typingTicket: string; status: number }): Promise<void> {
    await this.post({
      endpoint: "ilink/bot/sendtyping",
      body: {
        ilink_user_id: params.ilinkUserId,
        typing_ticket: params.typingTicket,
        status: params.status,
        base_info: baseInfo(),
      },
      timeoutMs: DEFAULT_CONFIG_TIMEOUT_MS,
      label: "sendTyping",
    });
  }

  async notifyStart(): Promise<void> {
    const raw = await this.post({
      endpoint: "ilink/bot/msg/notifystart",
      body: { base_info: baseInfo() },
      timeoutMs: DEFAULT_CONFIG_TIMEOUT_MS,
      label: "notifyStart",
    });
    assertBodyOk("notifyStart", raw);
  }

  async notifyStop(): Promise<void> {
    await this.post({
      endpoint: "ilink/bot/msg/notifystop",
      body: { base_info: baseInfo() },
      timeoutMs: DEFAULT_CONFIG_TIMEOUT_MS,
      label: "notifyStop",
    });
  }
}
