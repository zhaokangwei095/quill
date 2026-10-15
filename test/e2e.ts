/**
 * End-to-end check: load the built extension into a real Chrome, open the
 * fixture application form, drive the panel, and assert what landed in the page.
 *
 * This is the only test that can prove the product works, because every hard
 * part of it — label recovery, classification on a real DOM, the native setter
 * trick, the shadow root, the service-worker round trip — is invisible to unit
 * tests. It runs headless against `extension/dist`, so it also catches packaging
 * mistakes such as a missing asset.
 *
 * Usage: node scripts/e2e.mjs [--keep-open] [--screenshot <file>]
 */

import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import puppeteer from "puppeteer-core";
import { parseResume } from "@quill/core";

/**
 * A tiny static server for the fixture.
 *
 * The fixture must be served over HTTP, not `file://`: content scripts do not
 * run on `file://` URLs unless the extension explicitly asks for file access,
 * and granting that in the manifest would be a real security trade-off made
 * only to satisfy a test.
 */
async function startFixtureServer(): Promise<{ server: Server; origin: string }> {
  const server = createServer(async (request, response) => {
    const path = (request.url ?? "/").split("?")[0] ?? "/";
    /*
     * Browsers request `/favicon.ico` unprompted and log a 404 to the console as
     * an error. Answering it with 204 keeps the fixture honest and stops the
     * test's "no console errors" check from failing on browser boilerplate.
     */
    if (path === "/favicon.ico") {
      response.writeHead(204).end();
      return;
    }
    const file = path === "/" || path === "/apply" ? "apply-form.html" : path.replace(/^\//, "");
    try {
      const body = await readFile(join(root, "test", "fixtures", file));
      response.writeHead(200, {
        "content-type": file.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream",
        "cache-control": "no-store",
      });
      response.end(body);
    } catch {
      response.writeHead(404).end("not found");
    }
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, origin: `http://127.0.0.1:${port}` };
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "extension", "dist");
const profileDir = join(root, ".e2e-profile");
const keepOpen = process.argv.includes("--keep-open");
const screenshotAt = process.argv.indexOf("--screenshot");
const screenshotFile = screenshotAt >= 0 ? process.argv[screenshotAt + 1] : undefined;

/**
 * Chrome for Testing is preferred and must be used if present.
 *
 * Google Chrome (branded) refuses `--disable-extensions-except` and
 * `--load-extension` by policy — it logs "is not allowed in Google Chrome,
 * ignoring" and loads nothing — and it also blocks `chrome-extension://`
 * navigation from an automated tab. Chrome for Testing is the build Google
 * ships exactly for this purpose and has neither restriction. `npm run
 * browsers` downloads it into the repo.
 */
const CHROME_CANDIDATES = [
  ...(existsSync(join(root, "chrome"))
    ? readdirSync(join(root, "chrome"))
        .filter((name) => name.startsWith("win64-"))
        .map((name) => join(root, "chrome", name, "chrome-win64", "chrome.exe"))
    : []),
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

const chrome = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
if (!chrome) {
  console.error("Chrome not found; cannot run the end-to-end test.");
  process.exit(1);
}
const isChromeForTesting = chrome.includes(`${sep}chrome${sep}`) || /chrome-win64|chrome-linux64|Chrome for Testing/.test(chrome);
console.log(`  · using ${isChromeForTesting ? "Chrome for Testing" : "Google Chrome"}: ${chrome}`);
if (!isChromeForTesting) {
  console.log("  ! branded Chrome blocks --load-extension and extension navigation;");
  console.log("  ! run `npm run browsers` to fetch Chrome for Testing for a real result.");
}
if (!existsSync(join(dist, "manifest.json"))) {
  console.error("extension/dist is missing. Run `npm run build:ext` first.");
  process.exit(1);
}

/* --------------------------------------------------------------- fixtures */

/**
 * The profile that the test resumes to, mirroring what a real upload produces.
 * Built through the real parser so the test fails if the parser regresses.
 */
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
证书：CET-6 (562)

自我评价
喜欢把复杂的系统拆成可以被验证的小块，对性能问题有耐心。
`;

/* ----------------------------------------------------------------- runner */

rmSync(profileDir, { recursive: true, force: true });
mkdirSync(profileDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  userDataDir: profileDir,
  /*
   * Screenshotting several full-page views in sequence takes longer than the
   * default CDP timeout allows, and the failure mode is an opaque
   * "Page.captureScreenshot timed out". A generous protocol timeout removes the
   * flake without hiding a real hang, which would still fail on the check itself.
   */
  protocolTimeout: 180_000,
  args: [
    // Required for Chrome for Testing on Windows in some sandboxes; harmless
    // elsewhere and it is the difference between launching and not.
    "--no-sandbox",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1440,900",
    /*
     * Content scripts and the extension itself must be loaded from the built
     * directory. `--disable-extensions-except` keeps a developer's other
     * extensions out of the run, which would otherwise change results.
     */
    `--disable-extensions-except=${dist}`,
    `--load-extension=${dist}`,
  ],
});

/*
 * Resolve the generated extension id. Chrome records loaded unpacked
 * extensions in `chrome://extensions`; the id is also derivable from the
 * service-worker URL once the worker exists. Loading over CDP is attempted as
 * well, because it succeeds even when the command-line switch is ignored, and
 * it reports the id directly.
 */
const cdp = await browser.target().createCDPSession();
let extensionId: string | undefined;
try {
  const loaded = (await cdp.send("Extensions.loadUnpacked", { path: dist })) as { id: string };
  extensionId = loaded.id;
} catch {
  // Already loaded via the command line, or the API is unavailable.
}
if (!extensionId) {
  for (let attempt = 0; attempt < 30 && !extensionId; attempt += 1) {
    const worker = browser
      .targets()
      .find((target) => target.type() === "service_worker" && target.url().startsWith("chrome-extension://"));
    if (worker) extensionId = new URL(worker.url()).host;
    else await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
}

/** Wait for a target matching `predicate`, polling because CDP has no event we can await cheaply. */
async function waitForTarget<T>(
  predicate: (target: Awaited<ReturnType<typeof browser.targets>>[number]) => boolean,
  timeoutMs = 15_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (browser.targets().some(predicate)) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  return false;
}

let fixtureServer: Server | undefined;

const failures = [];
const check = (condition, message, detail) => {
  if (condition) {
    console.log(`  ✓ ${message}`);
  } else {
    console.log(`  ✗ ${message}${detail ? `\n      ${detail}` : ""}`);
    failures.push(message);
  }
};

try {
  /* ------------------------------------------------------- worker target */

  check(Boolean(extensionId), "extension loaded", `id=${extensionId}`);
  if (!extensionId) throw new Error("cannot continue without an extension id");

  /*
   * The MV3 worker is lazy: it does not exist until something wakes it.
   *
   * Extension URLs cannot be reached by navigating a normal tab (Chrome blocks
   * it as a cross-scheme navigation), so pages are created through
   * `Target.createTarget` instead, which is how the browser itself opens them.
   */
  async function openExtensionPage(path: string): Promise<puppeteer.Page> {
    const { targetId } = (await cdp.send("Target.createTarget", {
      url: `chrome-extension://${extensionId}/${path}`,
    })) as { targetId: string };
    const target = await browser.waitForTarget((candidate) => candidate._targetId === targetId, { timeout: 15_000 });
    const created = await target.page();
    if (!created) throw new Error(`could not open extension page ${path}`);
    return created;
  }

  const warmupAppeared = await waitForTarget(
    (target) => target.type() === "service_worker" && target.url().startsWith(`chrome-extension://${extensionId}`),
    8_000,
  );
  check(warmupAppeared, "service worker target is observable");

  /* --------------------------------------------------------- seed profile */

  /*
   * Seeding goes through the real parse path, then straight into
   * `chrome.storage.local` via the worker, which is what the popup's own
   * import would do.
   */
  const { profile } = parseResume(RESUME, { profileId: "profile-1" });
  const seeder = await openExtensionPage("pages/welcome.html");
  await seeder.waitForFunction(() => Boolean(globalThis.chrome?.storage), { timeout: 15_000 });
  await seeder.evaluate(async (seedProfile) => {
    await chrome.storage.local.set({ "quill.profile": seedProfile, "quill.memory": [] });
  }, profile);
  await seeder.close();
  console.log(`  · seeded profile: ${profile.identity.fullName} / ${profile.contact.phone}`);

  /* ------------------------------------------------------ open the form */

  const started = await startFixtureServer();
  fixtureServer = started.server;
  const origin = started.origin;
  const formUrl = `${origin}/apply`;
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text());
  });

  await page.goto(formUrl, { waitUntil: "domcontentloaded" });
  // The content script mounts a custom element; wait for it rather than sleeping.
  await page.waitForFunction(() => Boolean(document.querySelector("quill-panel")), { timeout: 15_000 });
  check(true, "content script mounted the panel host");

  /* ------------------------------------------------------------ the panel */

  /*
   * The test drives the real panel DOM inside the shadow root, not the message
   * protocol directly. Two reasons: `chrome.*` is only available in the content
   * script's isolated world (a `page.evaluate` in the main world cannot see it),
   * and clicking the actual button is the only way to prove the whole chain —
   * UI → content script → service worker → filler → page — really works.
   */
  const shadow = async (fnBody: string) =>
    page.evaluate(`(() => {
      const host = document.querySelector("quill-panel");
      const root = host?.shadowRoot;
      if (!root) return null;
      ${fnBody}
    })()`);

  // The panel auto-scans on mount; wait until it has rendered decisions.
  await page.waitForFunction(
    () => {
      const text = document.querySelector("quill-panel")?.shadowRoot?.textContent ?? "";
      // The hero summary is the signal that a plan exists; the exact wording is
      // the panel's business, so match on the shared prefix only.
      return text.includes("本页") && text.includes("个字段");
    },
    { timeout: 20_000 },
  );
  check(true, "panel produced a plan on its own");

  const panelSummary = await shadow(`return root.querySelector(".q-hero-label")?.textContent ?? "";`);
  console.log(`  · panel summary: ${panelSummary}`);
  check(/\d+/.test(String(panelSummary)), "panel reports a field count", String(panelSummary));

  /*
   * Read the panel's own rendering of each decision. This asserts what the
   * person actually sees: label, proposed value, and the evidence line.
   */
  const rows = await shadow(`
    const out = [];
    for (const field of root.querySelectorAll(".q-field")) {
      out.push({
        label: field.querySelector(".q-field-label-text")?.textContent?.trim() ?? "",
        status: field.getAttribute("data-status") ?? "",
        value: field.querySelector(".q-field-value")?.textContent?.trim() ?? "",
        why: field.querySelector(".q-field-why-text")?.textContent?.trim() ?? "",
      });
    }
    return out;
  `);

  console.log(`  · panel rendered ${rows?.length ?? 0} field rows`);
  check((rows?.length ?? 0) >= 20, "panel rendered a row per field", String(rows?.length));

  const rowFor = (label: string) => (rows ?? []).find((row) => row.label.includes(label));

  const rendered = [
    ["姓名", "周子墨"],
    ["手机号码", "13600001111"],
    ["电子邮箱", "zhouzimo@example.com"],
    ["民族", "汉族"],
    ["学校名称", "华中科技大学"],
    ["专业", "计算机科学与技术"],
    ["GPA", "3.7/4.0"],
    ["专业排名", "6/140"],
    ["公司名称", "腾讯科技（深圳）有限公司"],
    ["意向岗位", "后端开发工程师"],
    ["期望薪资", "28-38万/年"],
    ["到岗时间", "2026年7月"],
  ];

  let shown = 0;
  for (const [label, expected] of rendered) {
    const row = rowFor(label);
    if (!row) {
      check(false, `panel shows a row for "${label}"`);
      continue;
    }
    if (row.value.includes(expected)) {
      shown += 1;
    } else {
      check(false, `panel shows the right value for "${label}"`, `got ${JSON.stringify(row.value)}`);
    }
  }
  check(shown === rendered.length, `panel displays all ${rendered.length} expected values`, `${shown}/${rendered.length}`);

  /* --------------------------------------------------------- evidence */

  // The "why" line is the product's core promise; it must never be empty.
  const withoutEvidence = (rows ?? []).filter(
    (row) => row.status !== "missing" && row.value && row.why.length === 0,
  );
  check(
    withoutEvidence.length === 0,
    "every proposed value carries an explanation",
    withoutEvidence.map((row) => row.label).join(", "),
  );

  const phoneRow = rowFor("手机号码");
  check(
    (phoneRow?.why ?? "").includes("简历"),
    "phone cites the resume as its source",
    phoneRow?.why,
  );

  /* ------------------------------------------------------------ safety */

  const captchaRow = rowFor("验证码");
  check(captchaRow?.status === "missing", "captcha is reported as unfillable", JSON.stringify(captchaRow));
  const consentRow = rowFor("隐私政策");
  check(
    consentRow === undefined || consentRow.status === "missing",
    "consent checkbox is never proposed",
    JSON.stringify(consentRow),
  );

  /*
   * A captcha and a consent checkbox are not "missing data" — saying so invites
   * the person to type into a control only they may operate. They must say they
   * need the person's own hand.
   */
  check(
    (captchaRow?.value ?? "").includes("需要你本人操作"),
    "captcha explains that it needs the person, rather than looking unfillable",
    captchaRow?.value,
  );
  check(
    (consentRow?.value ?? "").includes("需要你本人操作"),
    "consent checkbox explains that it needs the person",
    consentRow?.value,
  );

  /* ------------------------------------------------------------ the legend */

  // The hero's legend and the fill button must agree; disagreeing numbers on the
  // same screen leave the person unable to tell which is right.
  const hero = await shadow(`
    const legend = [...root.querySelectorAll(".q-legend-item")].map((node) => node.textContent.trim());
    return {
      label: root.querySelector(".q-hero-label")?.textContent?.trim() ?? "",
      legend,
      button: root.querySelector(".q-cta")?.textContent?.trim() ?? "",
    };
  `);
  console.log(`  · hero: "${hero?.label}" | legend: ${JSON.stringify(hero?.legend)}`);
  check((hero?.legend?.length ?? 0) >= 3, "the hero legend itemises the tally", JSON.stringify(hero?.legend));

  const buttonCount = Number.parseInt(String(hero?.button ?? "").replace(/\D/g, ""), 10);
  const readyCount = Number.parseInt(String(hero?.legend?.[0] ?? "").replace(/\D/g, ""), 10);
  const reviewCount = Number.parseInt(String(hero?.legend?.[1] ?? "").replace(/\D/g, ""), 10);
  check(
    Number.isFinite(buttonCount) && buttonCount === readyCount + reviewCount,
    "the fill button's count equals the fillable items in the legend",
    `button=${buttonCount} ready=${readyCount} review=${reviewCount}`,
  );

  // The hands-off note must be disclosed rather than left implicit.
  const notes = await shadow(`
    return [...root.querySelectorAll(".q-hero-note-item")].map((node) => node.textContent.trim());
  `);
  check(
    (notes ?? []).some((note) => note.includes("不会代填")),
    "the panel discloses which fields it will not fill",
    JSON.stringify(notes),
  );

  const relativesRow = rowFor("亲属");
  check(
    Boolean(relativesRow),
    "the radio group is labelled with its own question, not its section heading",
    JSON.stringify(relativesRow),
  );
  check(
    relativesRow?.status !== "missing",
    "the radio group received a value (无 relatives is the expected default)",
    JSON.stringify(relativesRow),
  );

  /* ---------------------------------------------------------- apply */

  const fillButton = await shadow(`
    const button = root.querySelector(".q-cta:not(.q-cta-ghost)");
    return button ? { text: button.textContent.trim(), disabled: button.disabled } : null;
  `);
  check(Boolean(fillButton) && !fillButton.disabled, "primary fill button is enabled", JSON.stringify(fillButton));
  console.log(`  · fill button: "${fillButton?.text}"`);

  // Click through the shadow root. Puppeteer cannot reach into a shadow root
  // directly, so the click is dispatched from inside the page.
  await shadow(`root.querySelector(".q-cta:not(.q-cta-ghost)").click(); return true;`);

  await page.waitForFunction(
    () => {
      const text = document.querySelector("quill-panel")?.shadowRoot?.textContent ?? "";
      return text.includes("已填写");
    },
    { timeout: 20_000 },
  );
  const reportLine = await shadow(`return root.querySelector(".q-notice")?.textContent?.trim() ?? "";`);
  console.log(`  · fill report: ${reportLine}`);
  check(/已填写 \d+ 项/.test(String(reportLine)), "panel reports how many fields it filled", String(reportLine));

  /*
   * When something fails, the reason matters more than the count. Clicking the
   * disclosure and reading it needs a tick, because React re-renders
   * asynchronously after the state change.
   */
  await shadow(`
    const button = [...root.querySelectorAll(".q-mini")].find((node) => node.textContent.includes("查看原因"));
    if (button) button.click();
    return true;
  `);
  await new Promise((resolveWait) => setTimeout(resolveWait, 400));
  const failureDetails = await shadow(`
    return [...root.querySelectorAll(".q-notice li")].map((node) => node.textContent.trim());
  `);
  if (Array.isArray(failureDetails) && failureDetails.length > 0) {
    console.log("  · fill failures:");
    for (const detail of failureDetails) console.log(`      ${detail}`);
  } else {
    console.log("  · no failure detail was disclosed");
  }

  // Print every outcome, not just the failures: a field reported as filled that
  // did not actually change is the worst failure mode, and it is invisible in a
  // pass/fail count.
  const allOutcomes = await shadow(`
    return [...root.querySelectorAll(".q-field")].map((field) => ({
      label: field.querySelector(".q-field-label-text")?.textContent?.trim() ?? "",
      status: field.getAttribute("data-status") ?? "",
      value: (field.querySelector(".q-field-value")?.textContent ?? "").trim().slice(0, 40),
    }));
  `);
  console.log("  · panel state after fill:");
  for (const row of allOutcomes ?? []) {
    console.log(`      ${String(row.status).padEnd(7)} ${String(row.label).padEnd(14)} ${row.value}`);
  }

  /* ------------------------------------------- assert the page's real DOM */

  const dom = await page.evaluate(() => {
    const value = (selector) => document.querySelector(selector)?.value ?? null;
    const checked = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value ?? null;
    const text = (selector) => document.querySelector(selector)?.textContent?.trim() ?? null;
    return {
      name: value("#name"),
      gender: value("#gender"),
      birth: value("#birth"),
      nation: value("#nation"),
      politic: value("#politic"),
      phone: value("#phone"),
      email: value("#email"),
      city: value("#city"),
      wechat: value("#wechat"),
      school: value("input[name='school[0]']"),
      major: value("input[name='major[0]']"),
      degree: value("select[name='degree[0]']"),
      gpa: value("input[name='gpa[0]']"),
      rank: value("input[name='rank[0]']"),
      company: value("input[name='company[0]']"),
      title: value("input[name='jobTitle[0]']"),
      workStart: value("input[name='workStart[0]']"),
      workDesc: value("textarea[name='workDesc[0]']"),
      position: value("#pos"),
      expCity: value("#expcity"),
      salary: value("#salary"),
      avail: value("#avail"),
      source: value("#source"),
      selfIntro: value("textarea[name='selfIntro']"),
      whyRole: value("textarea[name='whyRole']"),
      captcha: value("#code"),
      agree: checked("agree"),
      relatives: checked("relatives"),
    };
  });

  console.log("  · page state after fill:");
  for (const [key, value] of Object.entries(dom)) {
    const shown = typeof value === "string" && value.length > 46 ? `${value.slice(0, 46)}…` : value;
    console.log(`      ${key.padEnd(11)} ${JSON.stringify(shown)}`);
  }

  check(dom.name === "周子墨", "name written into the page");
  check(dom.phone === "13600001111", "phone written into the page");
  check(dom.email === "zhouzimo@example.com", "email written into the page");
  check(dom.gender === "M", "gender select set to the correct option value");
  check(/^\d{4}-\d{2}/.test(dom.birth ?? ""), "date input received an ISO date", String(dom.birth));
  check(dom.nation === "汉族", "ethnicity written");
  check(dom.politic !== "", "political status selected from the dropdown", String(dom.politic));
  check(dom.school === "华中科技大学", "school written");
  check(dom.major === "计算机科学与技术", "major written");
  check(dom.degree === "bachelor", "degree select matched the option value");
  check(dom.gpa === "3.7/4.0", "GPA written");
  check(dom.rank === "6/140", "class rank written");
  check(dom.company === "腾讯科技（深圳）有限公司", "company written");
  check(dom.title === "后端开发工程师", "job title written");
  check(String(dom.workStart).includes("2021"), "work start date written", String(dom.workStart));
  check((dom.workDesc ?? "").includes("对账"), "work description written as text");
  check(dom.position === "后端开发工程师", "preferred position written");
  check(String(dom.expCity).includes("深圳"), "preferred city written");
  check(dom.salary === "28-38万/年", "expected salary written");
  check(dom.avail === "2026年7月", "available-from written");
  check(dom.source === "website", "source select matched 招聘官网 → website");
  /*
   * Assert the exact value rather than a length: the point is that the resume's
   * own words reached the textarea unaltered, and a length threshold would pass
   * even if the extension had composed something different.
   */
  const expectedIntro = profile.essays.selfIntro ?? "";
  check(
    Boolean(expectedIntro) && dom.selfIntro === expectedIntro,
    "self introduction written verbatim from the resume",
    `expected ${JSON.stringify(expectedIntro)} got ${JSON.stringify(dom.selfIntro)}`,
  );
  check(dom.captcha === "", "captcha left untouched");
  check(dom.agree !== "on", "consent checkbox left unticked");
  check(dom.relatives !== null, "relative radio group was answered", String(dom.relatives));

  /* ---------------------------------------------- learning from the person */

  /*
   * Simulate the person correcting the WeChat field by hand. The watcher listens
   * for `change`/`blur` in the capture phase, so dispatching those events is a
   * faithful stand-in for a real edit — and it exercises the actual learning
   * path rather than calling the message handler directly.
   */
  const staffProfile = await openExtensionPage("popup.html");
  await staffProfile.waitForFunction(() => Boolean(globalThis.chrome?.storage), { timeout: 15_000 });

  const memoryBefore = await staffProfile.evaluate(async () => {
    const state = await chrome.storage.local.get("quill.memory");
    return (state["quill.memory"] ?? []).length;
  });

  await page.evaluate(() => {
    const target = document.querySelector("#wechat");
    target.focus();
    target.value = "zimo_2026";
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    target.blur();
  });

  // The worker round trip is asynchronous; poll storage for the new entry.
  let memoryAfter = [];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    memoryAfter = await staffProfile.evaluate(async () => {
      const state = await chrome.storage.local.get("quill.memory");
      return state["quill.memory"] ?? [];
    });
    if (memoryAfter.some((entry) => entry.value === "zimo_2026")) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }

  check(memoryAfter.length > memoryBefore, "learning the hand-typed value added a memory entry");
  const entry = memoryAfter.find((item) => item.value === "zimo_2026");
  check(Boolean(entry), "the learned value is present in memory", JSON.stringify(memoryAfter));
  check(entry?.key === "contact.wechat", "learned value was keyed correctly", entry?.key);
  check(entry?.labelSnapshot === "微信号", "learned value kept the label it was seen under", entry?.labelSnapshot);

  /* ------------------------------------------------ memory beats the resume */

  /*
   * Re-scan and confirm the remembered answer now outranks the resume's value.
   * This is the whole point of learning, so it is asserted on the real plan.
   */
  const reScan = await shadow(`
    const button = root.querySelector('[aria-label="重新识别"]');
    if (button) {
      button.click();
      return true;
    }
    return false;
  `);
  check(reScan === true, "panel exposes a re-scan control");

  await new Promise((resolveWait) => setTimeout(resolveWait, 2500));
  const wechatRow = await shadow(`
    for (const field of root.querySelectorAll(".q-field")) {
      if ((field.querySelector(".q-field-label-text")?.textContent ?? "").includes("微信号")) {
        return {
          value: field.querySelector(".q-field-value")?.textContent?.trim() ?? "",
          why: field.querySelector(".q-field-why-text")?.textContent?.trim() ?? "",
        };
      }
    }
    return null;
  `);
  check(
    (wechatRow?.value ?? "").includes("zimo_2026"),
    "a remembered answer is offered back on the next scan",
    JSON.stringify(wechatRow),
  );
  check(
    (wechatRow?.why ?? "").includes("填写") || (wechatRow?.why ?? "").includes("记忆"),
    "the remembered answer says where it came from",
    wechatRow?.why,
  );
  await staffProfile.close();

  /* ------------------------------------------------------------- popup */

  const popup = await openExtensionPage("popup.html");
  await popup.setViewport({ width: 380, height: 560 });
  await popup.waitForSelector(".q-popup-root", { timeout: 10_000 });
  const popupText = await popup.evaluate(() => document.body.innerText);
  check(popupText.includes("Quill"), "popup rendered");
  check(popupText.includes("识别当前页面的表单"), "popup offers to scan the active page");
  if (screenshotFile) {
    mkdirSync(dirname(screenshotFile), { recursive: true });
    await popup.screenshot({ path: screenshotFile });
    console.log(`  · wrote ${screenshotFile}`);
  }

  /* --------------------------------------------------------- workbench */

  const bench = await openExtensionPage("pages/workbench.html");
  await bench.setViewport({ width: 1440, height: 900 });
  await bench.waitForSelector(".q-app", { timeout: 15_000 });
  await bench.waitForFunction(
    () => !document.body.innerText.includes("正在"),
    { timeout: 15_000 },
  );

  const benchText = await bench.evaluate(() => document.body.innerText);
  check(benchText.includes("周子墨") || benchText.includes("工作台"), "workbench rendered with data");
  check(benchText.includes("简历"), "workbench navigation present");
  check(
    await bench.evaluate(() => Boolean(document.querySelector(".q-rail"))),
    "workbench nav rail rendered",
  );

  /* -------------------------------------------------------- real screenshots */

  if (screenshotFile) {
    const base = screenshotFile.replace(/\.png$/i, "");
    /*
     * The reveal animation runs for 700ms plus a per-item stagger. Screenshotting
     * mid-animation captures half-faded text, which looks like a rendering bug
     * when it is not. Waiting for the animation to finish is cheaper than
     * re-running and second-guessing the result.
     *
     * `animation.finished` is awaited with a timeout rather than directly: the
     * skeleton shimmer and the status-dot pulse loop forever, so their promises
     * never resolve and an unbounded `Promise.all` hangs the whole run.
     */
    const settle = async (target: puppeteer.Page): Promise<void> => {
      await target
        .evaluate(async () => {
          const finite = document
            .getAnimations()
            .filter((animation) => animation.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY);
          await Promise.race([
            Promise.all(finite.map((animation) => animation.finished.catch(() => {}))),
            new Promise((resolveWait) => setTimeout(resolveWait, 2000)),
          ]);
        })
        .catch(() => {});
      await new Promise((resolveWait) => setTimeout(resolveWait, 350));
    };

    /*
     * Every capture is individually guarded. Screenshots are evidence for a
     * human reviewing the design; they are not assertions, and a compositor
     * timeout on a page with heavy `backdrop-filter` must not fail a run whose
     * functional checks all passed.
     */
    const capture = async (target: puppeteer.Page, name: string): Promise<void> => {
      try {
        await target.screenshot({ path: `${base}-${name}.png`, captureBeyondViewport: false });
        console.log(`      wrote ${name}.png`);
      } catch (error) {
        console.log(`      ! ${name}.png failed: ${error instanceof Error ? error.message : error}`);
      }
    };

    await settle(bench);
    await capture(bench, "workbench-home");

    await bench.evaluate(() => { window.location.hash = "#/resume"; });
    await bench.waitForFunction(() => document.body.innerText.includes("基本信息"), { timeout: 8000 });
    await settle(bench);
    await capture(bench, "workbench-resume");

    await bench.evaluate(() => { window.location.hash = "#/tailor"; });
    await bench.waitForFunction(() => document.body.innerText.includes("岗位描述"), { timeout: 8000 });
    await settle(bench);
    await capture(bench, "workbench-tailor");

    await bench.evaluate(() => { window.location.hash = "#/ledger"; });
    await settle(bench);
    await capture(bench, "workbench-ledger");

    await bench.evaluate(() => { window.location.hash = "#/memory"; });
    await settle(bench);
    await capture(bench, "workbench-memory");

    await bench.evaluate(() => { window.location.hash = "#/settings"; });
    await settle(bench);
    await capture(bench, "workbench-settings");

    /*
     * Capture the collapsed pill *before* any assertion reads the panel, and
     * restore the expanded state afterwards. Collapsing and then asserting on the
     * expanded panel's contents was a self-inflicted failure: the click is a real
     * state change, so the order of a screenshot and a check is not arbitrary.
     */
    const collapseToggle = await shadow(`
      const button = [...root.querySelectorAll(".q-hbtn")].find((node) =>
        (node.getAttribute("aria-label") ?? "").includes("收起"),
      );
      if (button) button.click();
      return Boolean(button);
    `);
    if (collapseToggle) {
      await settle(page);
      await capture(page, "panel-collapsed");
      // Expand again so the later checks see the full panel.
      await page.evaluate(() => {
        const root = document.querySelector("quill-panel")?.shadowRoot;
        const pill = root?.querySelector(".q-pill");
        if (pill instanceof HTMLElement) pill.click();
      });
      await settle(page);
    }

    console.log(`  · wrote workbench screenshots`);
  }

  /* ------------------------------------------------------------- errors */

  const realErrors = pageErrors.filter(
    (error) =>
      !/favicon/i.test(error) &&
      // A file:// page has no favicon and Chrome logs a benign CSP notice for
      // extension resources; neither indicates a defect.
      !/net::ERR_FILE_NOT_FOUND/i.test(error),
  );
  check(realErrors.length === 0, "no console errors on the form page", realErrors.slice(0, 4).join("\n      "));

  /* ------------------------------------------------------------- panel UI */

  /*
   * Finally, confirm the panel is still mounted and interactive.
   *
   * The panel is torn down and re-created when the person closes it, and a fill
   * triggers a re-render, so the shadow root can legitimately be between states
   * at an arbitrary moment. Polling for a settled root makes this deterministic;
   * reading `shadowRoot` once made the check pass or fail depending on timing.
   */
  const panelProbe = await (async () => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const probe = await page.evaluate(() => {
        const host = document.querySelector("quill-panel");
        const root = host?.shadowRoot;
        return {
          hostFound: Boolean(host),
          hasShadow: Boolean(root),
          text: root?.textContent ?? "",
          linkHref: root?.querySelector("link")?.getAttribute("href") ?? null,
          rowCount: root?.querySelectorAll(".q-field").length ?? 0,
        };
      });
      if (probe.hasShadow && probe.text.includes("Quill")) return probe;
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
    return { hostFound: false, hasShadow: false, text: "", linkHref: null, rowCount: 0 };
  })();

  check(panelProbe.hostFound, "panel host is mounted on the page");
  check(panelProbe.hasShadow, "panel rendered inside a shadow root");
  check(
    panelProbe.linkHref?.includes("styles/content.css") ?? false,
    "panel links its stylesheet from inside the shadow root",
    String(panelProbe.linkHref),
  );
  check(panelProbe.rowCount > 0, "panel still shows the field list after filling", `${panelProbe.rowCount} rows`);
  check(panelProbe.text.includes("填写"), "panel exposes the primary fill action");

  if (screenshotFile) {
    /*
     * The form page is ~2500px tall with a glass panel over it. Capturing it
     * needs the viewport rather than a full-page capture, both because a
     * full-page shot of a long form is unreadable and because the compositor
     * times out on one. Failures here are logged, not fatal: a screenshot is
     * evidence for a human, not an assertion.
     */
    try {
      await page.screenshot({ path: screenshotFile.replace(/\.png$/i, "-form.png") });
      console.log("  · wrote form screenshot");
    } catch (error) {
      console.log(`  ! form screenshot failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  if (keepOpen) {
    console.log("\nBrowser left open. Press Ctrl+C when done.");
    await new Promise(() => {});
  }
} catch (error) {
  failures.push(`threw: ${error instanceof Error ? error.message : String(error)}`);
  console.error(error);
} finally {
  if (fixtureServer) await new Promise((done) => fixtureServer.close(() => done()));
  if (!keepOpen) await browser.close();
}

console.log("");
if (failures.length === 0) {
  console.log("e2e: all checks passed");
  process.exit(0);
} else {
  console.log(`e2e: ${failures.length} check(s) failed`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
