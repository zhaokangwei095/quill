/**
 * Bundles and runs `scripts/pipe-screenshot.mjs`, which captures the in-page
 * panel. Separate from the script itself because the script imports
 * `@quill/core` through source and must be bundled before Node can run it.
 *
 * Usage: npm run shot   (run `npm run build:extension` first)
 */

import { build } from "esbuild";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(root, ".pipe.mjs");

await build({
  entryPoints: [join(root, "scripts", "pipe-screenshot.mjs")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  logLevel: "warning",
  external: ["puppeteer-core"],
  alias: { "@quill/core": join(root, "packages", "core", "src", "index.ts") },
});

const child = spawn(process.execPath, [outfile], { stdio: "inherit", cwd: root });
child.on("exit", (code) => process.exit(code ?? 1));
