/**
 * PDF reading on the server.
 *
 * Two jobs:
 *  1. Recover text from a digital PDF without asking a model — exact characters
 *     beat OCR whenever they exist.
 *  2. Rasterise a scanned PDF so the OCR model can read it.
 *
 * The line reconstruction below mirrors the workbench's PDF extractor: a
 * resume is a layout, and reading text items in raw PDF order interleaves
 * columns and destroys section headings. Keep the two implementations in step
 * when either changes.
 */

import { createCanvas } from "@napi-rs/canvas";

/*
 * pdfjs-dist 4.x expects `Promise.withResolvers`, which only arrived in Node
 * 22. The service claims Node 20 support, so provide it before loading PDF.js.
 */
if (typeof Promise.withResolvers !== "function") {
  Promise.withResolvers = function withResolvers() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

const CJK = /[㐀-䶿一-鿿豈-﫿]/;
const CJK_ALL = /[㐀-䶿一-鿿豈-﫿]/g;

function estimateWidth(text, height) {
  const cjk = text.match(CJK_ALL)?.length ?? 0;
  const latin = Math.max(0, [...text].length - cjk);
  return cjk * height + latin * height * 0.55;
}

function joinRuns(runs) {
  const ordered = [...runs].sort((a, b) => a.x - b.x);
  let out = "";
  let previousEnd;

  for (const run of ordered) {
    if (out.length > 0 && previousEnd !== undefined) {
      const gap = run.x - previousEnd;
      const previousChar = [...out].pop() ?? "";
      const nextChar = run.text[0] ?? "";
      const bothCjk = CJK.test(previousChar) && CJK.test(nextChar);
      const threshold = bothCjk ? Math.max(6, run.height * 0.9) : Math.max(1.5, run.height * 0.28);
      if (gap > threshold && !/\s$/.test(out) && !/^\s/.test(run.text)) out += " ";
    }
    out += run.text;
    previousEnd = Math.max(previousEnd ?? Number.NEGATIVE_INFINITY, run.end);
  }

  return out.replace(/\s+/g, " ").trim();
}

function buildVisualLines(runs) {
  const sorted = [...runs].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];

  for (const run of sorted) {
    const current = lines[lines.length - 1];
    const tolerance = Math.max(2.2, Math.min(current?.height ?? run.height, run.height) * 0.35);
    if (current && Math.abs(run.y - current.y) <= tolerance) {
      current.runs.push(run);
      current.height = Math.max(current.height, run.height);
    } else {
      lines.push({ y: run.y, height: run.height, runs: [run], text: "" });
    }
  }

  for (const line of lines) line.text = joinRuns(line.runs);
  return lines;
}

function findGutter(lines, pageWidth) {
  if (pageWidth <= 0 || lines.length < 8) return undefined;

  const binSize = 2;
  const bins = Math.ceil(pageWidth / binSize);
  const coverage = new Uint16Array(bins);

  for (const line of lines) {
    const narrow = line.runs.every((run) => run.end - run.x < pageWidth * 0.85);
    if (!narrow) continue;
    for (const run of line.runs) {
      const from = Math.max(0, Math.floor(run.x / binSize));
      const to = Math.min(bins - 1, Math.ceil(run.end / binSize));
      for (let index = from; index <= to; index += 1) coverage[index] = (coverage[index] ?? 0) + 1;
    }
  }

  const minGap = Math.max(12, pageWidth * 0.02);
  const fromBin = Math.floor((pageWidth * 0.18) / binSize);
  const toBin = Math.ceil((pageWidth * 0.82) / binSize);

  let best;
  let runStart;

  const consider = (startBin, endBin) => {
    const start = startBin * binSize;
    const end = endBin * binSize;
    if (end - start < minGap) return;
    if (best && end - start <= best.end - best.start) return;

    let left = 0;
    let right = 0;
    for (const line of lines) {
      for (const item of line.runs) {
        const center = (item.x + item.end) / 2;
        if (center < start) left += 1;
        else if (center > end) right += 1;
      }
    }
    if (left >= 8 && right >= 8) best = { start, end };
  };

  for (let index = fromBin; index <= toBin && index < bins; index += 1) {
    const empty = (coverage[index] ?? 0) <= 2;
    if (empty && runStart === undefined) runStart = index;
    if (!empty && runStart !== undefined) {
      consider(runStart, index - 1);
      runStart = undefined;
    }
  }
  if (runStart !== undefined) consider(runStart, Math.min(toBin, bins - 1));

  return best;
}

function splitAtGutter(line, gutter) {
  const leftRuns = line.runs.filter((run) => (run.x + run.end) / 2 < gutter.start);
  const rightRuns = line.runs.filter((run) => (run.x + run.end) / 2 > gutter.end);

  if (leftRuns.length === 0) return { right: joinRuns(rightRuns) };
  if (rightRuns.length === 0) return { left: joinRuns(leftRuns) };

  const leftEnd = Math.max(...leftRuns.map((run) => run.end));
  const rightStart = Math.min(...rightRuns.map((run) => run.x));
  const gap = rightStart - leftEnd;
  const continuousGap = Math.max(4, Math.min(line.height * 0.9, (gutter.end - gutter.start) * 0.55));
  if (gap <= continuousGap) return { full: joinRuns(line.runs) };

  return { left: joinRuns(leftRuns), right: joinRuns(rightRuns) };
}

function orderPage(lines, gutter) {
  if (!gutter) return { text: lines.map((line) => line.text).join("\n"), columns: false };

  const parts = lines.map((line) => splitAtGutter(line, gutter));
  const columnStart = parts.findIndex((part) => part.left !== undefined && part.right !== undefined);
  if (columnStart < 0) {
    return { text: lines.map((line) => line.text).join("\n"), columns: false };
  }

  const out = [];
  for (let index = 0; index < columnStart; index += 1) {
    out.push(parts[index]?.full ?? lines[index]?.text ?? "");
  }

  const left = [];
  const right = [];
  const flush = () => {
    out.push(...left, ...right);
    left.length = 0;
    right.length = 0;
  };

  for (let index = columnStart; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part) continue;
    if (part.full !== undefined) {
      flush();
      out.push(part.full);
      continue;
    }
    if (part.left !== undefined && part.right !== undefined) {
      left.push(part.left);
      right.push(part.right);
      continue;
    }
    if (part.left !== undefined) left.push(part.left);
    if (part.right !== undefined) right.push(part.right);
  }
  flush();

  return { text: out.filter((line) => line.length > 0).join("\n"), columns: true };
}

async function openDocument(bytes) {
  return pdfjs.getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
  }).promise;
}

/**
 * Recover text from a digital PDF.
 *
 * `pages` is returned alongside the joined text so the caller can tell a
 * scanned document (all pages empty) from a genuinely short one.
 */
export async function readPdfText(bytes, { maxPages = 8 } = {}) {
  const document = await openDocument(bytes);
  const pages = [];
  let sawAnyText = false;
  let usedColumns = false;

  try {
    const count = Math.min(document.numPages, maxPages);
    for (let pageNumber = 1; pageNumber <= count; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();

      const runs = [];
      for (const item of content.items) {
        if (!("str" in item)) continue;
        const str = item.str;
        if (!str || str.trim().length === 0) continue;

        const transform = item.transform;
        const x = transform[4] ?? 0;
        const baseline = transform[5] ?? 0;
        const y = viewport.height - baseline;
        const height = Math.abs(transform[3] ?? 0) || Math.abs(transform[1] ?? 0) || item.height || 10;
        const width = Math.max(0.5, item.width || estimateWidth(str, height));

        runs.push({ text: str, x, end: x + width, y, height });
        sawAnyText = true;
      }

      if (runs.length === 0) {
        pages.push("");
        continue;
      }

      const lines = buildVisualLines(runs);
      const gutter = findGutter(lines, viewport.width);
      const ordered = orderPage(lines, gutter);
      usedColumns ||= ordered.columns;
      pages.push(ordered.text);
    }
  } finally {
    await document.destroy();
  }

  return {
    text: pages
      .map((pageText) => pageText.trim())
      .filter(Boolean)
      .join("\n\n"),
    pages,
    pageCount: pages.length,
    sawAnyText,
    usedColumns,
  };
}

/**
 * Render pages to PNG buffers.
 *
 * 2.5× is what produced a clean OCR result on the test resume; below ~2× small
 * body text starts to blur. Images are capped so a poster-sized PDF cannot
 * exhaust the machine's memory.
 */
export async function renderPdfPages(bytes, { scale = 2.5, maxPages = 4, maxPixels = 12_000_000 } = {}) {
  const document = await openDocument(bytes);
  const rendered = [];

  try {
    const count = Math.min(document.numPages, maxPages);
    for (let pageNumber = 1; pageNumber <= count; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      let viewport = page.getViewport({ scale });
      const pixels = viewport.width * viewport.height;
      if (pixels > maxPixels) {
        viewport = page.getViewport({ scale: scale * Math.sqrt(maxPixels / pixels) });
      }

      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const context = canvas.getContext("2d");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport }).promise;

      rendered.push({ page: pageNumber, png: canvas.toBuffer("image/png") });
      page.cleanup();
    }
    return { pages: rendered, pageCount: document.numPages };
  } finally {
    await document.destroy();
  }
}
