import { spawn, spawnSync } from "node:child_process";

import type { ReasoningBackend, TurnRequest, TurnResult } from "../core/backend.js";
import { createLogger } from "../util/logger.js";

export interface CodexBackendConfig {
  workspace: string;
  /** Injected as a <persona> block on the first turn of each session. */
  persona?: string;
  model?: string;
  /**
   * true (default): --dangerously-bypass-approvals-and-sandbox — headless
   * personal-machine parity with the Claude backend's bypassPermissions.
   * false: run with `sandbox` mode and default approvals.
   */
  dangerouslyBypass?: boolean;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  turnTimeoutMinutes?: number;
}

interface CodexEvent {
  type?: string;
  thread_id?: string;
  item?: { type?: string; text?: string };
  message?: string;
  error?: { message?: string };
}

/**
 * Reasoning backend on top of the Codex CLI (`codex exec` / `codex exec
 * resume <id>`), events parsed from --json JSONL. The prompt is piped via
 * stdin ("-") so no shell escaping is needed.
 */
export class CodexBackend implements ReasoningBackend {
  readonly id = "codex";
  private log = createLogger("codex");

  constructor(private cfg: CodexBackendConfig) {}

  async runTurn(req: TurnRequest): Promise<TurnResult> {
    const args = ["exec"];
    if (req.sessionId) args.push("resume", req.sessionId);
    args.push("--json", "--skip-git-repo-check", "--color", "never");
    if (!req.sessionId) args.push("-C", this.cfg.workspace);
    for (const image of req.images ?? []) args.push("-i", image);
    if (this.cfg.model) args.push("-m", this.cfg.model);
    if (this.cfg.dangerouslyBypass !== false) {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    } else if (!req.sessionId && this.cfg.sandbox) {
      args.push("-s", this.cfg.sandbox);
    }
    args.push("-");

    const prompt =
      !req.sessionId && this.cfg.persona
        ? `<persona>\n${this.cfg.persona}\n</persona>\n\n${req.prompt}`
        : req.prompt;

    this.log.debug(`spawn: codex ${args.join(" ")}`);
    // On Windows shell:true lets the codex.cmd shim resolve; the prompt goes
    // through stdin, so only flags / ids / paths are on the command line.
    const isWin = process.platform === "win32";
    const child = spawn("codex", isWin ? args.map(quoteWinArg) : args, {
      shell: isWin,
      windowsHide: true,
      cwd: this.cfg.workspace,
    });
    child.stdin.write(prompt, "utf-8");
    child.stdin.end();

    let sessionId = req.sessionId;
    const agentMessages: string[] = [];
    let errorText = "";
    let stderrTail = "";
    let killed: "abort" | "timeout" | undefined;

    const killTree = (reason: "abort" | "timeout") => {
      killed = reason;
      if (!child.pid) return;
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      } else {
        child.kill("SIGTERM");
      }
    };
    const onAbort = () => killTree("abort");
    req.abortSignal?.addEventListener("abort", onAbort, { once: true });
    const timeoutMs = (this.cfg.turnTimeoutMinutes ?? 30) * 60_000;
    const timer = setTimeout(() => killTree("timeout"), timeoutMs);

    let stdoutBuf = "";
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuf += chunk;
      let nl: number;
      while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line.startsWith("{")) continue;
        try {
          const event = JSON.parse(line) as CodexEvent;
          if (event.type === "thread.started" && event.thread_id) {
            sessionId = event.thread_id;
            this.log.debug(`thread started: ${event.thread_id}`);
          } else if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text) {
            agentMessages.push(event.item.text);
          } else if (event.type === "turn.failed" || event.type === "error") {
            errorText = event.error?.message ?? event.message ?? "codex turn failed";
          }
        } catch {
          // Non-JSON stdout noise — ignore.
        }
      }
    });
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2000);
    });

    const exitCode: number | null = await new Promise((resolve) => {
      child.on("close", (code) => resolve(code));
      child.on("error", (err) => {
        errorText = `failed to spawn codex: ${String(err)}`;
        resolve(-1);
      });
    });
    clearTimeout(timer);
    req.abortSignal?.removeEventListener("abort", onAbort);

    if (killed === "abort") throw new Error("aborted");

    const text = agentMessages.length ? agentMessages[agentMessages.length - 1]! : "";
    if (killed === "timeout") {
      return { text: "任务超时，已终止。", sessionId, isError: true };
    }
    if (errorText || exitCode !== 0 || !text) {
      const detail = errorText || stderrTail.trim().split("\n").slice(-3).join("\n") || `exit code ${exitCode}`;
      return { text: detail, sessionId, isError: true };
    }
    return { text, sessionId, isError: false, numTurns: 1 };
  }
}

/** Quote an argument for cmd.exe when it contains spaces (paths). */
function quoteWinArg(arg: string): string {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}
