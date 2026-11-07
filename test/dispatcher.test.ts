import { describe, expect, it, vi } from "vitest";

import { HANDOFF_BRIEF_PROMPT } from "../src/core/dispatcher.js";
import { CHAT, FakeBackend, makeDispatcher, msg } from "./helpers.js";

describe("Dispatcher: serial turns, queueing and merging", () => {
  it("runs one turn at a time and merges messages queued meanwhile into the next turn", async () => {
    const backend = new FakeBackend();
    const { dispatcher, channel } = makeDispatcher({ main: backend });

    dispatcher.handleInbound(msg("first"));
    dispatcher.handleInbound(msg("second"));
    dispatcher.handleInbound(msg("third"));

    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0]!.prompt).toBe("first");

    backend.release();
    await vi.waitFor(() => expect(backend.calls).toHaveLength(2));
    expect(backend.calls[1]!.prompt).toBe("second\n\nthird");
    // The second turn resumes the session the first one created.
    expect(backend.calls[1]!.sessionId).toBe("fake-s1");

    backend.release();
    await vi.waitFor(() => expect(channel.texts()).toEqual(["reply:first", "reply:second\n\nthird"]));
    expect(backend.calls).toHaveLength(2);
  });

  it("keeps chats independent", async () => {
    const backend = new FakeBackend();
    const { dispatcher } = makeDispatcher({ main: backend });
    dispatcher.handleInbound(msg("a", "fake:test:alice"));
    dispatcher.handleInbound(msg("b", "fake:test:bob"));
    expect(backend.calls.map((c) => c.prompt)).toEqual(["a", "b"]);
  });

  it("refuses messages beyond the queue limit", async () => {
    const backend = new FakeBackend();
    const { dispatcher, channel } = makeDispatcher({ main: backend });
    dispatcher.handleInbound(msg("running"));
    for (let i = 0; i < 11; i++) dispatcher.handleInbound(msg(`q${i}`));
    await vi.waitFor(() => expect(channel.texts().some((t) => t.includes("排队消息太多"))).toBe(true));
  });

  it("toggles the typing indicator around a turn", async () => {
    const backend = new FakeBackend();
    backend.auto = true;
    const { dispatcher, channel } = makeDispatcher({ main: backend });
    dispatcher.handleInbound(msg("hi"));
    await vi.waitFor(() => expect(channel.typing.map((t) => t.typing)).toEqual([true, false]));
  });

  it("/stop aborts the running turn", async () => {
    const backend = new FakeBackend();
    const { dispatcher, channel } = makeDispatcher({ main: backend });
    dispatcher.handleInbound(msg("long task"));
    dispatcher.handleInbound(msg("/stop"));
    await vi.waitFor(() => expect(channel.texts()).toContain("已停止。"));
  });
});

describe("Dispatcher: commands", () => {
  it("/ctx use <name> switches the active profile and keeps per-profile sessions", async () => {
    const a = new FakeBackend("a");
    const b = new FakeBackend("b");
    a.auto = b.auto = true;
    const { dispatcher, channel, activeProfiles } = makeDispatcher({ a, b });

    dispatcher.handleInbound(msg("hello a"));
    await vi.waitFor(() => expect(a.calls).toHaveLength(1));

    dispatcher.handleInbound(msg("/ctx use b"));
    expect(activeProfiles.get(CHAT)).toBe("b");
    dispatcher.handleInbound(msg("hello b"));
    await vi.waitFor(() => expect(b.calls).toHaveLength(1));
    expect(b.calls[0]!.sessionId).toBeUndefined();

    dispatcher.handleInbound(msg("/use a"));
    dispatcher.handleInbound(msg("again a"));
    await vi.waitFor(() => expect(a.calls).toHaveLength(2));
    expect(a.calls[1]!.sessionId).toBe("a-s1");
    expect(channel.texts().some((t) => t.includes("已切到「b」"))).toBe(true);
  });

  it("/ctx use with an unknown or missing name is rejected", async () => {
    const { dispatcher, channel, activeProfiles } = makeDispatcher({ a: new FakeBackend("a") });
    dispatcher.handleInbound(msg("/ctx use nope"));
    dispatcher.handleInbound(msg("/ctx use"));
    await vi.waitFor(() => expect(channel.texts().filter((t) => t.includes("没有这个上下文"))).toHaveLength(2));
    expect(activeProfiles.get(CHAT)).toBeUndefined();
  });

  it("/ctx lists profiles and marks the active one", async () => {
    const { dispatcher, channel } = makeDispatcher({ a: new FakeBackend("a"), b: new FakeBackend("b") });
    dispatcher.handleInbound(msg("/ctx"));
    await vi.waitFor(() => expect(channel.texts()[0]).toMatch(/▶ a（a）[\s\S]*・ b（b）/));
  });

  it("/new resets only the active profile's session", async () => {
    const a = new FakeBackend("a");
    a.auto = true;
    const { dispatcher, sessions } = makeDispatcher({ a, b: new FakeBackend("b") });
    sessions.set(`${CHAT}#b`, "b-old");
    dispatcher.handleInbound(msg("x"));
    await vi.waitFor(() => expect(sessions.get(`${CHAT}#a`)).toBe("a-s1"));

    dispatcher.handleInbound(msg("/new"));
    expect(sessions.get(`${CHAT}#a`)).toBeUndefined();
    expect(sessions.get(`${CHAT}#b`)).toBe("b-old");

    dispatcher.handleInbound(msg("y"));
    await vi.waitFor(() => expect(a.calls).toHaveLength(2));
    expect(a.calls[1]!.sessionId).toBeUndefined();
  });

  it("unknown slash commands go to the model", async () => {
    const a = new FakeBackend("a");
    const { dispatcher } = makeDispatcher({ a });
    dispatcher.handleInbound(msg("/my-skill arg"));
    expect(a.calls[0]!.prompt).toBe("/my-skill arg");
  });

  it("/handoff validates its target", async () => {
    const a = new FakeBackend("a");
    const { dispatcher, channel } = makeDispatcher({ a, b: new FakeBackend("b") });
    dispatcher.handleInbound(msg("/handoff"));
    dispatcher.handleInbound(msg("/handoff nope do it"));
    await vi.waitFor(() => expect(channel.texts().filter((t) => t.startsWith("用法：/handoff"))).toHaveLength(2));
    expect(a.calls).toHaveLength(0);
  });

  it("/handoff is refused while a turn is running", async () => {
    const a = new FakeBackend("a");
    const { dispatcher, channel } = makeDispatcher({ a, b: new FakeBackend("b") });
    dispatcher.handleInbound(msg("busy"));
    dispatcher.handleInbound(msg("/handoff b"));
    await vi.waitFor(() => expect(channel.texts().some((t) => t.includes("等它结束"))).toBe(true));
  });

  it("/handoff asks the current profile for a brief and seeds the target with it", async () => {
    const a = new FakeBackend("a", (req) => (req.prompt === HANDOFF_BRIEF_PROMPT ? "BRIEF" : "ok"));
    const b = new FakeBackend("b", () => "got it");
    a.auto = b.auto = true;
    const { dispatcher, channel, activeProfiles } = makeDispatcher({ a, b });

    dispatcher.handleInbound(msg("work on a"));
    await vi.waitFor(() => expect(dispatcher.snapshotChats()[0]?.running).toBe(false));
    expect(a.calls).toHaveLength(1);

    dispatcher.handleInbound(msg("/handoff b finish the script"));
    await vi.waitFor(() => expect(b.calls).toHaveLength(1));
    expect(a.calls[1]!.prompt).toBe(HANDOFF_BRIEF_PROMPT);
    expect(a.calls[1]!.sessionId).toBe("a-s1");
    expect(b.calls[0]!.prompt).toContain("BRIEF");
    expect(b.calls[0]!.prompt).toContain("finish the script");
    expect(activeProfiles.get(CHAT)).toBe("b");
    await vi.waitFor(() => expect(channel.texts().at(-1)).toBe("【已交接到「b」】\ngot it"));
  });

  it("/status reports the active context", async () => {
    const { dispatcher, channel } = makeDispatcher({ a: new FakeBackend("a") });
    dispatcher.handleInbound(msg("/status"));
    await vi.waitFor(() => expect(channel.texts()[0]).toContain("上下文: a"));
  });
});
