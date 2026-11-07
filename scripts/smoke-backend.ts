/**
 * Smoke test for one profile's backend, no channel involved: run a turn, then
 * resume the same session and check the model remembers.
 *
 *   pnpm smoke                # uses the first profile in gateway.config.json
 *   pnpm smoke assistant      # a specific profile
 */
import fs from "node:fs";

import { ClaudeBackend } from "../src/backends/claude.js";
import { CodexBackend } from "../src/backends/codex.js";
import { EchoBackend } from "../src/backends/echo.js";
import { loadConfig } from "../src/config.js";
import type { ReasoningBackend } from "../src/core/backend.js";

const config = loadConfig();
const name = process.argv[2] ?? Object.keys(config.profiles)[0];
const profile = name ? config.profiles[name] : undefined;
if (!name || !profile) {
  console.error(`unknown profile: ${name ?? "(none)"}`);
  process.exit(1);
}
fs.mkdirSync(profile.workspace, { recursive: true });

const backend: ReasoningBackend =
  profile.backend === "echo"
    ? new EchoBackend()
    : profile.backend === "codex"
      ? new CodexBackend({ workspace: profile.workspace, persona: profile.persona, model: profile.model })
      : new ClaudeBackend({
          workspace: profile.workspace,
          persona: profile.persona,
          model: profile.model,
          permissionMode: profile.permissionMode,
          isolated: profile.isolated,
          tools: profile.tools,
          systemPrompt: profile.systemPrompt,
        });

console.log(`profile "${name}" (${backend.id}) turn 1...`);
const r1 = await backend.runTurn({ prompt: "Remember the code word 'blue-heron'. Reply with one short sentence." });
console.log({ isError: r1.isError, sessionId: r1.sessionId, costUsd: r1.costUsd });
console.log(r1.text);

console.log("\nturn 2 (resume)...");
const r2 = await backend.runTurn({ prompt: "What is the code word? Reply with the word only.", sessionId: r1.sessionId });
console.log({ isError: r2.isError, sessionId: r2.sessionId, costUsd: r2.costUsd });
console.log(r2.text);
