/**
 * Turning an uploaded file into plain text.
 *
 * Three formats matter for resumes: PDF, DOCX and plain text. Each needs a
 * different library, and each fails differently, so this module owns all of the
 * failure handling and returns one shape.
 *
 * Resume extraction is not the same job as document-to-text. A resume is a
 * *layout*: two columns, a table, a sidebar of contact details, section
 * headings that only make sense above the text they head. Ignoring the layout
 * is why naive extraction returns low-recall soup — every column is interleaved
 * on the same line and the parser can no longer tell a heading from a bullet.
 * The PDF path therefore reconstructs visual lines, spaces runs by geometry,
 * detects a vertical gutter, and reads columns in order.
 */

export interface ExtractedText {
  text: string;
  /** Pages or sections, when the format exposes them. */
  pages?: string[];
  warnings: string[];
}

export async function extractText(file: File): Promise<ExtractedText> {
  const name = file.name.toLowerCase();
  const type = file.type;

  if (name.endsWith(".pdf") || type === "application/pdf") return extractPdf(file);
  if (name.endsWith(".docx") || type.includes("wordprocessingml")) return extractDocx(file);
  if (name.endsWith(".txt") || name.endsWith(".md") || type.startsWith("text/")) {
    return { text: await file.text(), warnings: [] };
  }

  /*
   * Legacy `.doc` cannot be read reliably; guessing at a binary format
   * produces garbage that would then be parsed into a wrong profile.
   *
   * Images are readable, but only by the recognition server. Reaching this
   * point with an image means model recognition is off or just failed, so say
   * that plainly instead of pretending the format is unsupported.
   */
  if (/\.(png|jpe?g)$/i.test(name) || type.startsWith("image/")) {
    throw new Error("图片需要开启模型识别才能读取；请在设置里开启，或改用可复制文字的 PDF / DOCX。");
  }
  throw new Error(
    name.endsWith(".doc")
      ? "旧版 .doc 格式无法可靠读取，请在 Word 中另存为 .docx 或 PDF 后重新上传。"
      : "暂不支持这种文件格式，请上传 PDF、DOCX 或 TXT。",
  );
}

/* --------------------------------------------------------------------- pdf */

interface PdfRun {
  text: string;
  /** Device-space left edge and right edge at scale 1. */
  x: number;
  end: number;
  /** Device-space baseline; grows downwards. */
  y: number;
  height: number;
}

interface PdfLine {
  y: number;
  height: number;
  runs: PdfRun[];
  /** The whole line joined in x order, before any column split. */
  text: string;
}

const CJK = /[㐀-䶿一-鿿豈-﫿]/;
const CJK_ALL = /[㐀-䶿一-鿿豈-﫿]/g;

function estimateWidth(text: string, height: number): number {
  const cjk = text.match(CJK_ALL)?.length ?? 0;
  const latin = Math.max(0, [...text].length - cjk);
  return cjk * height + latin * height * 0.55;
}

/**
 * Join the runs of one visual line.
 *
 * PDF text often arrives glyph by glyph. Joining with a space every time would
 * turn “浙江大学” into “浙 江 大 学”, which breaks every string match downstream.
 * A space is only inserted when the geometry says the two runs are separate
 * fields — and between CJK glyphs the threshold is much wider than between
 * latin words.
 */
function joinRuns(runs: PdfRun[]): string {
  const ordered = [...runs].sort((a, b) => a.x - b.x);
  let out = "";
  let previousEnd: number | undefined;

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

function buildVisualLines(runs: PdfRun[]): PdfLine[] {
  const sorted = [...runs].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: PdfLine[] = [];

  for (const run of sorted) {
    const current = lines[lines.length - 1];
    /*
     * Tolerance is proportional to the type size, so a 10pt body and a 22pt
     * heading are not forced onto the same line just because their baselines
     * are a few points apart.
     */
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

interface Gutter {
  start: number;
  end: number;
}

/**
 * Find a vertical whitespace channel that separates two columns.
 *
 * Full-width headings are ignored for the histogram: they legitimately cross
 * the gutter, and counting them would erase the very gap we are looking for.
 * A candidate only counts when there is substantial content on both sides.
 */
function findGutter(lines: PdfLine[], pageWidth: number): Gutter | undefined {
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
  const fromBin = Math.floor(pageWidth * 0.18 / binSize);
  const toBin = Math.ceil(pageWidth * 0.82 / binSize);

  let best: Gutter | undefined;
  let runStart: number | undefined;

  const consider = (startBin: number, endBin: number): void => {
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

interface LineParts {
  left?: string;
  right?: string;
  /** The line is continuous across the gutter, e.g. a full-width heading. */
  full?: string;
}

function splitAtGutter(line: PdfLine, gutter: Gutter): LineParts {
  const leftRuns = line.runs.filter((run) => (run.x + run.end) / 2 < gutter.start);
  const rightRuns = line.runs.filter((run) => (run.x + run.end) / 2 > gutter.end);

  if (leftRuns.length === 0) return { right: joinRuns(rightRuns) };
  if (rightRuns.length === 0) return { left: joinRuns(leftRuns) };

  const leftEnd = Math.max(...leftRuns.map((run) => run.end));
  const rightStart = Math.min(...rightRuns.map((run) => run.x));
  const gap = rightStart - leftEnd;
  /*
   * A heading “教育经历 EDUCATION” can cross the gutter while still being one
   * sentence. Column fragments, by contrast, leave the whole gutter empty. Use
   * a conservative fraction of the gutter width to tell them apart.
   */
  const continuousGap = Math.max(4, Math.min(line.height * 0.9, (gutter.end - gutter.start) * 0.55));
  if (gap <= continuousGap) return { full: joinRuns(line.runs) };

  return { left: joinRuns(leftRuns), right: joinRuns(rightRuns) };
}

/**
 * Read a two-column page in column order.
 *
 * Text above the first line that exists in both columns (the name/contact
 * header) is emitted first, in its original order. Below it, left-column lines
 * accumulate until a full-width line — usually a section heading spanning the
 * page — flushes both columns. That keeps “教育经历” followed by its entries
 * instead of interleaving them with the skills column next to them.
 */
function orderPage(lines: PdfLine[], gutter: Gutter | undefined): { text: string; columns: boolean } {
  if (!gutter) return { text: lines.map((line) => line.text).join("\n"), columns: false };

  const parts = lines.map((line) => splitAtGutter(line, gutter));
  const columnStart = parts.findIndex((part) => part.left !== undefined && part.right !== undefined);
  if (columnStart < 0) {
    // A wide gap that no line actually uses as two columns (e.g. right-aligned
    // dates in a single-column resume). Fall back to plain line order.
    return { text: lines.map((line) => line.text).join("\n"), columns: false };
  }

  const out: string[] = [];
  for (let index = 0; index < columnStart; index += 1) {
    const part = parts[index];
    const line = lines[index];
    out.push(part?.full ?? line?.text ?? "");
  }

  const left: string[] = [];
  const right: string[] = [];
  const flush = (): void => {
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

async function extractPdf(file: File): Promise<ExtractedText> {
  const pdfjs = await import("pdfjs-dist");
  /*
   * The worker must be configured before `getDocument` is called, and Vite
   * needs the URL resolved at build time — hence `new URL(..., import.meta.url)`
   * rather than a string path.
   */
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url,
  ).toString();

  const data = new Uint8Array(await file.arrayBuffer());
  const document = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  const pages: string[] = [];
  const warnings: string[] = [];
  let sawAnyText = false;
  let usedColumns = false;

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();

    const runs: PdfRun[] = [];
    for (const item of content.items) {
      if (!("str" in item)) continue;
      const str = item.str;
      if (!str || str.trim().length === 0) continue;

      const transform = item.transform as number[];
      const x = transform[4] ?? 0;
      const baseline = transform[5] ?? 0;
      // PDF user space has y growing upwards; viewport space has it growing
      // downwards, which is the order a human reads.
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

  await document.destroy();

  const text = pages
    .map((pageText) => pageText.trim())
    .filter(Boolean)
    .join("\n\n");

  if (!sawAnyText) {
    warnings.push("这份 PDF 没有可提取的文字，可能是扫描件或图片导出的 PDF。请上传可复制文字的 PDF 或 DOCX。");
  } else {
    if (text.length < 120) {
      warnings.push("从 PDF 中只提取到很少的文字，请对照下方原文确认文件是否完整。");
    }
    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    const average = lines.length > 0 ? lines.reduce((sum, line) => sum + line.length, 0) / lines.length : 0;
    if (lines.length > 0 && average > 180) {
      warnings.push("PDF 的行结构可能没有被完整保留，识别结果可能错位；请对照下方原文核对。");
    }
    if (usedColumns) {
      warnings.push("检测到双栏排版，已按左栏后右栏的顺序读取；如果字段错位，请对照下方原文核对。");
    }
  }

  return { text, pages, warnings };
}

/* -------------------------------------------------------------------- docx */

const BLOCK_TAGS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "blockquote",
  "pre",
  "table",
  "ul",
  "ol",
  "div",
  "section",
  "article",
  "header",
  "footer",
  "figure",
  "figcaption",
]);

function inlineText(node: Node): string {
  if (node.nodeType === 3) return node.nodeValue ?? "";
  if (node.nodeType !== 1) return "";
  const element = node as Element;
  const tag = element.tagName.toLowerCase();
  if (tag === "br") return "\n";
  if (tag === "script" || tag === "style") return "";
  let out = "";
  for (const child of Array.from(element.childNodes)) out += inlineText(child);
  // Block elements inside a cell need a separator, otherwise two paragraphs
  // become one unreadable run of text.
  if (/^(p|h[1-6]|li|div|section|article|tr|td|th)$/.test(tag)) out += "\n";
  return out;
}

function pushParagraph(text: string, out: string[]): void {
  for (const line of text.split("\n")) {
    const cleaned = line.replace(/\s+/g, " ").trim();
    if (cleaned) out.push(cleaned);
  }
}

function renderTable(table: Element, out: string[]): void {
  /*
   * Mammoth represents a table row as a real `<tr>` with one cell per column.
   * Joining cells with “ | ” preserves the row structure the resume parser
   * relies on; `extractRawText` flattens the same table into unrelated lines.
   */
  for (const row of Array.from(table.querySelectorAll("tr"))) {
    const cells = Array.from(row.children)
      .filter((cell) => /^(td|th)$/i.test(cell.tagName))
      .map((cell) => inlineText(cell).replace(/\s*\n\s*/g, " ").replace(/\s+/g, " ").trim())
      .filter(Boolean);
    if (cells.length > 0) out.push(cells.join(" | "));
  }
}

function renderBlocks(parent: Element, out: string[]): void {
  for (const child of Array.from(parent.children)) {
    const tag = child.tagName.toLowerCase();
    if (tag === "script" || tag === "style") continue;
    if (tag === "table") {
      renderTable(child, out);
      continue;
    }
    if (tag === "ul" || tag === "ol") {
      renderBlocks(child, out);
      continue;
    }
    if (tag === "li" || tag === "p" || /^h[1-6]$/.test(tag) || tag === "blockquote" || tag === "pre") {
      pushParagraph(inlineText(child), out);
      continue;
    }
    const hasBlockChild = Array.from(child.children).some((grandchild) =>
      BLOCK_TAGS.has(grandchild.tagName.toLowerCase()),
    );
    if (hasBlockChild) renderBlocks(child, out);
    else pushParagraph(inlineText(child), out);
  }
}

/** HTML from mammoth → text that keeps paragraph, list and table structure. */
function htmlToPlainText(html: string): string {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const out: string[] = [];
  renderBlocks(parsed.body, out);
  return out.join("\n");
}

async function extractDocx(file: File): Promise<ExtractedText> {
  /*
   * `mammoth`'s package.json maps its Node-only unzip/files modules to browser
   * implementations, so the normal entry point bundles correctly. The
   * `mammoth.browser.js` path has no types for `convertToHtml`.
   */
  const mammoth = (await import("mammoth")).default;
  const arrayBuffer = await file.arrayBuffer();
  const warnings: string[] = [];

  let text = "";
  try {
    const result = await mammoth.convertToHtml({ arrayBuffer });
    text = htmlToPlainText(result.value);
    if (result.messages.some((message: { type?: string }) => message.type === "error")) {
      warnings.push("文档中有部分内容无法读取，请核对解析结果。");
    }
  } catch {
    // Fall through to the plain-text extractor; a partially readable resume is
    // still better than an import that fails outright.
    text = "";
  }

  if (!text.trim()) {
    const result = await mammoth.extractRawText({ arrayBuffer });
    text = result.value;
    if (result.messages.some((message) => message.type === "error")) {
      warnings.push("文档中有部分内容无法读取，请核对解析结果。");
    }
  }

  return { text, warnings };
}

/** Read a JD from a file, reusing the same extraction path. */
export async function extractJd(file: File): Promise<string> {
  const result = await extractText(file);
  return result.text;
}

/** Accept only what we can actually parse, and say why when we cannot. */
export const ACCEPTED_TYPES =
  ".pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown";

/** Images are readable only by the model pipeline. */
export const ACCEPTED_TYPES_WITH_IMAGES = `${ACCEPTED_TYPES},.png,.jpg,.jpeg,image/png,image/jpeg`;

export function validateFile(
  file: File,
  limitMb = 20,
  options: { allowImages?: boolean } = {},
): string | undefined {
  if (file.size > limitMb * 1024 * 1024) {
    return `文件超过 ${limitMb} MB，请压缩后重试。`;
  }
  const name = file.name.toLowerCase();
  const isImage = /\.(png|jpe?g)$/i.test(name) || file.type === "image/png" || file.type === "image/jpeg";
  const ok =
    name.endsWith(".pdf") ||
    name.endsWith(".docx") ||
    name.endsWith(".txt") ||
    name.endsWith(".md") ||
    file.type.startsWith("text/") ||
    (isImage && options.allowImages === true);
  if (!ok) {
    return isImage
      ? "图片需要开启模型识别才能读取；请在设置里开启，或上传 PDF / DOCX。"
      : "只支持 PDF、DOCX、TXT 或 MD 格式。";
  }
  return undefined;
}
