import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** Weixin account file, as written by `pnpm login:weixin`. */
const WeixinCredentialsSchema = z.object({
  token: z.string(),
  baseUrl: z.string().default("https://ilinkai.weixin.qq.com"),
  /** The person who scanned the login QR code; the default allowFrom. */
  userId: z.string().optional(),
  savedAt: z.string().optional(),
});

/**
 * A profile is one named context: reasoning backend × workspace × persona.
 * Each chat keeps an independent session per profile and switches between
 * them with /ctx use <name>.
 */
const ProfileSchema = z.object({
  /** "echo" is a zero-dependency demo backend that just repeats the prompt. */
  backend: z.enum(["claude", "codex", "echo"]),
  /** Working directory the agent runs in — its context root. Relative paths resolve against the repo root. */
  workspace: z.string(),
  /** Identity / tone / output rules appended to the harness system prompt. */
  persona: z.string().optional(),
  model: z.string().optional(),
  // --- claude only ---
  maxTurns: z.number().int().positive().optional(),
  permissionMode: z.enum(["default", "acceptEdits", "bypassPermissions", "dontAsk"]).default("bypassPermissions"),
  /** Tool names removed from the model entirely (supports MCP names like mcp__server__tool). */
  disallowedTools: z.array(z.string()).optional(),
  /**
   * Isolated mode (for bots strangers can talk to): load none of the local
   * Claude Code configuration (user/project/local skills, MCP servers, hooks,
   * plugins, CLAUDE.md), expose only the `tools` allowlist, route every tool
   * call through a guard (WebFetch may not reach private / loopback hosts),
   * and replace the Claude Code system prompt entirely with `systemPrompt`.
   */
  isolated: z.boolean().default(false),
  /** Built-in tools allowed when isolated, e.g. ["WebSearch", "WebFetch"]; [] = chat only. */
  tools: z.array(z.string()).optional(),
  /** When isolated: the full system prompt (no Claude Code coding-assistant preset). */
  systemPrompt: z.string().optional(),
  // --- codex only ---
  /** false: keep codex sandbox/approvals instead of the bypass flag. */
  dangerouslyBypass: z.boolean().optional(),
  sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
  turnTimeoutMinutes: z.number().positive().optional(),
});

const QQBotCredentialsSchema = z.object({
  appId: z.string(),
  appSecret: z.string(),
  /** The owner's c2c openid under this bot (learned from their first message). */
  ownerOpenid: z.string().optional(),
});

const BotCommon = {
  enabled: z.boolean().default(true),
  /** Profiles this bot can switch between (must exist in top-level profiles). */
  profiles: z.array(z.string()).min(1),
  defaultProfile: z.string(),
  session: z
    .object({
      /** Minutes of inactivity after which the next message starts a fresh session. 0 = never. */
      idleResetMinutes: z.number().default(0),
    })
    .default({ idleResetMinutes: 0 }),
};

const WeixinBotSchema = z.object({
  ...BotCommon,
  channel: z.literal("weixin"),
  weixin: z.object({
    /** Path to the account file ({ token, baseUrl, userId }) written by `pnpm login:weixin`. */
    tokenFile: z.string(),
    /** Explicit allowlist of user ids; defaults to the tokenFile's userId. */
    allowFrom: z.array(z.string()).optional(),
  }),
});

const QQBotBotSchema = z.object({
  ...BotCommon,
  channel: z.literal("qqbot"),
  qqbot: z.object({
    /** Path to { appId, appSecret, ownerOpenid } — keep it in the gitignored secrets/ dir. */
    credentialsFile: z.string(),
    /** Explicit allowlist of openids; defaults to the credentials file's ownerOpenid. */
    allowFrom: z.array(z.string()).optional(),
    /** true = anyone may DM the bot (allowFrom ignored). Only allowed with isolated profiles. */
    public: z.boolean().default(false),
  }),
});

/** HTTP long-poll protocol for a custom TV / kiosk client, see channels/tv/channel.ts. */
const TvBotSchema = z.object({
  ...BotCommon,
  channel: z.literal("tv"),
  tv: z.object({
    /** Default 0.0.0.0 so a LAN device can reach it; restrict with a firewall + the token. */
    bind: z.string().default("0.0.0.0"),
    port: z.number().int().positive().default(18796),
    /** Path to { token } (>= 16 chars). The client sends it as the X-TV-Token header. */
    tokenFile: z.string(),
    /** Optional whisper.cpp `whisper-server` /inference URL for POST /tv/asr. */
    asrUrl: z.string().optional(),
    asrLanguage: z.string().default("zh"),
    /** User id used in the chatKey; there is one shared conversation per TV bot. */
    chatId: z.string().default("tv"),
  }),
});

const LocalHttpSchema = z.object({
  enabled: z.boolean().default(false),
  bind: z.string().default("127.0.0.1"),
  port: z.number().int().positive().default(18800),
  /** How long POST /chat waits for the reply. */
  timeoutSeconds: z.number().positive().default(600),
});

/** Local demo channel: stdin REPL and/or a POST /chat HTTP endpoint. No platform account needed. */
const LocalBotSchema = z.object({
  ...BotCommon,
  channel: z.literal("local"),
  local: z
    .object({
      /** Read lines from the terminal (ignored when stdin is not a TTY). */
      stdin: z.boolean().default(true),
      http: LocalHttpSchema.default({ enabled: false, bind: "127.0.0.1", port: 18800, timeoutSeconds: 600 }),
    })
    .default({ stdin: true, http: { enabled: false, bind: "127.0.0.1", port: 18800, timeoutSeconds: 600 } }),
});

const BotSchema = z.discriminatedUnion("channel", [WeixinBotSchema, QQBotBotSchema, TvBotSchema, LocalBotSchema]);

const PanelSchema = z.object({
  enabled: z.boolean().default(true),
  /** Loopback only by default — the panel has no auth and full control. */
  bind: z.string().default("127.0.0.1"),
  port: z.number().int().positive().default(18790),
});

/**
 * Serves agent-written files as web pages. NO AUTH: read the README before
 * exposing it through a reverse proxy.
 */
const PublishSchema = z.object({
  enabled: z.boolean().default(false),
  /** Exact addresses only (loopback, or the interface your reverse proxy reaches) — never 0.0.0.0. */
  binds: z.array(z.string()).default(["127.0.0.1"]),
  port: z.number().int().positive().default(18792),
  /** Public origin, used to print links. */
  baseUrl: z.string().default("http://127.0.0.1:18792"),
  /** Title of the index pages. */
  title: z.string().default("Home Agent Gate"),
  /** URL first segment -> directory that agents write into. Relative paths resolve against the repo root. */
  roots: z.record(z.string(), z.string()).default({}),
  /** First-level subdirectories of every root that proxied (external) requests may read; the rest 404. */
  publicDirs: z.array(z.string()).default(["public"]),
  /** Readable externally by exact file URL only: no listing, not on the public index. */
  linkOnlyDirs: z.array(z.string()).default([]),
});

const ConfigSchema = z
  .object({
    stateDir: z.string().default("state"),
    panel: PanelSchema.default({ enabled: true, bind: "127.0.0.1", port: 18790 }),
    publish: PublishSchema.default({
      enabled: false,
      binds: ["127.0.0.1"],
      port: 18792,
      baseUrl: "http://127.0.0.1:18792",
      title: "Home Agent Gate",
      roots: {},
      publicDirs: ["public"],
      linkOnlyDirs: [],
    }),
    profiles: z.record(z.string(), ProfileSchema),
    bots: z.record(z.string(), BotSchema),
  })
  .check((ctx) => {
    for (const [botId, bot] of Object.entries(ctx.value.bots)) {
      for (const name of [...bot.profiles, bot.defaultProfile]) {
        if (!ctx.value.profiles[name]) {
          ctx.issues.push({
            code: "custom",
            message: `bot "${botId}" references unknown profile "${name}"`,
            input: name,
          });
        }
      }
      // Anyone can message a public bot: if it can switch to a non-isolated
      // profile, a stranger gets a full agent with shell / file access on this machine.
      if (isPublicBot(bot)) {
        for (const name of bot.profiles) {
          if (ctx.value.profiles[name] && !ctx.value.profiles[name].isolated) {
            ctx.issues.push({
              code: "custom",
              message: `bot "${botId}" is public but profile "${name}" is not isolated`,
              input: name,
            });
          }
        }
      }
      if (!bot.profiles.includes(bot.defaultProfile)) {
        ctx.issues.push({
          code: "custom",
          message: `bot "${botId}": defaultProfile "${bot.defaultProfile}" must be listed in profiles`,
          input: bot.defaultProfile,
        });
      }
    }
  });

export type ProfileConfig = z.infer<typeof ProfileSchema>;
export type BotConfig = z.infer<typeof BotSchema>;
export type GatewayConfig = z.infer<typeof ConfigSchema>;
export type WeixinCredentials = z.infer<typeof WeixinCredentialsSchema>;
export type QQBotCredentials = z.infer<typeof QQBotCredentialsSchema>;

/** A bot anyone can message. Such bots may only expose isolated profiles. */
export function isPublicBot(bot: BotConfig): boolean {
  return bot.channel === "qqbot" && bot.qqbot.public;
}

/** Repository root; relative paths in the config resolve against it. */
export const gatewayRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Validate a raw config object and resolve its relative paths (stateDir,
 * profile workspaces, publish roots) against baseDir. Throws on any issue.
 */
export function parseConfig(raw: unknown, baseDir = gatewayRoot): GatewayConfig {
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}`);
    throw new Error(`invalid gateway config:\n${[...new Set(lines)].join("\n")}`);
  }
  const cfg = parsed.data;
  cfg.stateDir = path.resolve(baseDir, cfg.stateDir);
  for (const profile of Object.values(cfg.profiles)) {
    profile.workspace = path.resolve(baseDir, profile.workspace);
  }
  for (const [name, dir] of Object.entries(cfg.publish.roots)) {
    cfg.publish.roots[name] = path.resolve(baseDir, dir);
  }
  return cfg;
}

export function loadConfig(configPath?: string): GatewayConfig {
  const file = configPath ? path.resolve(configPath) : path.join(gatewayRoot, "gateway.config.json");
  if (!fs.existsSync(file)) {
    throw new Error(`config not found: ${file} (copy gateway.config.example.json to gateway.config.json)`);
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  return parseConfig(raw);
}

export function loadWeixinCredentials(tokenFile: string): WeixinCredentials {
  const resolved = path.resolve(gatewayRoot, tokenFile);
  if (!fs.existsSync(resolved)) {
    throw new Error(`weixin token file not found: ${resolved} (run: pnpm login:weixin --out ${tokenFile})`);
  }
  const raw = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  return WeixinCredentialsSchema.parse(raw);
}

export function loadTvToken(tokenFile: string): string {
  const raw = JSON.parse(fs.readFileSync(path.resolve(gatewayRoot, tokenFile), "utf-8")) as { token?: string };
  if (!raw.token || raw.token.length < 16) throw new Error(`tv token in ${tokenFile} missing or too short`);
  return raw.token;
}

export function loadQQBotCredentials(credentialsFile: string): QQBotCredentials {
  const resolved = path.resolve(gatewayRoot, credentialsFile);
  const raw = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  return QQBotCredentialsSchema.parse(raw);
}
