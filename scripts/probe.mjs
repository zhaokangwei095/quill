/**
 * Calibrates the scanner against saved real application pages.
 *
 * The end-to-end suite proves Quill works on a form we wrote ourselves. That is
 * necessary but flattering: a synthetic fixture uses the markup we designed the
 * label recovery for. Real ATS pages use layouts nobody designed a standard
 * for — labels in bare `<div>`s, controls without ids, frameworks on top of
 * frameworks. This probe loads a saved page, injects the content script's own
 * scanner, and prints what it saw, so the gap is measured rather than guessed.
 *
 * Usage:
 *   node scripts/probe.mjs                      # every saved page in ../测试html
 *   node scripts/probe.mjs 百度招聘.html         # one page
 *   node scripts/probe.mjs --dir ../测试html --json
 *
 * The page is loaded with JavaScript disabled and re-enabled only to inject the
 * probe, so the DOM under test is the DOM that was saved. External requests are
 * aborted: these dumps came from logged-in sessions, and re-fetching their APIs
 * would either fail or replace the saved form with a login wall.
 */

import { build } from "esbuild";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, ".probe-build");
mkdirSync(outDir, { recursive: true });

/* ------------------------------------------------------------------- args */

const argv = process.argv.slice(2);
const jsonOutput = argv.includes("--json");
const dirFlag = argv.indexOf("--dir");
const pageDir = resolve(dirFlag >= 0 ? (argv[dirFlag + 1] ?? "") : join(root, "..", "测试html"));
const requested = argv.filter((arg, index) => !arg.startsWith("--") && (dirFlag < 0 || index !== dirFlag + 1));

if (!existsSync(pageDir) || !statSync(pageDir).isDirectory()) {
  console.error(`page directory not found: ${pageDir}`);
  process.exit(1);
}

const allPages = readdirSync(pageDir).filter((name) => /\.html?$/i.test(name));
const pages = requested.length > 0 ? requested.map((name) => normalize(name)) : allPages;
if (pages.length === 0) {
  console.error(`no .html/.htm files in ${pageDir}`);
  process.exit(1);
}

/* ----------------------------------------------------------------- bundle */

/*
 * The scanner imports `@quill/core` through source, so the entry has to be
 * bundled for the browser rather than run on Node. IIFE keeps the injected
 * script self-contained; a global export is how the runner reaches it.
 */
const bundlePath = join(outDir, "probe.iife.js");
await build({
  entryPoints: [join(root, "scripts", "probe-entry.ts")],
  outfile: bundlePath,
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "chrome116",
  sourcemap: false,
  logLevel: "warning",
  alias: { "@quill/core": join(root, "packages", "core", "src", "index.ts") },
});
const probeSource = readFileSync(bundlePath, "utf8");

/* ----------------------------------------------------------------- server */

const MIME = new Map([
  [".html", "text/html; charset=utf-8"],
  [".htm", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".otf", "font/otf"],
]);

const server = createServer((request, response) => {
  const raw = (request.url ?? "/").split("?")[0] ?? "/";
  let name;
  try {
    name = decodeURIComponent(raw).replace(/^\/+/, "");
  } catch {
    response.writeHead(400).end("bad request");
    return;
  }
  const path = resolve(pageDir, name);
  // Never serve outside the dump directory, even if the URL asks nicely.
  if (path !== pageDir && !path.startsWith(pageDir + sep)) {
    response.writeHead(403).end("forbidden");
    return;
  }
  if (!existsSync(path) || !statSync(path).isFile()) {
    response.writeHead(404).end("not found");
    return;
  }
  const type = MIME.get(extname(path).toLowerCase()) ?? "application/octet-stream";
  response.writeHead(200, { "content-type": type, "cache-control": "no-store" });
  response.end(readFileSync(path));
});

await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const address = server.address();
const port = typeof address === "object" && address ? address.port : 0;
const origin = `http://127.0.0.1:${port}`;

/* ----------------------------------------------------------------- chrome */

function findChrome() {
  const local = join(root, "chrome");
  if (existsSync(local)) {
    for (const name of readdirSync(local)) {
      const candidate = join(local, name, "chrome-win64", "chrome.exe");
      if (existsSync(candidate)) return candidate;
    }
  }
  for (const candidate of [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("no Chrome binary found; run `npm run browsers`");
}

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  protocolTimeout: 120_000,
});

/* --------------------------------------------------------------- scanning */

const reports = [];

for (const file of pages) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    const url = request.url();
    if (url.startsWith(origin) || url.startsWith("data:") || url.startsWith("blob:")) {
      void request.continue();
    } else {
      // External CDNs, analytics and session-checking APIs: not part of the dump.
      void request.abort();
    }
  });
  page.on("dialog", (dialog) => void dialog.dismiss());

  try {
    /*
     * Load the saved markup as-is. Saved pages frequently keep their bundle in
     * `*_files/`, and that bundle would re-render the app — often into a login
     * screen, because the session is gone. Disabling scripts for the navigation
     * preserves the snapshot, which is the thing we want to measure.
     */
    await page.setJavaScriptEnabled(false);
    await page.goto(`${origin}/${encodeURIComponent(file)}`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.setJavaScriptEnabled(true);
    await page.addScriptTag({ content: probeSource });
    const result = await page.evaluate(() => {
      const probe = window.__quillProbe;
      return probe ? probe() : null;
    });
    reports.push({ file, result });
  } catch (error) {
    reports.push({ file, result: null, error: error instanceof Error ? error.message : String(error) });
  } finally {
    await page.close();
  }
}

await browser.close();
server.close();

/* ---------------------------------------------------------------- report */

function percent(part, whole) {
  if (whole === 0) return "—";
  return `${((part / whole) * 100).toFixed(1)}%`;
}

function tally(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/** A one-line-per-page summary, then the details that need action. */
function printReport(report) {
  const { file, result, error } = report;
  if (!result) {
    console.log(`\n━━ ${file}\n   ✗ ${error ?? "probe returned nothing"}`);
    return;
  }

  const fields = result.fields;
  const classified = fields.filter((field) => field.key !== "unknown");
  const labelled = fields.filter((field) => field.label.trim() !== "");
  const sources = tally(fields.map((field) => field.labelSource));
  const keys = tally(classified.map((field) => field.key));
  const frameworks = tally(fields.map((field) => field.framework));
  const unknown = fields.filter((field) => field.key === "unknown");

  console.log(`\n━━ ${file}`);
  console.log(
    `   ${result.title || "(no title)"}  ·  ${result.siteKey}${result.ats ? `  ·  ${result.ats}` : ""}`,
  );
  console.log(`   岗位：${result.pageRole || "—"}    公司：${result.company || "—"}`);
  console.log(
    `   字段 ${fields.length}  ·  有标签 ${labelled.length} (${percent(labelled.length, fields.length)})  ·  已归类 ${classified.length} (${percent(classified.length, fields.length)})`,
  );
  console.log(`   标签来源：${sources.map(([name, count]) => `${name} ${count}`).join("  ")}`);
  console.log(`   控件框架：${frameworks.map(([name, count]) => `${name} ${count}`).join("  ")}`);
  console.log(`   主要归类：${keys.slice(0, 12).map(([name, count]) => `${name} ${count}`).join("  ")}`);

  if (unknown.length > 0) {
    console.log(`   未归类 ${unknown.length}：`);
    for (const field of unknown.slice(0, 15)) {
      const identity = field.label || field.placeholder || field.name || field.hint || "(无文本)";
      const extra = field.name && field.name !== identity ? ` name=${field.name}` : "";
      console.log(`     · [${field.kind}/${field.labelSource}] ${identity}${extra}`);
    }
    if (unknown.length > 15) console.log(`     … 另有 ${unknown.length - 15} 个`);
  }
}

if (jsonOutput) {
  console.log(JSON.stringify(reports, null, 2));
} else {
  for (const report of reports) printReport(report);
  const ok = reports.filter((report) => report.result).length;
  const failed = reports.filter((report) => !report.result).length;
  console.log(`\n完成：${ok} 页成功${failed > 0 ? `，${failed} 页失败` : ""}`);
}

process.exit(reports.some((report) => !report.result) ? 1 : 0);
