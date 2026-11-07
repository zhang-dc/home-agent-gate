# agentgate

[中文](README.md)

A self-hosted **IM ↔ AI agent gateway**. The message and access layers are built in-house; **context management and reasoning are delegated to agent harnesses** (Claude Code via the Agent SDK, or the Codex CLI).

- Chat with Claude Code / Codex running on your own machine from WeChat, QQ, a TV client or a local terminal — with their full tools, skills, MCP servers and CLAUDE.md, inside a workspace you choose.
- Strictly serial per chat: messages that arrive while a turn runs are queued and merged into the next turn.
- Several named contexts per chat (profile = backend × workspace × persona): switch with `/ctx use`, hand over across backends with `/handoff`.
- Public bots for strangers: isolated mode loads no local config, exposes only allowlisted tools, blocks WebFetch to private addresses, and the gateway refuses to start on an unsafe config.
- Local admin panel, a publish server for long reports, and Windows keepalive scripts.

## Architecture

```
 WeChat ilink bot ─long poll─┐
 QQ bot ─WebSocket───────────┤                        ┌─ "assistant" ─▶ ClaudeBackend ─▶ Agent SDK query({ resume, cwd })
 TV client ─HTTP long poll───┼─▶ Channel ─InboundMessage─▶ Dispatcher ─┼─ "codex" ─────▶ CodexBackend ─▶ codex exec [resume] --json
 terminal / POST /chat ──────┘      ▲                     │ serial, merge └─ "public" ───▶ ClaudeBackend(isolated) + tool-guard
                                    └── sendText (chunked, Markdown stripped)
   SessionStore / KVFile in state/ (session id per chatKey#profile)    panel :18790    publish :18792
```

- `src/core/` — dispatcher (routing, queueing, commands), session / KV stores, rendering, outbox
- `src/backends/` — `claude.ts`, `codex.ts`, `echo.ts` (demo, no model), `tool-guard.ts`
- `src/channels/` — `weixin/`, `qqbot/`, `tv/`, `local/`
- `src/server/` — `panel.ts`, `publish.ts`; `src/cli/login-weixin.ts` — WeChat QR login

## Quick start (local channel, no accounts needed)

```bash
git clone https://github.com/zhang-dc/agentgate.git && cd agentgate
pnpm install                      # Node >= 22
cp gateway.config.example.json gateway.config.json
pnpm start
```

The example config enables only the `local` bot, whose default profile is `echo` (repeats your message, no model needed). Type in the terminal, or:

```bash
curl -s -X POST http://127.0.0.1:18800/chat -d '{"text":"hello","user":"alice"}'
# {"replies":["[echo #1] hello"]}
```

The request is held until the turn completes. For a real model, log in to Claude Code (or set `ANTHROPIC_API_KEY`) and send `/ctx use assistant`; for Codex, log in to the `codex` CLI and `/ctx use codex`. `pnpm smoke <profile>` checks a backend on its own.

## Commands

| Command | Effect |
|---|---|
| `/ctx` | list contexts |
| `/ctx use <name>` / `/use <name>` | switch (resumes that context's session if any) |
| `/handoff <name> [note]` | current context writes a brief; the target context starts with it |
| `/new` / `/reset` | reset the active context's session only |
| `/stop` | abort the running turn |
| `/status` | active context, running, queue length, session id |

Other slash messages go to the model unchanged (they may be skills). Sessions are stored per `chatKey#profile` in `state/`; `session.idleResetMinutes` starts a fresh session after inactivity.

Non-isolated Claude / Codex profiles have full shell and file access on your machine — only attach them to bots that answer just you (`allowFrom`).

## Channels

- **local** — stdin REPL (TTY only) and `POST /chat {"text","user"?}` → `{"replies":[...]}`. No auth; keep it on 127.0.0.1.
- **weixin** — the official WeChat ilink bot API (same protocol as Tencent's `openclaw-weixin` plugin). Run `pnpm login:weixin --out secrets/weixin.json`, scan the QR code with WeChat, then set `"weixin": { "tokenFile": "secrets/weixin.json" }`. The scanner becomes the default `allowFrom`. One token can only have one consumer. WeChat bots cannot push proactively; undeliverable messages are queued and flushed, merged, on the user's next message.
- **qqbot** — official SDK `@tencent-connect/qqbot-nodejs` (outbound WebSocket, no public callback). Credentials `{ appId, appSecret, ownerOpenid }` in `secrets/`. C2C only. Send fallback: passive reply → proactive → wakeup → outbox.
- **tv** — LAN HTTP long-poll protocol for a custom big-screen client of our own (there is no public client; write one against these endpoints): `POST /tv/chat`, `POST /tv/reset`, `GET /tv/events?since=&typing=`, `POST /tv/asr` (whisper.cpp). Every request needs the `X-TV-Token` header. Binds 0.0.0.0 by default — firewall it to your LAN.

## Isolated mode for public bots

A public bot (`qqbot.public: true`) may only use `isolated: true` profiles: no local Claude Code settings / skills / MCP / hooks / CLAUDE.md, only the `tools` allowlist, permission mode `default` with a `canUseTool` guard that denies non-allowlisted tools and WebFetch to loopback / private / link-local / CGNAT / ULA addresses (decided on the URL text, no DNS lookup; DNS rebinding is not covered), the system prompt fully replaced, auto-memory off. **If a public bot lists any non-isolated profile, the gateway refuses to start.**

## Admin panel

`http://127.0.0.1:18790` — channel health, chats, switch context, reset sessions, stop, hand off, log tail. API: `GET /api/state`, `GET /api/logs`, `POST /api/action {botId, type: switch|reset|stop|handoff|inject|send, chatKey, ...}`. The port doubles as a single-instance lock. **No auth and full control: keep it on loopback.**

## Publish server

Agents write Markdown into a configured root; it is immediately a page (`.md` rendered with GFM tables and a TOC, `.html` served as is). Direct requests see the whole tree; requests that came through a reverse proxy (`X-Real-IP` / `X-Forwarded-For`) only see `<root>/<publicDirs>/**`.

> **There is no authentication.** Once exposed through a reverse proxy, everything under the public dirs is public. Never mount directories containing secrets or private data; add auth at the proxy if you need it.

## Windows keepalive

`scripts/gateway.cmd` (launcher, logs to `state/gateway.log`), `gateway-guard.ps1` (pid / panel-port liveness check, relaunches), `guard-hidden.vbs` (windowless entry for Task Scheduler), `restart-once.ps1`. All paths are relative to the repo root. **Keep these files pure ASCII** — cmd.exe and PowerShell 5.1 under Task Scheduler misread non-ASCII bytes and fail silently. See the Chinese README for the `Register-ScheduledTask` snippet.

## Development

`pnpm typecheck`, `pnpm test` (vitest with a fake backend and fake channel; no real model calls).

## Roadmap

- **Router + parallel Workers (coming soon)**: a small-model router per chat that answers within seconds and dispatches tasks to multiple concurrent worker sessions, so you can keep chatting while long tasks run.

## License

[MIT](LICENSE) © zhang-dc
