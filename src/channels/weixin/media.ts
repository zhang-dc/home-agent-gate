import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { createLogger } from "../../util/logger.js";
import type { ImageItem } from "./types.js";

const log = createLogger("weixin-media");

export const DEFAULT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const MAX_MEDIA_BYTES = 100 * 1024 * 1024;

/** Decrypt buffer with AES-128-ECB (PKCS7 padding). */
function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Parse CDNMedia.aes_key (base64) into a raw 16-byte AES key. Two encodings
 * are seen in the wild: base64(raw 16 bytes) and base64(32-char hex string).
 */
function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new Error(`aes_key must decode to 16 raw bytes or 32-char hex, got ${decoded.length} bytes`);
}

async function fetchCdnBytes(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) {
    throw new Error(`CDN download ${res.status} ${res.statusText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_MEDIA_BYTES) throw new Error(`media too large: ${buf.length} bytes`);
  return buf;
}

function buildCdnDownloadUrl(encryptedQueryParam: string, cdnBaseUrl: string): string {
  return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

/** Sniff image extension from magic bytes; WeChat photos are usually JPEG. */
function sniffImageExt(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8) return "jpg";
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf.length >= 3 && buf.subarray(0, 3).toString("ascii") === "GIF") return "gif";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  return "jpg";
}

/**
 * Download an inbound image (decrypting when an AES key is present) and
 * save it under destDir. Returns the saved file's absolute path.
 */
export async function downloadImageToFile(
  img: ImageItem,
  cdnBaseUrl: string,
  destDir: string,
): Promise<string> {
  const media = img.media;
  if (!media?.encrypt_query_param && !media?.full_url) {
    throw new Error("image has no media reference");
  }
  const url = media.full_url ?? buildCdnDownloadUrl(media.encrypt_query_param ?? "", cdnBaseUrl);
  const raw = await fetchCdnBytes(url);

  // image_item.aeskey is a hex string of the raw key; media.aes_key is base64.
  const aesKeyBase64 = img.aeskey ? Buffer.from(img.aeskey, "hex").toString("base64") : media.aes_key;
  const bytes = aesKeyBase64 ? decryptAesEcb(raw, parseAesKey(aesKeyBase64)) : raw;

  const ext = sniffImageExt(bytes);
  const filePath = path.join(destDir, `inbound-${Date.now()}-${crypto.randomBytes(3).toString("hex")}.${ext}`);
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(filePath, bytes);
  log.info(`image saved: ${filePath} (${bytes.length} bytes, ${aesKeyBase64 ? "decrypted" : "plain"})`);
  return filePath;
}
