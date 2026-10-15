/**
 * Runs the browser end-to-end suite.
 *
 * The test itself lives in `test/e2e.ts` so it can import `@quill/core` through
 * source; this wrapper bundles it and then runs it on Node. The bundle must be
 * CJS-compatible with puppeteer-core, so it is marked external.
 *
 * Usage: node scripts/e2e.mjs [--keep-open] [--screenshot <file>]
 */

import { build } from "esbuild";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, ".e2e-build");
mkdirSync(outDir, { recursive: true });

const outfile = join(outDir, "e2e.mjs");
await build({
  entryPoints: [join(root, "test/e2e.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: "inline",
  logLevel: "warning",
  // Keep puppeteer external: bundling it breaks its own dynamic requires.
  external: ["puppeteer-core"],
  alias: { "@quill/core": join(root, "packages/core/src/index.ts") },
});

const child = spawn(process.execPath, [outfile, ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: root,
});
child.on("exit", (code) => process.exit(code ?? 1));
