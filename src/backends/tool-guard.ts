import net from "node:net";

import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";

/**
 * Tool guard for isolated profiles. Anyone can message a public bot, so:
 *  1. only tools on the allowlist are permitted (belt and braces: the SDK's
 *     `tools` option already exposes nothing else);
 *  2. WebFetch runs ON THIS MACHINE. Unguarded, one message from a stranger
 *     could make it read loopback / LAN services that have no auth of their
 *     own — the admin panel on 127.0.0.1, a router page, cloud metadata on
 *     169.254.169.254, other local agents.
 *
 * Decisions are made on the URL text only (IP literals, localhost, dotless
 * hostnames, private suffixes). Resolving DNS is not used on purpose: behind a
 * fake-ip proxy every domain resolves into 198.18.0.0/15, which would block
 * everything. The residual risk is a public name resolving to a private IP
 * (DNS rebinding); accepted.
 */
export function makeIsolatedToolGuard(allowed: string[]): CanUseTool {
  const allow = new Set(allowed);
  return async (toolName, input) => {
    if (!allow.has(toolName)) {
      return { behavior: "deny", message: `工具 ${toolName} 在这个助手里不可用。` };
    }
    if (toolName === "WebFetch") {
      const reason = privateUrlReason(String(input.url ?? ""));
      if (reason) return { behavior: "deny", message: `不能访问这个地址（${reason}），只能访问公网网页。` };
    }
    return { behavior: "allow", updatedInput: input };
  };
}

/** Returns why a URL is refused; null for a public http(s) URL. */
export function privateUrlReason(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "不是合法的 URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return `不支持 ${url.protocol} 协议`;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) return "缺少主机名";
  if (host === "localhost" || host.endsWith(".localhost")) return "本机地址";
  if (/\.(local|lan|internal|intranet|home|corp)$/.test(host)) return "内网域名";
  const ipKind = net.isIP(host);
  if (ipKind === 4) return isPrivateV4(host) ? "内网 / 保留 IP" : null;
  if (ipKind === 6) return isPrivateV6(host) ? "内网 / 保留 IP" : null;
  // A dotless hostname can only be a LAN machine; numeric / hex IP spellings
  // (2130706433, 0x7f000001) are refused too.
  if (!host.includes(".")) return "内网主机名";
  if (/^[0-9.]+$/.test(host) || /^0x/i.test(host)) return "非常规 IP 写法";
  return null;
}

function isPrivateV4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT / overlay VPNs
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking range, used by fake-ip proxies
    a >= 224
  );
}

function isPrivateV6(ip: string): boolean {
  if (ip === "::" || ip === "::1") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return isPrivateV4(mapped[1]!);
  // WHATWG URL normalizes [::ffff:127.0.0.1] to ::ffff:7f00:1
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1]!, 16);
    const lo = parseInt(hexMapped[2]!, 16);
    return isPrivateV4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }
  return /^(fc|fd|fe8|fe9|fea|feb)/i.test(ip);
}
