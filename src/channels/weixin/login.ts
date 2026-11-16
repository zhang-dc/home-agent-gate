/**
 * Weixin ilink bot QR login — the same HTTP protocol the official
 * @tencent-weixin/openclaw-weixin plugin (MIT) uses, re-implemented here so
 * Home Agent Gate does not depend on openclaw:
 *
 *   1. POST ilink/bot/get_bot_qrcode?bot_type=3  {local_token_list}
 *        -> { qrcode, qrcode_img_content }   (img_content is a URL; render it as a QR code)
 *   2. GET  ilink/bot/get_qrcode_status?qrcode=...[&verify_code=...]   (long poll, ~35 s)
 *        -> { status, bot_token, ilink_bot_id, baseurl, ilink_user_id, redirect_host }
 *      status: wait | scaned | need_verifycode | verify_code_blocked | expired
 *              | scaned_but_redirect (switch polling host) | binded_redirect (already bound) | confirmed
 */
import { ilinkCommonHeaders, ilinkPostHeaders } from "./api.js";

export const LOGIN_BASE_URL = "https://ilinkai.weixin.qq.com";
export const DEFAULT_BOT_TYPE = "3";
const QR_LONG_POLL_TIMEOUT_MS = 35_000;

export type QrStatus =
  | "wait"
  | "scaned"
  | "confirmed"
  | "expired"
  | "scaned_but_redirect"
  | "need_verifycode"
  | "verify_code_blocked"
  | "binded_redirect";

export interface QrCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

export interface QrStatusResponse {
  status: QrStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}

function url(base: string, endpoint: string): string {
  return new URL(endpoint, base.endsWith("/") ? base : `${base}/`).toString();
}

/**
 * Ask for a login QR code. `localTokens` are tokens already held for this
 * bot; passing them lets the server answer binded_redirect instead of
 * issuing a second token for an already-bound bot.
 */
export async function fetchQrCode(
  opts: { baseUrl?: string; botType?: string; localTokens?: string[] } = {},
): Promise<QrCodeResponse> {
  const endpoint = `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(opts.botType ?? DEFAULT_BOT_TYPE)}`;
  const res = await fetch(url(opts.baseUrl ?? LOGIN_BASE_URL, endpoint), {
    method: "POST",
    headers: ilinkPostHeaders(),
    body: JSON.stringify({ local_token_list: opts.localTokens ?? [] }),
    signal: AbortSignal.timeout(15_000),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`get_bot_qrcode ${res.status}: ${raw.slice(0, 300)}`);
  const body = JSON.parse(raw) as Partial<QrCodeResponse>;
  if (!body.qrcode || !body.qrcode_img_content) {
    throw new Error(`get_bot_qrcode: unexpected response ${raw.slice(0, 300)}`);
  }
  return body as QrCodeResponse;
}

/** One long poll. Timeouts and transient network / gateway errors read as "wait". */
export async function pollQrStatus(baseUrl: string, qrcode: string, verifyCode?: string): Promise<QrStatusResponse> {
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
  try {
    const res = await fetch(url(baseUrl, endpoint), {
      method: "GET",
      headers: ilinkCommonHeaders(),
      signal: AbortSignal.timeout(QR_LONG_POLL_TIMEOUT_MS),
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`get_qrcode_status ${res.status}: ${raw.slice(0, 300)}`);
    return JSON.parse(raw) as QrStatusResponse;
  } catch {
    return { status: "wait" };
  }
}

export interface LoginResult {
  token: string;
  baseUrl: string;
  userId?: string;
  botId: string;
}

export interface LoginHooks {
  showQr(qrUrl: string): void | Promise<void>;
  /** Called when the phone shows a number that must be typed in. */
  askVerifyCode(retry: boolean): Promise<string>;
  info(msg: string): void;
}

const MAX_QR_REFRESH = 3;

/**
 * Full login loop. Resolves with credentials on success, with "already-bound"
 * when the server says the scanned bot is already bound to one of
 * `localTokens` (that token stays valid), and rejects on failure / timeout.
 */
export async function loginWithQr(
  hooks: LoginHooks,
  opts: { localTokens?: string[]; timeoutMs?: number; botType?: string } = {},
): Promise<LoginResult | "already-bound"> {
  const botType = opts.botType ?? DEFAULT_BOT_TYPE;
  let qr = await fetchQrCode({ botType, localTokens: opts.localTokens });
  await hooks.showQr(qr.qrcode_img_content);

  const deadline = Date.now() + (opts.timeoutMs ?? 480_000);
  let pollBase = LOGIN_BASE_URL;
  let refreshes = 1;
  let verifyCode: string | undefined;
  let scannedShown = false;

  const refresh = async (why: string) => {
    refreshes++;
    if (refreshes > MAX_QR_REFRESH) throw new Error(`${why}, gave up after ${MAX_QR_REFRESH} QR codes`);
    hooks.info(`${why}, fetching a new QR code (${refreshes}/${MAX_QR_REFRESH})...`);
    qr = await fetchQrCode({ botType, localTokens: opts.localTokens });
    pollBase = LOGIN_BASE_URL;
    scannedShown = false;
    await hooks.showQr(qr.qrcode_img_content);
  };

  while (Date.now() < deadline) {
    const st = await pollQrStatus(pollBase, qr.qrcode, verifyCode);
    switch (st.status) {
      case "wait":
        break;
      case "scaned":
        verifyCode = undefined;
        if (!scannedShown) hooks.info("Scanned, confirm on the phone...");
        scannedShown = true;
        break;
      case "need_verifycode":
        verifyCode = await hooks.askVerifyCode(verifyCode !== undefined);
        continue;
      case "verify_code_blocked":
        verifyCode = undefined;
        await refresh("Too many wrong codes");
        break;
      case "expired":
        await refresh("QR code expired");
        break;
      case "scaned_but_redirect":
        if (st.redirect_host) pollBase = `https://${st.redirect_host}`;
        break;
      case "binded_redirect":
        return "already-bound";
      case "confirmed":
        if (!st.bot_token || !st.ilink_bot_id) throw new Error("login confirmed but bot_token / ilink_bot_id missing");
        return {
          token: st.bot_token,
          baseUrl: st.baseurl || LOGIN_BASE_URL,
          botId: st.ilink_bot_id,
          ...(st.ilink_user_id ? { userId: st.ilink_user_id } : {}),
        };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("login timed out");
}
