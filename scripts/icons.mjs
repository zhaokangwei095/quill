/**
 * Renders the extension's PNG icons from `assets/mark.svg`.
 *
 * Chrome requires raster icons in the manifest, and hand-drawn pixel art at
 * 16px is worse than a downscaled vector. Headless Chrome does the
 * rasterisation, so the shapes stay identical at every size.
 *
 * Usage: node scripts/icons.mjs
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assets = join(root, "extension/assets");
const svg = readFileSync(join(assets, "mark.svg"), "utf8");
const sizes = [16, 32, 48, 128];

const chromeCandidates = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

const chrome = chromeCandidates.find((candidate) => existsSync(candidate));
if (!chrome) {
  console.error("Chrome not found. Install Chrome, or add PNGs to extension/assets by hand.");
  process.exit(1);
}

mkdirSync(assets, { recursive: true });
const work = join(root, ".icon-work");
mkdirSync(work, { recursive: true });

for (const size of sizes) {
  /*
   * The icon must fill the canvas exactly. Chrome's `--screenshot` captures the
   * viewport, so the page is sized to the icon and the SVG is stretched to the
   * body with no margin.
   */
  const html = `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;width:${size}px;height:${size}px;overflow:hidden;background:transparent}
    svg{display:block;width:${size}px;height:${size}px}
  </style>${svg}`;
  const page = join(work, `icon-${size}.html`);
  writeFileSync(page, html);

  const shot = join(work, `shot-${size}.png`);
  await run(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--default-background-color=00000000",
    `--window-size=${size},${size}`,
    `--screenshot=${shot}`,
    `file:///${page.replace(/\\/g, "/")}`,
  ], { timeout: 60_000 });

  const target = join(assets, `icon-${size}.png`);
  renameSync(shot, target);
  console.log(`icon-${size}.png`);
}

rmSync(work, { recursive: true, force: true });
console.log(`icons → ${assets}`);
