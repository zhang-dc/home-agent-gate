import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { KVFile } from "../src/core/kv-store.js";
import { SessionStore } from "../src/core/session-store.js";
import { tmpDir } from "./helpers.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("SessionStore", () => {
  it("persists sessions across instances", () => {
    const file = path.join(tmpDir(), "nested", "sessions.json");
    const a = new SessionStore(file, 0);
    a.set("chat#p", "s1");
    a.set("chat#q", "s2");
    a.reset("chat#q");

    const b = new SessionStore(file, 0);
    expect(b.get("chat#p")).toBe("s1");
    expect(b.get("chat#q")).toBeUndefined();
    expect(b.snapshot().map((e) => e.key)).toEqual(["chat#p"]);
  });

  it("expires idle sessions but keeps them in the snapshot", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const store = new SessionStore(path.join(tmpDir(), "s.json"), 30);
    store.set("chat#p", "s1");
    vi.setSystemTime(new Date("2030-01-01T00:29:00Z"));
    expect(store.get("chat#p")).toBe("s1");
    vi.setSystemTime(new Date("2030-01-01T00:31:00Z"));
    expect(store.get("chat#p")).toBeUndefined();
    expect(store.snapshot()).toHaveLength(1);
  });

  it("starts empty on a corrupt file", async () => {
    const file = path.join(tmpDir(), "bad.json");
    (await import("node:fs")).writeFileSync(file, "{not json");
    expect(new SessionStore(file, 0).snapshot()).toEqual([]);
  });
});

describe("KVFile", () => {
  it("persists string values", () => {
    const file = path.join(tmpDir(), "kv.json");
    new KVFile(file).set("chat", "codex");
    expect(new KVFile(file).get("chat")).toBe("codex");
  });
});
