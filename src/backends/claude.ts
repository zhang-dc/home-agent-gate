import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";

import type { ReasoningBackend, TurnRequest, TurnResult } from "../core/backend.js";
import { createLogger } from "../util/logger.js";
import { makeIsolatedToolGuard } from "./tool-guard.js";

export interface ClaudeBackendConfig {
  /** Working directory the agent operates in (its context root). */
  workspace: string;
  /** Persona appended to the Claude Code preset system prompt. */
  persona?: string;
  /** Model override; omit to use the CLI default. */
  model?: string;
  maxTurns?: number;
  /** Tools stripped from the model's context (never callable). */
  disallowedTools?: string[];
  /**
   * Permission mode. The gateway runs headless, so 'bypassPermissions'
   * is the practical default for a personal assistant on your own machine.
   */
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "dontAsk";
  /** Isolated mode, see ProfileSchema.isolated in config.ts. */
  isolated?: boolean;
  tools?: string[];
  systemPrompt?: string;
}

/**
 * Reasoning backend on top of the Claude Agent SDK. Each turn is one
 * query() call resumed from the previous session id; Claude Code owns
 * context management (compaction, CLAUDE.md, skills, memory).
 */
export class ClaudeBackend implements ReasoningBackend {
  readonly id = "claude";
  private log = createLogger("claude");

  constructor(private cfg: ClaudeBackendConfig) {}

  async runTurn(req: TurnRequest): Promise<TurnResult> {
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    req.abortSignal?.addEventListener("abort", onAbort, { once: true });

    const options: Options = {
      cwd: this.cfg.workspace,
      ...(this.cfg.isolated ? this.isolatedOptions() : this.fullOptions()),
      abortController,
      maxTurns: this.cfg.maxTurns ?? 200,
      ...(this.cfg.disallowedTools?.length ? { disallowedTools: this.cfg.disallowedTools } : {}),
      ...(this.cfg.model ? { model: this.cfg.model } : {}),
      ...(req.sessionId ? { resume: req.sessionId } : {}),
      stderr: (data) => this.log.debug(`stderr: ${data.trimEnd()}`),
      env: {
        ...process.env,
        CLAUDE_AGENT_SDK_CLIENT_APP: "home-agent-gate/0.1.0",
        // Everyone on a public bot shares one cwd: auto-memory would carry user A's chat into user B's.
        ...(this.cfg.isolated ? { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" } : {}),
      },
    };

    let sessionId = req.sessionId;
    let resultText = "";
    let isError = false;
    let costUsd: number | undefined;
    let numTurns: number | undefined;

    try {
      for await (const message of query({ prompt: req.prompt, options })) {
        if (message.type === "system" && message.subtype === "init") {
          sessionId = message.session_id;
          this.log.debug(`init: session=${message.session_id} model=${message.model}`);
        } else if (message.type === "result") {
          sessionId = message.session_id;
          costUsd = message.total_cost_usd;
          numTurns = message.num_turns;
          if (message.subtype === "success") {
            resultText = message.result;
            isError = message.is_error;
          } else {
            isError = true;
            resultText =
              message.subtype === "error_max_turns"
                ? "任务太长，达到最大轮数上限，先停在这里。"
                : message.errors?.join("\n") || `执行出错 (${message.subtype})`;
          }
        }
      }
    } finally {
      req.abortSignal?.removeEventListener("abort", onAbort);
    }

    return { text: resultText, sessionId, isError, costUsd, numTurns };
  }

  /** Personal assistant: the full local Claude Code setup and tools, under the profile's permission mode. */
  private fullOptions(): Partial<Options> {
    const permissionMode = this.cfg.permissionMode ?? "bypassPermissions";
    return {
      permissionMode,
      ...(permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
      systemPrompt: this.cfg.persona
        ? { type: "preset", preset: "claude_code", append: this.cfg.persona }
        : { type: "preset", preset: "claude_code" },
      settingSources: ["user", "project", "local"],
    };
  }

  /**
   * 纯净模式：不读本机任何配置（skills/MCP/hooks/插件/CLAUDE.md），只暴露白名单工具，
   * 每次调用过 canUseTool 守卫。权限模式必须是 default —— bypass 会跳过 canUseTool。
   */
  private isolatedOptions(): Partial<Options> {
    const tools = this.cfg.tools ?? [];
    return {
      permissionMode: "default",
      settingSources: [],
      tools,
      skills: [],
      mcpServers: {},
      canUseTool: makeIsolatedToolGuard(tools),
      systemPrompt: this.cfg.systemPrompt ?? "You are Claude, an AI assistant made by Anthropic.",
    };
  }
}
