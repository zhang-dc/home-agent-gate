/**
 * Scan-to-login for the Weixin ilink bot channel.
 *
 *   pnpm login:weixin                          # writes secrets/weixin.json
 *   pnpm login:weixin --out secrets/mybot.json
 *
 * The file ({ token, baseUrl, userId, savedAt }) is what a weixin bot's
 * `tokenFile` points at. userId is the person who scanned; it becomes the
 * bot's default allowFrom.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";

import qrcode from "qrcode-terminal";

import { gatewayRoot } from "../config.js";
import { loginWithQr } from "../channels/weixin/login.js";

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const out = path.resolve(gatewayRoot, argValue("--out") ?? "secrets/weixin.json");

let existingToken: string | undefined;
try {
  existingToken = (JSON.parse(fs.readFileSync(out, "utf-8")) as { token?: string }).token;
} catch {
  // no existing file
}

try {
  const result = await loginWithQr(
    {
      showQr(qrUrl) {
        console.log("\nScan this QR code with WeChat on your phone:\n");
        qrcode.generate(qrUrl, { small: true });
        console.log(`\nIf the QR code does not render, open this link instead:\n${qrUrl}\n`);
      },
      async askVerifyCode(retry) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const code = await rl.question(retry ? "Wrong number, try again: " : "Enter the number shown on your phone: ");
        rl.close();
        return code.trim();
      },
      info: (msg) => console.log(msg),
    },
    { localTokens: existingToken ? [existingToken] : [] },
  );

  if (result === "already-bound") {
    console.log(`\nThis bot is already bound; the token in ${out} remains valid.`);
  } else {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const data = { token: result.token, savedAt: new Date().toISOString(), baseUrl: result.baseUrl, userId: result.userId };
    fs.writeFileSync(out, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
    console.log(`\nLogged in (bot ${result.botId}). Credentials saved to ${out}`);
    console.log("Point a weixin bot's tokenFile at this file in gateway.config.json.");
  }
  process.exit(0);
} catch (err) {
  console.error(`login failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
