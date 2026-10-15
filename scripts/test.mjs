/**
 * Runs the core test suite.
 *
 * The tests are plain TypeScript importing `@quill/core` through its source
 * entry. We bundle with esbuild and hand the result to Node's test runner so
 * there is no separate build step to keep in sync.
 */

import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testDir = join(root, "test");
const outDir = join(root, ".test-build");
mkdirSync(outDir, { recursive: true });

const filter = process.argv[2];
const files = readdirSync(testDir)
  .filter((name) => name.endsWith(".test.ts"))
  .filter((name) => !filter || name.includes(filter));

if (files.length === 0) {
  console.error(`no test files matched${filter ? ` "${filter}"` : ""}`);
  process.exit(1);
}

const outputs = [];
for (const file of files) {
  const outfile = join(outDir, file.replace(/\.ts$/, ".mjs"));
  await build({
    entryPoints: [join(testDir, file)],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    sourcemap: "inline",
    logLevel: "warning",
    alias: { "@quill/core": join(root, "packages/core/src/index.ts") },
  });
  outputs.push(outfile);
}

const child = spawn(process.execPath, ["--test", ...outputs], {
  stdio: "inherit",
  cwd: root,
});
child.on("exit", (code) => process.exit(code ?? 1));
