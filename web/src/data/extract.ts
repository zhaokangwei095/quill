/**
 * Turning an uploaded file into plain text.
 *
 * Three formats matter for resumes: PDF, DOCX and plain text. Each needs a
 * different library, and each fails differently, so this module owns all of the
 * failure handling and returns one shape.
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
   * Legacy `.doc` and images are deliberately not supported. Guessing at a
   * binary format produces garbage that would then be parsed into a wrong
   * profile, which is worse than asking the person to convert the file.
   */
  throw new Error(
    name.endsWith(".doc")
      ? "旧版 .doc 格式无法可靠读取，请在 Word 中另存为 .docx 或 PDF 后重新上传。"
      : "暂不支持这种文件格式，请上传 PDF、DOCX 或 TXT。",
  );
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

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();

    /*
     * PDFs have no line structure — only positioned glyphs. Rebuilding lines
     * from y-coordinates is what makes the resume parser work at all: without
     * it, "浙江大学 计算机科学与技术 本科" arrives as one glyph per line.
     */
    let line = "";
    let lastY: number | undefined;
    const lines: string[] = [];
    for (const item of content.items) {
      if (!("str" in item)) continue;
      const y = item.transform[5] as number;
      if (lastY !== undefined && Math.abs(y - lastY) > 2) {
        if (line.trim()) lines.push(line.trim());
        line = "";
      }
      line += item.str;
      // A large horizontal gap means a new column or a separate field.
      if (item.hasEOL) {
        lines.push(line.trim());
        line = "";
      }
      lastY = y;
    }
    if (line.trim()) lines.push(line.trim());
    pages.push(lines.join("\n"));

    if (content.items.length === 0 && pageNumber === 1) {
      warnings.push("这份 PDF 可能是扫描件，没有可提取的文字。请上传可复制的 PDF 或 DOCX。");
    }
  }

  await document.destroy();
  return { text: pages.join("\n\n"), pages, warnings };
}

async function extractDocx(file: File): Promise<ExtractedText> {
  const mammoth = await import("mammoth/mammoth.browser.js");
  const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  const warnings: string[] = [];
  if (result.messages.length > 0) {
    const notable = result.messages.filter((message) => message.type === "error");
    if (notable.length > 0) warnings.push("文档中有部分内容无法读取，请核对解析结果。");
  }
  return { text: result.value, warnings };
}

/** Read a JD from a file, reusing the same extraction path. */
export async function extractJd(file: File): Promise<string> {
  const result = await extractText(file);
  return result.text;
}

/** Accept only what we can actually parse, and say why when we cannot. */
export const ACCEPTED_TYPES =
  ".pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown";

export function validateFile(file: File, limitMb = 12): string | undefined {
  if (file.size > limitMb * 1024 * 1024) {
    return `文件超过 ${limitMb} MB，请压缩后重试。`;
  }
  const name = file.name.toLowerCase();
  const ok =
    name.endsWith(".pdf") ||
    name.endsWith(".docx") ||
    name.endsWith(".txt") ||
    name.endsWith(".md") ||
    file.type.startsWith("text/");
  if (!ok) return "只支持 PDF、DOCX、TXT 或 MD 格式。";
  return undefined;
}
