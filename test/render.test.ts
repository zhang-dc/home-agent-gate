import { describe, expect, it } from "vitest";

import { mergeOutbox } from "../src/core/outbox.js";
import { chunkText, markdownToPlainText } from "../src/core/render.js";

describe("chunkText", () => {
  it("returns short text unchanged", () => {
    expect(chunkText("hello", 10)).toEqual(["hello"]);
  });

  it("splits long text into chunks no longer than the limit, preferring paragraph breaks", () => {
    const para = (c: string) => c.repeat(60);
    const text = [para("a"), para("b"), para("c")].join("\n\n");
    const chunks = chunkText(text, 130);
    expect(chunks).toEqual([`${para("a")}\n\n${para("b")}`, para("c")]);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(130);
  });

  it("hard-cuts text with no break points and loses nothing", () => {
    const text = "x".repeat(1000);
    const chunks = chunkText(text, 300);
    expect(chunks.every((c) => c.length <= 300)).toBe(true);
    expect(chunks.join("")).toBe(text);
  });
});

describe("markdownToPlainText", () => {
  it("strips common markdown", () => {
    const md = "# Title\n\n**bold** and `code` and [link](https://example.com)\n\n- item\n\n```js\nconst x = 1;\n```";
    expect(markdownToPlainText(md)).toBe(
      "【Title】\n\nbold and code and link (https://example.com)\n\n• item\n\nconst x = 1;",
    );
  });
});

describe("mergeOutbox", () => {
  it("merges queued entries into as few messages as fit", () => {
    const t = new Date(2030, 0, 2, 3, 4).getTime();
    const batches = mergeOutbox(
      [
        { text: "one", queuedAtMs: t },
        { text: "two", queuedAtMs: t },
        { text: "z".repeat(80), queuedAtMs: t },
      ],
      100,
    );
    expect(batches).toHaveLength(2);
    expect(batches[0]).toBe("[延迟推送 01-02 03:04]\none\n\n[延迟推送 01-02 03:04]\ntwo");
  });
});
