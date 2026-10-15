/**
 * Captures the in-page panel on its own, cropped to its bounding box.
 *
 * This exists because the panel is what most people will see most of the time,
 * and evaluating its typography inside a full-page screenshot of a form is
 * impossible. Run `npm run build:extension` first.
 *
 * Usage: node scripts/pipe-screenshot.mjs
 */

import { createServer } from "node:http";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import puppeteer from "puppeteer-core";
import { parseResume } from "@quill/core";

/*
 * Resolve paths from the working directory, not from `import.meta.url`.
 *
 * This file is bundled before it runs, so `import.meta.url` points at the bundle
 * in the repository root rather than at `scripts/`, and `..` from there is the
 * wrong directory. Every invocation goes through `npm run`, which sets the cwd to
 * the package root.
 */
const root = resolve(process.cwd());
const dist = join(root, "extension", "dist");
const outDir = join(root, ".shots");

/** A resume comparable to what the test suite uses. */
const RESUME = `
周子墨
男 | 汉族 | 中共党员 | 1999.05 | 籍贯：湖北武汉
手机：13600001111    邮箱：zhouzimo@example.com
现居：深圳市南山区    微信：zimo_dev

求职意向
意向岗位：后端开发工程师    意向城市：深圳、广州
期望薪资：28-38万/年        到岗时间：2026年7月

教育经历
华中科技大学 计算机科学与技术 本科 2017.09 - 2021.06
GPA 3.7/4.0，专业排名 6/140

实习经历
腾讯科技（深圳）有限公司 | 后端开发工程师 | 深圳 | 2021.07 - 2024.03
• 负责支付对账系统的重构，日均处理 5000 万笔交易
• 主导将核心服务拆分为微服务，接口平均延迟从 200ms 降到 60ms

专业技能
编程语言：Go、Java、Python
框架与中间件：Kafka、Redis、MySQL、Kubernetes

自我评价
喜欢把复杂的系统拆成可以被验证的小块，对性能问题有耐心，也会主动把结论写成文档分享给团队。
`;

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
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("no Chrome binary found; run `npm run browsers`");
}

const formHtml = readFileSync(join(root, "test", "fixtures", "apply-form.html"));
const server = createServer((request, response) => {
  if ((request.url ?? "").startsWith("/favicon")) {
    response.writeHead(204).end();
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(formHtml);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
const port = typeof address === "object" && address ? address.port : 0;

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  userDataDir: join(root, ".pipe-profile"),
  args: [
    "--no-sandbox",
    "--no-first-run",
    "--no-default-browser-check",
    `--disable-extensions-except=${dist}`,
    `--load-extension=${dist}`,
  ],
});

const cdp = await browser.target().createCDPSession();
let extensionId;
try {
  extensionId = (await cdp.send("Extensions.loadUnpacked", { path: dist })).id;
} catch {
  // Loaded from the command line.
}
for (let attempt = 0; attempt < 30 && !extensionId; attempt += 1) {
  const worker = browser
    .targets()
    .find((target) => target.type() === "service_worker" && target.url().startsWith("chrome-extension://"));
  if (worker) extensionId = new URL(worker.url()).host;
  else await new Promise((wait) => setTimeout(wait, 250));
}
if (!extensionId) throw new Error("extension did not load");

// Seed the profile from an extension page: `chrome.storage` is not reachable from
// a normal tab's main world.
const { profile } = parseResume(RESUME, { profileId: "profile-1" });
const { targetId } = await cdp.send("Target.createTarget", {
  url: `chrome-extension://${extensionId}/pages/welcome.html`,
});
const seeder = await (await browser.waitForTarget((target) => target._targetId === targetId)).page();
if (!seeder) throw new Error("could not open the seeder page");
await seeder.waitForFunction(() => Boolean(globalThis.chrome), { timeout: 15_000 });
await seeder.evaluate(async (seed) => {
  await chrome.storage.local.set({ "quill.profile": seed, "quill.memory": [] });
}, profile);
await seeder.close();

const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 940 });
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(
  () => Boolean(document.querySelector("quill-panel")?.shadowRoot?.textContent?.includes("个字段")),
  { timeout: 25_000 },
);
await new Promise((wait) => setTimeout(wait, 2500));

const info = await page.evaluate(() => {
  const root = document.querySelector("quill-panel")?.shadowRoot;
  const panel = root?.querySelector(".q-panel");
  if (!panel) return null;
  const rect = panel.getBoundingClientRect();
  return {
    box: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    hero: root?.querySelector(".q-hero-label")?.textContent?.trim() ?? "",
    button: root?.querySelector(".q-cta")?.textContent?.trim() ?? "",
  };
});

console.log(`hero:   ${info?.hero}`);
console.log(`button: ${info?.button}`);
console.log(`box:    ${JSON.stringify(info?.box)}`);

mkdirSync(outDir, { recursive: true });
if (info?.box) {
  /*
   * Capture the viewport, not a clip.
   *
   * The panel lives in a shadow root on a `position: fixed` host, and a clipped
   * capture of that region comes back as the page *underneath* the panel — Chrome
   * does not composite the shadow content into a clipped shot reliably. The
   * viewport capture renders it correctly, and the panel's position is printed
   * above so the region of interest is unambiguous.
   */
  await page.screenshot({ path: join(outDir, "panel.png"), captureBeyondViewport: false });
  console.log(`wrote ${join(outDir, "panel.png")} (full viewport; panel at ${JSON.stringify(info.box)})`);
}

await browser.close();
await new Promise((done) => server.close(done));
