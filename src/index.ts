import fs from "node:fs";
import path from "node:path";

import { loadConfig, loadQQBotCredentials, loadTvToken, loadWeixinCredentials, type BotConfig, type ProfileConfig } from "./config.js";
import { ClaudeBackend } from "./backends/claude.js";
import { CodexBackend } from "./backends/codex.js";
import { EchoBackend } from "./backends/echo.js";
import { LocalChannel } from "./channels/local/channel.js";
import { QQBotChannel } from "./channels/qqbot/channel.js";
import { TvChannel } from "./channels/tv/channel.js";
import { WeixinChannel } from "./channels/weixin/channel.js";
import { Dispatcher } from "./core/dispatcher.js";
import type { Channel } from "./core/envelope.js";
import type { ReasoningBackend } from "./core/backend.js";
import { SessionStore } from "./core/session-store.js";
import { KVFile } from "./core/kv-store.js";
import { startPanel, type PanelBot } from "./server/panel.js";
import { startPublish } from "./server/publish.js";
import { createLogger } from "./util/logger.js";

const log = createLogger("gateway");

function buildBackend(profile: ProfileConfig): ReasoningBackend {
  fs.mkdirSync(profile.workspace, { recursive: true });
  if (profile.backend === "echo") return new EchoBackend();
  if (profile.backend === "codex") {
    return new CodexBackend({
      workspace: profile.workspace,
      persona: profile.persona,
      model: profile.model,
      dangerouslyBypass: profile.dangerouslyBypass,
      sandbox: profile.sandbox,
      turnTimeoutMinutes: profile.turnTimeoutMinutes,
    });
  }
  return new ClaudeBackend({
    workspace: profile.workspace,
    persona: profile.persona,
    model: profile.model,
    maxTurns: profile.maxTurns,
    disallowedTools: profile.disallowedTools,
    permissionMode: profile.permissionMode,
    isolated: profile.isolated,
    tools: profile.tools,
    systemPrompt: profile.systemPrompt,
  });
}

function buildChannel(botId: string, bot: BotConfig, stateDir: string): Channel {
  switch (bot.channel) {
    case "local":
      return new LocalChannel({
        accountId: botId,
        stdin: bot.local.stdin,
        ...(bot.local.http.enabled ? { http: bot.local.http } : {}),
      });
    case "tv":
      return new TvChannel({
        accountId: botId,
        bind: bot.tv.bind,
        port: bot.tv.port,
        token: loadTvToken(bot.tv.tokenFile),
        asrUrl: bot.tv.asrUrl,
        asrLanguage: bot.tv.asrLanguage,
        chatId: bot.tv.chatId,
        stateDir,
      });
    case "qqbot": {
      const creds = loadQQBotCredentials(bot.qqbot.credentialsFile);
      return new QQBotChannel({
        accountId: botId,
        appId: creds.appId,
        appSecret: creds.appSecret,
        // Empty allowFrom = anyone. Public bots clear it explicitly; private bots default to the owner.
        allowFrom: bot.qqbot.public ? [] : (bot.qqbot.allowFrom ?? (creds.ownerOpenid ? [creds.ownerOpenid] : [])),
        stateDir,
      });
    }
    case "weixin": {
      const creds = loadWeixinCredentials(bot.weixin.tokenFile);
      return new WeixinChannel({
        accountId: botId,
        baseUrl: creds.baseUrl,
        token: creds.token,
        allowFrom: bot.weixin.allowFrom ?? (creds.userId ? [creds.userId] : []),
        stateDir,
      });
    }
  }
}

async function main(): Promise<void> {
  const config = loadConfig(process.argv[2]);
  // PID file so restart scripts can kill exactly this process tree.
  fs.mkdirSync(config.stateDir, { recursive: true });
  fs.writeFileSync(path.join(config.stateDir, "gateway.pid"), String(process.pid), "utf-8");

  const channels: Channel[] = [];
  const panelBots: PanelBot[] = [];

  for (const [botId, bot] of Object.entries(config.bots)) {
    if (!bot.enabled) {
      log.info(`bot "${botId}" disabled, skipping`);
      continue;
    }

    const channel = buildChannel(botId, bot, config.stateDir);

    const profiles = new Map<string, ReasoningBackend>();
    for (const name of bot.profiles) {
      profiles.set(name, buildBackend(config.profiles[name]!));
    }

    const dispatcher = new Dispatcher(channel, {
      profiles,
      defaultProfile: bot.defaultProfile,
      sessions: new SessionStore(path.join(config.stateDir, `sessions-${botId}.json`), bot.session.idleResetMinutes),
      activeProfiles: new KVFile(path.join(config.stateDir, `active-profiles-${botId}.json`)),
    });

    channels.push(channel);
    panelBots.push({ id: botId, profiles: bot.profiles, defaultProfile: bot.defaultProfile, dispatcher, channel });
    log.info(`bot "${botId}" (${bot.channel}) configured: profiles=[${bot.profiles.join(", ")}] default=${bot.defaultProfile}`);
  }

  if (channels.length === 0) {
    log.error("no enabled bots in config, exiting");
    process.exit(1);
  }

  // Bind the panel port BEFORE starting any channel: the port doubles as a
  // single-instance lock, so a duplicate gateway dies here instead of ever
  // long-polling a platform alongside the live instance.
  if (config.panel.enabled) {
    await startPanel({
      port: config.panel.port,
      bind: config.panel.bind,
      bots: panelBots,
      logFile: path.join(config.stateDir, "gateway.log"),
    });
  }

  if (config.publish.enabled) {
    await startPublish({
      port: config.publish.port,
      binds: config.publish.binds,
      baseUrl: config.publish.baseUrl,
      title: config.publish.title,
      roots: config.publish.roots,
      publicDirs: config.publish.publicDirs,
      linkOnlyDirs: config.publish.linkOnlyDirs,
    });
  }

  for (let i = 0; i < channels.length; i++) {
    await channels[i]!.start(panelBots[i]!.dispatcher.handleInbound);
    log.info(`bot "${panelBots[i]!.id}" up`);
  }

  const shutdown = async (sig: string) => {
    log.info(`${sig} received, shutting down...`);
    await Promise.allSettled(channels.map((c) => c.stop()));
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  log.error(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
