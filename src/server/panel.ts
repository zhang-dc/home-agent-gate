import fs from "node:fs";

import { Hono } from "hono";
import { serve } from "@hono/node-server";

import type { Dispatcher } from "../core/dispatcher.js";
import type { Channel } from "../core/envelope.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("panel");

export interface PanelBot {
  id: string;
  profiles: string[];
  defaultProfile: string;
  dispatcher: Dispatcher;
  channel: Channel;
}

export interface PanelOptions {
  port: number;
  bind: string;
  bots: PanelBot[];
  logFile: string;
}

interface ActionBody {
  botId?: string;
  type?: "switch" | "reset" | "stop" | "handoff" | "inject" | "send";
  chatKey?: string;
  profile?: string;
  note?: string;
  text?: string;
}

export function startPanel(opts: PanelOptions): Promise<void> {
  const startedAt = Date.now();
  const app = new Hono();

  app.get("/api/state", (c) =>
    c.json({
      uptimeMs: Date.now() - startedAt,
      bots: opts.bots.map((bot) => ({
        id: bot.id,
        profiles: bot.profiles,
        defaultProfile: bot.defaultProfile,
        channel: bot.channel.status(),
        chats: bot.dispatcher.snapshotChats(),
      })),
    }),
  );

  app.get("/api/logs", (c) => {
    const lines = Math.min(Number(c.req.query("lines") ?? 200), 1000);
    try {
      const raw = fs.readFileSync(opts.logFile, "utf-8");
      const all = raw.split(/\r?\n/);
      return c.text(all.slice(-lines).join("\n"));
    } catch {
      return c.text(`(无法读取日志文件 ${opts.logFile})`);
    }
  });

  app.post("/api/action", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as ActionBody;
    const bot = opts.bots.find((b) => b.id === body.botId);
    if (!bot || !body.chatKey || !body.type) {
      return c.json({ ok: false, error: "botId/chatKey/type 缺失" }, 400);
    }
    const d = bot.dispatcher;
    let result: { ok: boolean; error?: string };
    switch (body.type) {
      case "switch":
        result = d.setActiveProfile(body.chatKey, body.profile ?? "");
        break;
      case "reset":
        result = d.resetSession(body.chatKey, body.profile ?? "");
        break;
      case "stop":
        result = d.stopTurn(body.chatKey);
        break;
      case "handoff":
        result = d.triggerHandoff(body.chatKey, body.profile ?? "", body.note ?? "");
        break;
      case "inject":
        result = d.injectMessage(body.chatKey, body.text ?? "");
        break;
      case "send":
        result = d.sendDirect(body.chatKey, body.text ?? "");
        break;
      default:
        result = { ok: false, error: `unknown action` };
    }
    log.info(`action ${body.type} bot=${body.botId} chat=${body.chatKey} profile=${body.profile ?? "-"} -> ${result.ok ? "ok" : result.error}`);
    return c.json(result, result.ok ? 200 : 400);
  });

  app.get("/", (c) => c.html(PAGE));

  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: opts.port, hostname: opts.bind }, (info) => {
      log.info(`panel listening on http://${opts.bind}:${info.port}`);
      resolve();
    });
    // The panel port doubles as the single-instance lock: bind failure means
    // another gateway is already live — exit before any channel starts.
    server.on("error", (err) => {
      log.error(`panel failed to bind ${opts.bind}:${opts.port} — another gateway instance is likely running (${String(err)})`);
      process.exit(1);
    });
  });
}

const PAGE = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agentgate</title>
<style>
  :root { --bg:#101418; --card:#1a2027; --line:#2a333d; --fg:#dbe4ec; --dim:#7f8ea0; --accent:#4fb6ff; --ok:#4ade80; --warn:#fbbf24; --err:#f87171; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.6 "Segoe UI", "Microsoft YaHei", sans-serif; padding:20px; }
  h1 { font-size:18px; margin:0 0 4px; } h1 small { color:var(--dim); font-weight:normal; margin-left:10px; }
  h2 { font-size:15px; margin:22px 0 10px; color:var(--accent); }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; margin-bottom:14px; }
  table { border-collapse:collapse; width:100%; }
  th, td { text-align:left; padding:6px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--dim); font-weight:normal; font-size:12px; }
  .dim { color:var(--dim); } .ok { color:var(--ok); } .warn { color:var(--warn); } .err { color:var(--err); }
  .pill { display:inline-block; padding:1px 8px; border-radius:99px; border:1px solid var(--line); font-size:12px; margin-right:6px; }
  .pill.active { border-color:var(--accent); color:var(--accent); }
  select, input, button { background:#12181f; color:var(--fg); border:1px solid var(--line); border-radius:6px; padding:4px 8px; font:inherit; font-size:13px; }
  button { cursor:pointer; } button:hover { border-color:var(--accent); }
  button.danger:hover { border-color:var(--err); color:var(--err); }
  pre { background:#0b0f13; border:1px solid var(--line); border-radius:8px; padding:10px; max-height:320px; overflow:auto; font-size:12px; white-space:pre-wrap; word-break:break-all; }
  .row { display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
  .toast { position:fixed; right:20px; bottom:20px; background:var(--card); border:1px solid var(--line); border-radius:8px; padding:10px 14px; display:none; }
  .mono { font-family:Consolas, monospace; font-size:12px; }
</style>
</head>
<body>
<h1>agentgate <small id="uptime"></small></h1>
<div class="dim">消息层/接入层自研 · 推理交给 harness · <span id="refreshed"></span></div>
<div id="bots"></div>
<h2>日志（最近 200 行）</h2>
<pre id="logs">加载中…</pre>
<div class="toast" id="toast"></div>
<script>
const fmtAge = (ms) => {
  if (!ms) return "—";
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return s + "秒前";
  if (s < 3600) return Math.floor(s/60) + "分钟前";
  return Math.floor(s/3600) + "小时前";
};
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
function toast(msg, isErr) {
  const el = document.getElementById("toast");
  el.textContent = msg; el.style.display = "block";
  el.style.borderColor = isErr ? "var(--err)" : "var(--ok)";
  setTimeout(() => el.style.display = "none", 2500);
}
async function action(body) {
  const res = await fetch("/api/action", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({ok:false,error:"bad response"}));
  toast(j.ok ? "已执行" : ("失败：" + (j.error || res.status)), !j.ok);
  refresh();
}
function chatRow(bot, chat) {
  const profOpts = bot.profiles.map(p => \`<option value="\${esc(p)}" \${p===chat.activeProfile?"selected":""}>\${esc(p)}</option>\`).join("");
  const sessions = Object.entries(chat.sessions).map(([p, s]) =>
    \`<div class="mono">\${esc(p)}: \${esc(s.sessionId.slice(0,8))}… <span class="dim">(\${fmtAge(s.updatedAtMs)})</span>
      <button class="danger" onclick='action({botId:"\${bot.id}",type:"reset",chatKey:\${JSON.stringify(chat.chatKey)},profile:"\${esc(p)}"})'>重置</button></div>\`
  ).join("") || '<span class="dim">（无会话）</span>';
  const handoffTargets = bot.profiles.filter(p => p !== chat.activeProfile);
  const hoOpts = handoffTargets.map(p => \`<option value="\${esc(p)}">\${esc(p)}</option>\`).join("");
  const hoId = "ho_" + btoa(unescape(encodeURIComponent(bot.id + chat.chatKey))).replace(/[^a-zA-Z0-9]/g,"");
  return \`<tr>
    <td class="mono">\${esc(chat.chatKey)}</td>
    <td><select onchange='action({botId:"\${bot.id}",type:"switch",chatKey:\${JSON.stringify(chat.chatKey)},profile:this.value})'>\${profOpts}</select></td>
    <td>\${chat.running ? '<span class="warn">运行中</span>' : '<span class="dim">空闲</span>'}\${chat.queueLength ? ' <span class="warn">排队'+chat.queueLength+'</span>' : ''}
        \${chat.running ? \`<button class="danger" onclick='action({botId:"\${bot.id}",type:"stop",chatKey:\${JSON.stringify(chat.chatKey)}})'>停止</button>\` : ''}</td>
    <td>\${sessions}</td>
    <td><div class="row">
      <select id="\${hoId}_t">\${hoOpts}</select>
      <input id="\${hoId}_n" placeholder="附言（可选）" size="14">
      <button onclick='action({botId:"\${bot.id}",type:"handoff",chatKey:\${JSON.stringify(chat.chatKey)},profile:document.getElementById("\${hoId}_t").value,note:document.getElementById("\${hoId}_n").value})'>交接</button>
    </div></td>
  </tr>\`;
}
function render(state) {
  document.getElementById("uptime").textContent = "已运行 " + Math.floor(state.uptimeMs/60000) + " 分钟";
  document.getElementById("refreshed").textContent = "刷新于 " + new Date().toLocaleTimeString();
  document.getElementById("bots").innerHTML = state.bots.map(bot => {
    const ch = bot.channel;
    const pollCls = ch.lastPollOkAtMs && Date.now() - ch.lastPollOkAtMs < 120000 ? "ok" : "err";
    return \`<h2>bot: \${esc(bot.id)}</h2>
    <div class="card">
      <div class="row">
        <span class="pill">渠道 \${esc(ch.id)}</span>
        <span>轮询 <span class="\${pollCls}">\${fmtAge(ch.lastPollOkAtMs)}</span></span>
        <span>入站 \${ch.inboundCount} 条（最近 \${fmtAge(ch.lastInboundAtMs)}）</span>
        \${ch.lastError ? \`<span class="err">最近错误(\${fmtAge(ch.lastErrorAtMs)}): \${esc(ch.lastError)}</span>\` : ""}
      </div>
      <div class="dim" style="margin-top:4px">上下文：\${bot.profiles.map(p => \`<span class="pill\${p===bot.defaultProfile?" active":""}">\${esc(p)}\${p===bot.defaultProfile?" (默认)":""}</span>\`).join("")}
        白名单：\${(ch.allowFrom||[]).map(esc).join("、") || "任何人"}</div>
    </div>
    <div class="card">
      <table>
        <tr><th>聊天</th><th>当前上下文</th><th>状态</th><th>会话</th><th>交接</th></tr>
        \${bot.chats.map(c => chatRow(bot, c)).join("") || '<tr><td colspan="5" class="dim">还没有聊天记录</td></tr>'}
      </table>
    </div>\`;
  }).join("");
}
async function refresh() {
  try {
    const state = await (await fetch("/api/state")).json();
    render(state);
    document.getElementById("logs").textContent = await (await fetch("/api/logs")).text();
  } catch (e) { /* gateway restarting */ }
}
refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>`;
