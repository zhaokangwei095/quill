/**
 * Downloads Chrome for Testing into `chrome/`.
 *
 * Chrome for Testing is required for the end-to-end suite: branded Google Chrome
 * refuses `--load-extension` by policy, so content scripts never run and the
 * extension cannot be loaded at all. This script exists so the download is one
 * command and the destination is predictable for `test/e2e.ts`.
 *
 * Usage: npm run browsers
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "chrome");

const alreadyInstalled = existsSync(target) && readdirSync(target).some((name) => name.startsWith("win64-"));
if (alreadyInstalled && !process.argv.includes("--force")) {
  console.log(`Chrome for Testing is already present in ${target}`);
  console.log("Pass --force to download again.");
  process.exit(0);
}

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const child = spawn(
  npx,
  ["--yes", "@puppeteer/browsers", "install", "chrome@stable", `--path=${target}`],
  { stdio: "inherit", cwd: root, shell: process.platform === "win32" },
);
child.on("exit", (code) => {
  if (code === 0) console.log(`\nChrome for Testing installed under ${target}`);
  process.exit(code ?? 1);
});
