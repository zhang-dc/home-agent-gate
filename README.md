# Home Agent Gate

[English](README.en.md)

自建的 **IM ↔ AI Agent 网关**：消息层、接入层自己实现，**上下文管理和推理交还给 agent harness**（Claude Code via Agent SDK / Codex CLI）。

- 在微信、QQ、电视或本地终端里和你自己机器上的 Claude Code / Codex 对话，它们带着完整的工具、skills、MCP、CLAUDE.md 在你指定的工作区里干活
- 单聊内严格串行：模型在跑时新消息自动排队，空闲后合并成下一轮
- 一个聊天可以挂多个"上下文"（profile = 后端 × 工作区 × 人设），`/ctx use` 随时切换，`/handoff` 带着交接简报跨后端接力
- 可以给外人开一个公开 bot：隔离模式不加载本机任何配置，只开白名单工具，WebFetch 拦内网地址，配置不安全就拒绝启动
- 附带本地管理面板、长报告网页发布服务、Windows 守护脚本

## 架构

```
 微信 ilink bot ──长轮询──┐
 QQ 机器人 ──WebSocket───┤                       ┌─ profile "assistant" ─▶ ClaudeBackend ─▶ Agent SDK query({ resume, cwd })
 电视客户端 ──HTTP 长轮询─┼─▶ Channel ─InboundMessage─▶ Dispatcher ─┼─ profile "codex" ─────▶ CodexBackend ─▶ codex exec [resume] --json
 本地终端 / POST /chat ──┘      ▲                     │ 串行·排队合并 └─ profile "public" ───▶ ClaudeBackend(isolated) + tool-guard
                                │                     │ /ctx /new /stop /status /handoff
                                └── sendText(分块、去 Markdown) ◀──┘
                                                      │
                               SessionStore / KVFile（state/，按 chatKey#profile 存会话 id）
   管理面板 :18790（看状态 / 切上下文 / 停止 / 交接 / 注入消息）     发布服务 :18792（工作区 Markdown → 网页）
```

| 目录 | 作用 |
|---|---|
| `src/core/` | `dispatcher.ts` 会话路由 + 串行 + 命令；`session-store.ts` / `kv-store.ts` 持久化；`render.ts` Markdown 转纯文本 + 分块；`outbox.ts` 发不出去的消息排队合并补发 |
| `src/backends/` | `claude.ts`（Agent SDK，每轮一次 `query()`，`resume` 续会话）、`codex.ts`（`codex exec --json`，prompt 走 stdin）、`echo.ts`（演示用，不调模型）、`tool-guard.ts`（隔离模式的工具守卫） |
| `src/channels/` | `weixin/`、`qqbot/`、`tv/`、`local/` 四种渠道 |
| `src/server/` | `panel.ts` 管理面板、`publish.ts` 发布服务 |
| `src/cli/` | `login-weixin.ts` 微信扫码登录 |
| `scripts/` | Windows 守护脚本、`smoke-backend.ts` |

compaction、memory、CLAUDE.md、skills 全部由 harness 自己管，网关只记一个不透明的 session id。

## 快速开始（终端渠道，5 分钟）

不需要任何平台账号。

```bash
git clone https://github.com/zhang-dc/home-agent-gate.git
cd home-agent-gate
pnpm install                     # Node >= 22
cp gateway.config.example.json gateway.config.json
pnpm start
```

示例配置里启用的只有 `local` bot，默认上下文是 `echo`（原样回显，不调任何模型），所以克隆下来马上能跑：

```
you> 你好
bot> [echo #1] 你好
you> /ctx
bot> 上下文列表：
     ▶ echo（echo）
     ・ assistant（claude）
     ・ codex（codex）
```

同一个 bot 还开了 HTTP 端点（只绑 127.0.0.1）：

```bash
curl -s -X POST http://127.0.0.1:18800/chat -d '{"text":"你好","user":"alice"}'
# {"replies":["[echo #1] 你好"]}
```

请求会挂住直到这一轮结束才返回（超时 `timeoutSeconds`），每个 `user` 一个独立会话，命令也能用。

接真模型：

- **Claude**：本机装好并登录 Claude Code（或设置 `ANTHROPIC_API_KEY`），然后 `/ctx use assistant`。工作区默认是 `workspace/assistant`（不存在会自动创建），往里放 `CLAUDE.md`、skills 就能定制它。
- **Codex**：本机装好并登录 `codex` CLI，然后 `/ctx use codex`。
- 单独验证某个 profile：`pnpm smoke assistant`（跑两轮，检查续会话）。

终端里日志太吵可以 `GATEWAY_LOG_LEVEL=warn pnpm start`。

## 会话命令与上下文（profiles）

**上下文 = 命名 profile：推理后端 × 工作区 × 人设**（配置顶层 `profiles`）。每个聊天在每个 profile 下各有独立会话，切换互不丢失。

| 命令 | 作用 |
|---|---|
| `/ctx` | 列出可用上下文，▶ 标当前 |
| `/ctx use <名字>`（或 `/use <名字>`） | 切换；该上下文有旧会话就继续，否则新开 |
| `/handoff <名字> [附言]` | 让当前上下文写一份交接简报（背景 / 结论 / 涉及文件 / 未完成事项），切过去后注入目标上下文的首轮——跨 harness 带上下文接力 |
| `/new`（或 `/reset`） | 只重置**当前**上下文的会话 |
| `/stop` | 中断正在跑的这一轮 |
| `/status` | 当前上下文、是否运行中、排队数、会话 id |

其它以 `/` 开头的消息原样交给模型（可能是 skill）。

会话映射按 `chatKey#profile` 存在 `state/sessions-<bot>.json`，当前上下文存在 `state/active-profiles-<bot>.json`。`session.idleResetMinutes > 0` 时，闲置超过 N 分钟的下一条消息自动开新会话。chatKey 的格式是 `<渠道>:<botId>:<用户 id>`。

profile 字段（完整见 `src/config.ts`）：

| 字段 | 说明 |
|---|---|
| `backend` | `claude` / `codex` / `echo` |
| `workspace` | agent 的 cwd，相对路径相对仓库根 |
| `persona` | 追加到 harness 系统提示的人设 / 输出规则（Claude 每轮下发，改完下一轮生效；Codex 只在新会话首轮注入） |
| `model` | 覆盖默认模型 |
| `permissionMode` | Claude：默认 `bypassPermissions`（无头运行，适合个人机器）；也可 `default` / `acceptEdits` / `dontAsk` |
| `maxTurns`、`disallowedTools` | Claude |
| `isolated`、`tools`、`systemPrompt` | 隔离模式，见下 |
| `dangerouslyBypass`、`sandbox`、`turnTimeoutMinutes` | Codex（默认带 `--dangerously-bypass-approvals-and-sandbox`，单轮 30 分钟超时） |

> 非隔离的 Claude / Codex profile 在你的机器上拥有完整的 shell 和文件权限。只把它们挂给只响应你自己的 bot（`allowFrom`）。

## 渠道接入

### 本地（`channel: "local"`）

```jsonc
"local": { "channel": "local", "profiles": ["echo", "assistant"], "defaultProfile": "echo",
  "local": { "stdin": true, "http": { "enabled": true, "bind": "127.0.0.1", "port": 18800, "timeoutSeconds": 600 } } }
```

- `stdin`：终端交互，stdin 不是 TTY（比如后台守护运行）时自动关闭。
- `http`：`POST /chat {"text", "user"?}` → `{"replies": [...]}`；`GET /healthz`。没有鉴权，**只绑 127.0.0.1**。适合给脚本 / 定时任务 / 其它程序接入。

### 微信（`channel: "weixin"`）

走微信官方 ilink bot API（与腾讯 `@tencent-weixin/openclaw-weixin` 插件同一套协议：`getupdates` 长轮询 / `sendmessage` / `sendtyping` / `notifystart|stop`），不是 hook，不是逆向。

1. 扫码登录，生成账号文件：

   ```bash
   pnpm login:weixin --out secrets/weixin.json
   ```

   终端里会显示二维码（显示不了就打开打印出来的链接），用手机微信扫码确认；如果手机上显示一个数字，按提示输入。成功后写出 `{ token, baseUrl, userId, savedAt }`。`userId` 是扫码人，会成为默认的 `allowFrom`（只响应这个人）。
2. 配置：`"weixin": { "tokenFile": "secrets/weixin.json" }`，可选 `allowFrom: [...]` 显式白名单。

须知：

- **同一个 bot token 只能有一个消费者**。如果这个 bot 还在别的程序（比如 openclaw）里跑，先停掉，否则两边抢消息。
- 微信 bot **不能主动推送**：只有用户最近一条消息带来的 `context_token` 还有效时才能发。发不出去的消息（定时推送等）会排进 `state/weixin-<bot>.json` 的 outbox，用户下次说话时合并补发（每条带「延迟推送 时间」抬头）。
- 入站支持文本、引用、语音（服务端转写）、图片（CDN 下载 + AES 解密，存到 `state/media/`，路径写进 prompt 让 agent 自己看）；出站只发文本。
- token 过期（errcode -14）会暂停 1 小时重试；持续过期就重新 `pnpm login:weixin`。

### QQ 机器人（`channel: "qqbot"`）

基于腾讯官方 SDK `@tencent-connect/qqbot-nodejs`（WebSocket 出站连接，不需要公网回调），只接私聊（C2C），群消息忽略，入站只取文本。

- 在 [QQ 开放平台](https://q.qq.com/) 创建机器人，凭据写进 `secrets/qqbot.json`：`{ "appId": "...", "appSecret": "...", "ownerOpenid": "..." }`。AppSecret 在开放平台不能再次查看，丢了只能重置。
- **只响应主人**：`allowFrom` 默认取 `ownerOpenid`。openid 按机器人隔离；第一次可以先在 `allowFrom` 里随便填一个占位值，给机器人发一条消息，在日志里找 `dropping message from unauthorized user <openid>` 拿到自己的 openid。注意：`ownerOpenid` 和 `allowFrom` 都不填时会响应所有人。
- 发送降级链：被动回复（用户消息后 55 分钟内、每条最多 4 次）→ 主动消息 → 唤醒消息 → 排进 outbox 等下次入站补发。单条按 1800 字切。
- 未上线审核前只有沙箱里配置的测试成员能用。

### 电视 / 自定义客户端（`channel: "tv"`）

给一个**自定义的大屏客户端**（比如电视盒子上的桌面 App）用的局域网 HTTP 协议。这是我们自己客户端的私有协议，没有现成的公开客户端，需要按下面的接口自己写一个：

| 接口 | 说明 |
|---|---|
| `POST /tv/chat {text}` | 发一条消息进 Dispatcher，返回 `{seq}` |
| `POST /tv/reset` | 「新对话」：清空屏幕历史 + 开新会话 |
| `GET /tv/events?since=<seq>&typing=0\|1` | 有比 `seq` 新的消息、或"正在思考"状态和客户端已知的不同才返回，最多挂 25 秒；返回 `{messages:[{seq,role,text,atMs}], typing, last}` |
| `POST /tv/asr`（body: audio/wav） | 转给 whisper.cpp 的 `whisper-server`（`asrUrl`），返回 `{text}`；会过滤静音时的常见"幻听"字幕 |

所有请求带请求头 `X-TV-Token`，值等于 `tokenFile`（`{ "token": "至少 16 位随机串" }`）里的 token。默认绑 `0.0.0.0:18796` 方便局域网设备访问——请配合防火墙只放行本地子网。所有设备共享一个会话（chatKey 用户名 = `chatId`）。

## 公开 bot 的隔离模式

给外人用的 bot（例如 `qqbot.public: true`，任何人都能私聊）只能挂 `isolated: true` 的 profile：

```jsonc
"public": {
  "backend": "claude", "workspace": "workspace/public",
  "isolated": true, "tools": ["WebSearch", "WebFetch"], "maxTurns": 12,
  "systemPrompt": "You are a friendly general-purpose assistant..."
}
```

- `settingSources: []`：本机 Claude Code 的 skills / MCP / hooks / 插件 / CLAUDE.md 全部不加载。
- 只暴露 `tools` 白名单里的内置工具（`[]` = 纯对话）；权限模式固定 `default`，每次工具调用都经过 `src/backends/tool-guard.ts` 的 `canUseTool`：白名单外一律拒绝；**WebFetch 拦截本机和内网地址**（127.0.0.0/8、10/8、172.16/12、192.168/16、169.254/16、100.64/10、IPv6 本地 / ULA / v4 映射、`localhost`、`.local/.lan/.internal` 等、无点主机名、数字 / 十六进制 IP 写法）。只按 URL 字面判断，不查 DNS（fake-ip 代理下所有域名都解析到 198.18.x，查了等于全拦）；"公网域名解析到内网 IP"的 DNS rebinding 风险不覆盖。
- `systemPrompt` 整段替换 Claude Code 的预设；关闭自动记忆（大家共用一个 cwd，避免 A 的对话进 B 的记忆）。
- **启动校验**：只要 public bot 的 `profiles` 里有任何一个非 isolated 的 profile，网关就拒绝启动——否则陌生人 `/ctx use assistant` 就拿到了你机器上的 shell。
- 会话按用户隔离；建议配 `session.idleResetMinutes`。会话记录存在本机 `~/.claude/projects/` 下，管理员看得到，请告知用户。

## 管理面板

默认 **http://127.0.0.1:18790**（`panel` 段）：

- 渠道健康（最近轮询 / 入站计数 / 最近错误）、每个聊天的当前上下文、运行状态、排队数、各 profile 会话
- 操作：切换上下文、重置某个 profile 的会话、停止运行中任务、触发交接
- 日志尾部（读 `state/gateway.log`，3 秒刷新；用 `scripts/gateway.cmd` 启动时会写这个文件）
- API：`GET /api/state`、`GET /api/logs?lines=200`、`POST /api/action {botId, type, chatKey, profile?, note?, text?}`，`type` 为 `switch | reset | stop | handoff | inject | send`
  - `inject`：注入一条"用户消息"走正常队列（定时任务让 agent 干活）
  - `send`：不经过模型直接把文本发给用户（脚本产物已经是最终结果时，零 token）

面板端口同时是**单实例锁**：端口占用时进程直接退出，避免两个实例抢同一个 bot。

> ⚠️ **面板没有鉴权，能完全控制所有 bot**。保持只绑 127.0.0.1；要远程访问请走 SSH 隧道或 VPN。

## 长报告发布服务（publish）

聊天里只能显示纯文本，成篇的报告（表格、长目录）在里面全塌。做法：agent 把长内容写成 Markdown 存进工作区，聊天里只回结论摘要 + 一条链接。

```jsonc
"publish": {
  "enabled": true,
  "binds": ["127.0.0.1"],               // 只写确定地址，别写 0.0.0.0
  "port": 18792,
  "baseUrl": "https://reports.example.com",
  "title": "Home Agent Gate",
  "roots": { "notes": "workspace/assistant/output" },   // URL 首段 = key
  "publicDirs": ["public"],             // 经反向代理来的请求只能看这些一级子目录
  "linkOnlyDirs": []                    // 经反向代理只能按完整文件 URL 访问，不能列目录
}
```

- 写进 root 的文件立刻就有 URL，没有"发布"动作。`.md` 现渲染成 HTML（GFM 表格、h2/h3 锚点、长文折叠目录），`.html` 原样发送（适合自包含图表页），`?raw=1` 看源码，后缀可省略。目录页按修改时间倒序。
- 直接访问（loopback / 你绑的地址）能看到整棵树；带 `X-Real-IP` / `X-Forwarded-For` 的请求（即经过反向代理来的）只能看到 `<root>/<publicDirs>/**`，其余一律 404。
- Markdown 可能包含 agent 从网上抓来的第三方内容，渲染页走 `default-src 'none'` 的 CSP，并剥掉 script/iframe/object；只有 agent 自己写的 `.html` 放开内联脚本。
- 让 agent 用起来：在 persona 里写一条规则，例如"长报告写到 output/public/ 下，回复里给出 `<baseUrl>/notes/public/<文件名>` 链接"。

> ⚠️ **发布服务没有任何鉴权**。一旦用反向代理把它暴露到公网，`roots` 下 `publicDirs` 里的内容就等于公开，只靠"链接不好猜"挡人。挂目录前先想清楚整棵树里有什么，**绝不要把含密钥、私人数据的目录挂上去**。需要访问控制请在反向代理上加（Basic Auth、SSO 等）。

## Windows 常驻守护

`scripts/` 里的脚本都用相对路径定位仓库根，放哪都能用：

- `gateway.cmd` — 启动器：`cd` 到仓库根，`node --import tsx src/index.ts`，输出追加到 `state/gateway.log`（需要 `node` 在 PATH 里）
- `gateway-guard.ps1` — 判活：`state/gateway.pid` 进程存活 → 否则 TCP 探面板端口（`-PanelPort`，默认 18790）→ 都失败才拉起 `gateway.cmd`，记录到 `state/guard.log`
- `guard-hidden.vbs` — 用 wscript（无控制台的宿主）隐藏运行守护，避免计划任务每次弹黑框
- `restart-once.ps1` — 延迟 N 秒（让正在发的回复送达）后按 pid 杀进程树并重启

注册计划任务（登录时 + 每 5 分钟），在仓库根执行：

```powershell
$vbs = (Resolve-Path scripts\guard-hidden.vbs).Path
$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$vbs`""
$t1 = New-ScheduledTaskTrigger -AtLogOn
$t2 = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName "Home-Agent-Gate" -Action $action -Trigger $t1,$t2
```

改完代码重启：`powershell -File scripts\restart-once.ps1 -DelaySeconds 0`。按 pid 杀，不要按命令行特征找进程（别的 tsx 程序命令行可能一模一样）。

> ⚠️ **这些脚本必须保持纯 ASCII（注释也是）**：cmd.exe 按 OEM 代码页读 `.cmd`，非 ASCII 注释会被拆成乱码命令；计划任务用的 PowerShell 5.1 会把 UTF-8 无 BOM 脚本按 ANSI 解码，非 ASCII 字符会破坏解析且**静默失效**（PS7 里手动跑却一切正常，很难排查）。需要中文内容时放进独立的 UTF-8 文件再引用。

## 开发

```bash
pnpm typecheck
pnpm test        # vitest：假后端 + 假渠道，不调真模型
pnpm dev         # tsx watch
```

`state/`、`secrets/`、`workspace/`、`gateway.config.json` 都在 `.gitignore` 里。

## 已知边界

- 回复是整轮结束后一次性发送（微信不支持编辑消息）；进行中用输入状态提示。
- 微信出站只发文本；QQ 入站只取文本；都只接私聊。
- Codex 后端在 Windows 上经 `cmd` shim 启动，含空格的参数会加引号，但没有在所有 shell 下测过。

## 路线图

以下为设计阶段内容，当前 v0.1.0 尚未实现：

- **控制中心与任务看板**：人工任务、运行概览、可视化配置、固定操作、注册脚本与定时任务，支持无 LLM 使用。见 [控制中心设计](docs/control-center.md)。
- **通用工具与任务模板**：共享工具目录、部署绑定及挂载规则；LLM 按说明选择，服务端校验和执行。见 [工具与挂载设计](docs/tools-and-tasks.md)。
- **Router + 并行 Worker（即将加入）**：每个聊天一个用小模型的常驻调度员（Router），几秒内回话、负责派活和转述；真正干活的是每个任务一个的 Worker 会话，可同时跑多个，长任务进行中也能随时问别的问题，`/status` 能看到每个任务在干什么。

## License

[MIT](LICENSE) © zhang-dc
