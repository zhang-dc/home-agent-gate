import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EchoBackend } from "../src/backends/echo.js";
import { LocalChannel } from "../src/channels/local/channel.js";
import { Dispatcher } from "../src/core/dispatcher.js";
import { KVFile } from "../src/core/kv-store.js";
import { SessionStore } from "../src/core/session-store.js";
import { tmpDir } from "./helpers.js";

let channel: LocalChannel | undefined;

afterEach(async () => {
  await channel?.stop();
  channel = undefined;
});

async function startLocal() {
  const dir = tmpDir();
  channel = new LocalChannel({ accountId: "t", stdin: false, http: { bind: "127.0.0.1", port: 0, timeoutSeconds: 5 } });
  const dispatcher = new Dispatcher(channel, {
    profiles: new Map([["echo", new EchoBackend()]]),
    defaultProfile: "echo",
    sessions: new SessionStore(path.join(dir, "s.json"), 0),
    activeProfiles: new KVFile(path.join(dir, "a.json")),
  });
  await channel.start(dispatcher.handleInbound);
  const base = `http://127.0.0.1:${channel.httpPort}`;
  const chat = async (body: unknown) => {
    const r = await fetch(`${base}/chat`, { method: "POST", body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as { replies?: string[]; error?: string } };
  };
  return { chat };
}

describe("LocalChannel HTTP", () => {
  it("POST /chat returns the reply and keeps the session per user", async () => {
    const { chat } = await startLocal();
    expect((await chat({ text: "hello", user: "alice" })).body.replies).toEqual(["[echo #1] hello"]);
    expect((await chat({ text: "again", user: "alice" })).body.replies).toEqual(["[echo #2] again"]);
    expect((await chat({ text: "hi", user: "bob" })).body.replies).toEqual(["[echo #1] hi"]);
  });

  it("commands work over HTTP", async () => {
    const { chat } = await startLocal();
    const r = await chat({ text: "/status" });
    expect(r.body.replies?.[0]).toContain("上下文: echo");
  });

  it("rejects an empty message", async () => {
    const { chat } = await startLocal();
    expect((await chat({ text: "  " })).status).toBe(400);
  });
});
