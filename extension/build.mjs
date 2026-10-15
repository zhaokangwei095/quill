/**
 * Bundles the extension.
 *
 * Three entry points, one output directory. `extension/dist` is the unpacked
 * extension the user loads, so the build must be self-contained: the manifest,
 * the CSS and the generated icons are copied in alongside the bundles.
 */

import { build, context } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const out = join(here, "dist");
const watch = process.argv.includes("--watch");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

/** Shared build options. `@quill/core` resolves to source so there is no
 * separate build step for the shared package. */
const shared = {
  bundle: true,
  platform: "browser",
  target: ["chrome116"],
  format: "esm",
  sourcemap: watch ? "inline" : false,
  minify: !watch,
  logLevel: "info",
  define: { "process.env.NODE_ENV": JSON.stringify(watch ? "development" : "production") },
  alias: { "@quill/core": join(root, "packages/core/src/index.ts") },
};

const targets = [
  { in: join(here, "src/background.ts"), out: join(out, "background.js") },
  { in: join(here, "src/content/index.ts"), out: join(out, "content.js") },
  { in: join(here, "src/ui/popup.tsx"), out: join(out, "popup.js") },
  { in: join(here, "src/ui/options.tsx"), out: join(out, "pages/options.js") },
  { in: join(here, "src/ui/welcome.tsx"), out: join(out, "pages/welcome.js") },
];

/**
 * Stylesheets are separate entries so the extension pages can `<link>` them and
 * the content script can fetch its own as text for the shadow root. esbuild
 * resolves the `@import` chain, which is what lets `content.css` pull in the
 * shared design tokens without duplicating them by hand.
 */
const styles = [
  { in: join(here, "src/styles/content.css"), out: join(out, "styles/content.css") },
  { in: join(here, "src/styles/extension.css"), out: join(out, "styles/extension.css") },
];

if (watch) {
  for (const target of targets) {
    const ctx = await context({ ...shared, entryPoints: [target.in], outfile: target.out });
    await ctx.watch();
  }
  for (const style of styles) {
    const ctx = await context({ ...shared, entryPoints: [style.in], outfile: style.out });
    await ctx.watch();
  }
  console.log("watching…");
} else {
  for (const target of targets) {
    await build({ ...shared, entryPoints: [target.in], outfile: target.out });
  }
  for (const style of styles) {
    await build({ ...shared, entryPoints: [style.in], outfile: style.out, minify: false });
  }
}

/* ------------------------------------------------------------- static files */

const manifest = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8"));
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));

// Popup and options markup are hand-written so the markup stays inspectable.
for (const file of ["popup.html", "pages/options.html", "pages/welcome.html"]) {
  const from = join(here, file);
  if (!existsSync(from)) continue;
  const to = join(out, file);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to);
}

// Icons are generated once and committed, so the build never depends on a
// headless browser being available.
if (existsSync(join(here, "assets"))) {
  cpSync(join(here, "assets"), join(out, "assets"), { recursive: true });
}

/*
 * `_locales` must be copied verbatim. `default_locale` in the manifest is only
 * valid when a matching `_locales/<locale>/messages.json` exists, and Chrome
 * refuses to load the whole extension when it does not — a failure that shows
 * up as "no extension at all", not as a manifest error.
 */
if (existsSync(join(here, "_locales"))) {
  cpSync(join(here, "_locales"), join(out, "_locales"), { recursive: true });
}

console.log(`built → ${out}`);
