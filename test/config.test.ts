import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { gatewayRoot, parseConfig } from "../src/config.js";

const profiles = {
  full: { backend: "claude", workspace: "workspace/full" },
  safe: { backend: "claude", workspace: "workspace/safe", isolated: true, tools: ["WebSearch"] },
};

function qqBot(extra: Record<string, unknown>) {
  return { channel: "qqbot", qqbot: { credentialsFile: "secrets/qq.json", public: true }, ...extra };
}

describe("config validation", () => {
  it("refuses a public bot that can reach a non-isolated profile", () => {
    expect(() =>
      parseConfig({ profiles, bots: { pub: qqBot({ profiles: ["safe", "full"], defaultProfile: "safe" }) } }),
    ).toThrow(/public but profile "full" is not isolated/);
  });

  it("accepts a public bot with only isolated profiles", () => {
    const cfg = parseConfig({ profiles, bots: { pub: qqBot({ profiles: ["safe"], defaultProfile: "safe" }) } });
    expect(cfg.bots.pub!.channel).toBe("qqbot");
  });

  it("allows non-isolated profiles on private bots", () => {
    const cfg = parseConfig({
      profiles,
      bots: { me: { channel: "local", profiles: ["full", "safe"], defaultProfile: "full" } },
    });
    expect(cfg.bots.me!.channel).toBe("local");
  });

  it("refuses unknown profiles and a defaultProfile outside the list", () => {
    expect(() =>
      parseConfig({ profiles, bots: { me: { channel: "local", profiles: ["ghost"], defaultProfile: "ghost" } } }),
    ).toThrow(/unknown profile "ghost"/);
    expect(() =>
      parseConfig({ profiles, bots: { me: { channel: "local", profiles: ["full"], defaultProfile: "safe" } } }),
    ).toThrow(/must be listed in profiles/);
  });

  it("resolves relative paths against the base dir and applies defaults", () => {
    const base = path.resolve("/srv/home-agent-gate");
    const cfg = parseConfig(
      { profiles, bots: { me: { channel: "local", profiles: ["full"], defaultProfile: "full" } } },
      base,
    );
    expect(cfg.stateDir).toBe(path.join(base, "state"));
    expect(cfg.profiles.full!.workspace).toBe(path.join(base, "workspace", "full"));
    expect(cfg.panel).toEqual({ enabled: true, bind: "127.0.0.1", port: 18790 });
    expect(cfg.publish.enabled).toBe(false);
  });

  it("the shipped example config is valid", () => {
    const raw = JSON.parse(fs.readFileSync(path.join(gatewayRoot, "gateway.config.example.json"), "utf-8"));
    expect(() => parseConfig(raw)).not.toThrow();
  });
});
