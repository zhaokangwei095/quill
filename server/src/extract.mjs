/**
 * The resume pipeline behind `POST /api/resume/extract`.
 *
 *    bytes ──► text ──► u2-flash ──► validated draft
 *      │         ▲
 *      └─ PDF ───┴── u2-ocr (only when the PDF has no usable text layer)
 *
 * Digital files keep their exact characters; OCR is reserved for scans and
 * images, where there is no text to keep. Either way the structured step is a
 * model, and its output is still validated against the same rules as a local
 * parse before it can reach a profile.
 */

import { ProviderError, ocrPage, structureResume } from "./unisound.mjs";
import { readPdfText, renderPdfPages } from "./pdf.mjs";

const MAX_TEXT_CHARS = 60_000;
const MAX_STRUCTURE_CHARS = 30_000;
const MIN_PDF_TEXT = 80;

export const MODES = new Set(["auto", "ocr", "text"]);

function sniff(bytes) {
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  return undefined;
}

function joinOcr(results) {
  return results
    .map((result) => result.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

function totalUsage(results, extra) {
  const totals = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  for (const result of results) {
    totals.promptTokens += result.usage?.promptTokens ?? 0;
    totals.completionTokens += result.usage?.completionTokens ?? 0;
    totals.totalTokens += result.usage?.totalTokens ?? 0;
  }
  if (extra) {
    totals.promptTokens += extra.promptTokens ?? 0;
    totals.completionTokens += extra.completionTokens ?? 0;
    totals.totalTokens += extra.totalTokens ?? 0;
  }
  return totals;
}

async function runOcr(pages, { signal, warnings }) {
  const results = [];
  for (const page of pages) {
    const result = await ocrPage(page.png, { page: page.page, signal });
    if (!result.text.trim()) {
      warnings.push(`第 ${page.page} 页没有识别到文字，请核对原文件。`);
    }
    results.push(result);
  }
  return results;
}

/**
 * @param {object} input
 * @param {string} input.mode        auto | ocr | text
 * @param {Buffer} [input.bytes]     uploaded file
 * @param {string} [input.text]      text already extracted by the client
 * @param {string} [input.filename]
 * @param {AbortSignal} [input.signal]
 */
export async function extractResume({ mode = "auto", bytes, text, filename, signal }) {
  if (!MODES.has(mode)) {
    throw new ProviderError("BAD_MODE", "不支持的识别模式。", 400);
  }

  const warnings = [];
  const started = Date.now();
  let source = "text";
  let pageCount = 1;
  let resumeText = "";
  let ocrUsage;
  const kind = bytes ? sniff(bytes) : undefined;

  if (bytes) {
    if (!kind) {
      throw new ProviderError(
        "UNSUPPORTED_FILE",
        "无法识别这个文件的格式，请上传 PDF、PNG、JPG、DOCX 或 TXT。",
        400,
      );
    }
    const name = filename || `resume.${kind === "jpeg" ? "jpg" : kind}`;

    if (kind === "pdf") {
      let pdfText;
      if (mode !== "ocr") {
        try {
          pdfText = await readPdfText(bytes, { maxPages: 8 });
        } catch {
          pdfText = undefined;
        }
      }

      const usable = pdfText && pdfText.text.replace(/\s/g, "").length >= MIN_PDF_TEXT;
      if (mode === "text" && !usable) {
        throw new ProviderError(
          "PDF_WITHOUT_TEXT",
          "这份 PDF 没有可提取的文字，可能是扫描件。请改用自动识别或 OCR 重读。",
          422,
        );
      }

      if (usable) {
        resumeText = pdfText.text;
        pageCount = pdfText.pageCount;
        if (pdfText.sawAnyText && pdfText.pages.some((page) => !page.trim())) {
          warnings.push("PDF 中有页面没有可提取的文字，已跳过这些页面；如内容缺失，请用 OCR 重读。");
        }
      } else {
        source = "ocr";
        let rendered;
        try {
          rendered = await renderPdfPages(bytes, {
            maxPages: Number(process.env.QUILL_OCR_MAX_PAGES ?? 4),
          });
        } catch {
          throw new ProviderError(
            "OCR_BAD_FILE",
            "这个 PDF 无法打开或已加密，请换一份文件重试。",
            400,
          );
        }
        pageCount = rendered.pageCount;
        if (pageCount > rendered.pages.length) {
          warnings.push(`这份 PDF 有 ${pageCount} 页，本次只识别了前 ${rendered.pages.length} 页。`);
        }
        const results = await runOcr(rendered.pages, { signal, warnings });
        ocrUsage = totalUsage(results);
        resumeText = joinOcr(results);
        if (!resumeText.trim()) {
          throw new ProviderError(
            "OCR_EMPTY",
            "没有从这份文件里识别出文字，请换一份更清晰的 PDF 或图片。",
            422,
          );
        }
      }
    } else {
      if (mode === "text") {
        throw new ProviderError("UNSUPPORTED_FILE", "图片需要开启 OCR 才能识别。", 400);
      }
      source = "ocr";
      const results = await runOcr([{ page: 1, png: Buffer.from(bytes) }], { signal, warnings });
      ocrUsage = totalUsage(results);
      resumeText = joinOcr(results);
      if (!resumeText.trim()) {
        throw new ProviderError("OCR_EMPTY", "没有从这张图片里识别出文字，请换一张更清晰的文件。", 422);
      }
      if (!/\.(png|jpe?g)$/i.test(name)) warnings.push("图片格式已按 PNG/JPEG 处理，请核对结果。");
    }
  } else {
    resumeText = typeof text === "string" ? text : "";
    if (mode === "ocr") {
      throw new ProviderError("NO_FILE", "OCR 模式需要上传文件。", 400);
    }
    if (resumeText.trim().length < 20) {
      throw new ProviderError("TEXT_TOO_SHORT", "提取到的简历文字过少，请换一份文件重试。", 422);
    }
  }

  resumeText = resumeText.trim().slice(0, MAX_TEXT_CHARS);
  if (resumeText.length > MAX_STRUCTURE_CHARS) {
    warnings.push("简历文字较长，结构化只使用了前一部分内容，请核对。");
  }

  const structured = await structureResume(resumeText.slice(0, MAX_STRUCTURE_CHARS), { signal });

  return {
    ok: true,
    source,
    pageCount,
    text: resumeText,
    draft: structured.draft,
    warnings: [...new Set([...warnings, ...structured.warnings])],
    usage: {
      ocr: ocrUsage ?? null,
      structure: structured.usage,
      total: totalUsage(ocrUsage ? [{ usage: ocrUsage }] : [], structured.usage),
    },
    elapsedMs: Date.now() - started,
    model: { ocr: "u2-ocr", structure: "u2-flash" },
  };
}
