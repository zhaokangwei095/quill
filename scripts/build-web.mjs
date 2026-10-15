/**
 * Builds the workbench in whichever shape is needed.
 *
 *   node scripts/build-web.mjs            → web/dist, a standalone site
 *   node scripts/build-web.mjs extension  → extension/dist/pages/workbench.html
 *
 * Vite emits one HTML entry per build, and the extension needs that entry to be
 * called `workbench.html` (the manifest and the popup both link to that name),
 * so the extension variant is renamed here rather than duplicating the HTML.
 */

import { spawn } from "node:child_process";
import { existsSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const forExtension = process.argv[2] === "extension";
const vite = join(root, "node_modules", ".bin", process.platform === "win32" ? "vite.cmd" : "vite");

const child = spawn(vite, ["build", ...(forExtension ? ["--mode", "extension"] : [])], {
  cwd: join(root, "web"),
  stdio: "inherit",
  shell: process.platform === "win32",
});

child.on("exit", (code) => {
  if (code !== 0) process.exit(code ?? 1);
  if (!forExtension) return;

  // Vite names the entry after its source file; the manifest expects
  // `workbench.html`, so rename rather than keeping two copies in sync.
  const pages = join(root, "extension", "dist", "pages");
  const from = join(pages, "index.html");
  const to = join(pages, "workbench.html");
  if (existsSync(from)) {
    rmSync(to, { force: true });
    renameSync(from, to);
    console.log("renamed index.html → workbench.html");
  } else {
    console.error(`expected ${from} to exist after the extension build`);
    process.exit(1);
  }
});
