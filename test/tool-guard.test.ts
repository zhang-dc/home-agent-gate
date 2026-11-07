import { describe, expect, it } from "vitest";

import { makeIsolatedToolGuard, privateUrlReason } from "../src/backends/tool-guard.js";

const opts = { signal: new AbortController().signal, suggestions: [], toolUseID: "t1" } as never;

describe("privateUrlReason", () => {
  it.each([
    "http://127.0.0.1:18790/api/state",
    "http://localhost:3000",
    "http://foo.localhost/",
    "http://10.1.2.3/",
    "http://172.16.5.4/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://100.64.0.1/",
    "http://0.0.0.0/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[fd00::1]/",
    "http://2130706433/",
    "http://0x7f000001/",
    "http://router/",
    "http://nas.lan/",
    "http://printer.local/",
    "file:///etc/passwd",
    "not a url",
  ])("refuses %s", (url) => {
    expect(privateUrlReason(url)).not.toBeNull();
  });

  it.each(["https://example.com/", "http://93.184.216.34/", "https://news.ycombinator.com/item?id=1"])(
    "allows %s",
    (url) => {
      expect(privateUrlReason(url)).toBeNull();
    },
  );
});

describe("makeIsolatedToolGuard", () => {
  const guard = makeIsolatedToolGuard(["WebSearch", "WebFetch"]);

  it("denies tools not on the allowlist", async () => {
    const r = await guard("Bash", { command: "whoami" }, opts);
    expect(r?.behavior).toBe("deny");
  });

  it("denies WebFetch to internal addresses", async () => {
    const r = await guard("WebFetch", { url: "http://127.0.0.1:18790/api/action", prompt: "x" }, opts);
    expect(r?.behavior).toBe("deny");
  });

  it("allows WebFetch to public addresses", async () => {
    const input = { url: "https://example.com/", prompt: "x" };
    const r = await guard("WebFetch", input, opts);
    expect(r).toEqual({ behavior: "allow", updatedInput: input });
  });

  it("allows other allowlisted tools", async () => {
    const r = await guard("WebSearch", { query: "weather" }, opts);
    expect(r?.behavior).toBe("allow");
  });
});
