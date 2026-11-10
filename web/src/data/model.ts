/**
 * The recognition server client.
 *
 * Persistence, parsing and every other feature stay on this device; this module
 * is the one place that sends resume content off it, and only when the person
 * has enabled model recognition and accepted the upload notice.
 *
 * The server owns the platform key. Nothing secret is sent from here.
 */

import type { ModelResumeDraft } from "@quill/core";

export type ModelSource = "text" | "ocr";

export interface ModelResumeResult {
  text: string;
  draft: ModelResumeDraft;
  warnings: string[];
  source: ModelSource;
  pageCount: number;
}

export class ModelRequestError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ModelRequestError";
    this.code = code;
  }
}

const TIMEOUT_MS = 180_000;

function normalizeBase(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new ModelRequestError("NO_SERVER", "还没有填写识别服务器地址，请先在设置里填写。");
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new ModelRequestError("BAD_SERVER", "识别服务器地址需要以 http:// 或 https:// 开头。");
  }
  return trimmed;
}

async function post(
  baseUrl: string,
  betaCode: string,
  init: { body: BodyInit; headers: Record<string, string> },
): Promise<ModelResumeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const headers = { ...init.headers };
  const code = betaCode.trim();
  if (code) headers["x-quill-beta"] = code;

  let response: Response;
  try {
    response = await fetch(`${normalizeBase(baseUrl)}/api/resume/extract?mode=auto`, {
      method: "POST",
      headers,
      body: init.body,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof ModelRequestError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new ModelRequestError("TIMEOUT", "识别超时了，请稍后重试；如果文件较大，可以先压缩。");
    }
    throw new ModelRequestError(
      "UNREACHABLE",
      "无法连接识别服务器。请确认服务已启动、地址填写正确，或在设置里关闭模型识别。",
    );
  } finally {
    clearTimeout(timer);
  }

  let payload: Record<string, unknown> | undefined;
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    payload = undefined;
  }

  if (!response.ok || payload?.ok === false) {
    const error = payload?.error as { code?: string; message?: string } | undefined;
    throw new ModelRequestError(
      error?.code ?? `HTTP_${response.status}`,
      error?.message ?? `识别服务器返回了错误（HTTP ${response.status}）。`,
    );
  }

  const result = payload ?? {};
  const text = typeof result.text === "string" ? result.text : "";
  const draft = result.draft;
  if (!text.trim() || !draft || typeof draft !== "object") {
    throw new ModelRequestError("INVALID_RESPONSE", "识别服务器返回的结果不完整，请稍后重试。");
  }

  return {
    text,
    draft: draft as ModelResumeDraft,
    warnings: Array.isArray(result.warnings)
      ? result.warnings.filter((warning): warning is string => typeof warning === "string")
      : [],
    source: result.source === "ocr" ? "ocr" : "text",
    pageCount: typeof result.pageCount === "number" ? result.pageCount : 1,
  };
}

/** Send the original file: the server chooses its text layer or OCR. */
export async function extractFileWithModel(
  file: File,
  baseUrl: string,
  betaCode = "",
): Promise<ModelResumeResult> {
  return post(baseUrl, betaCode, {
    body: file,
    headers: {
      "content-type": file.type || "application/octet-stream",
      "x-quill-filename": encodeURIComponent(file.name),
    },
  });
}

/**
 * Send text the browser already extracted (DOCX/TXT/Markdown).
 *
 * PDFs are not sent this way even when they have a text layer: the server runs
 * the same layout reconstruction and can fall back to OCR if its own read comes
 * back empty.
 */
export async function extractTextWithModel(
  text: string,
  filename: string,
  baseUrl: string,
  betaCode = "",
): Promise<ModelResumeResult> {
  return post(baseUrl, betaCode, {
    body: JSON.stringify({ text, filename }),
    headers: { "content-type": "application/json" },
  });
}

/** Liveness probe used by the settings page. */
export async function checkModelServer(
  baseUrl: string,
  betaCode = "",
): Promise<
  | { ok: true; modelConfigured: boolean; betaRequired: boolean; betaOk: boolean }
  | { ok: false; message: string }
> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  const headers: Record<string, string> = {};
  const code = betaCode.trim();
  if (code) headers["x-quill-beta"] = code;
  try {
    const response = await fetch(`${normalizeBase(baseUrl)}/api/health`, {
      signal: controller.signal,
      headers,
    });
    if (!response.ok) return { ok: false, message: `服务器返回 HTTP ${response.status}。` };
    const payload = (await response.json()) as {
      ok?: boolean;
      modelConfigured?: boolean;
      betaRequired?: boolean;
      betaOk?: boolean;
    };
    if (!payload.ok) return { ok: false, message: "服务器没有就绪。" };
    return {
      ok: true,
      modelConfigured: Boolean(payload.modelConfigured),
      betaRequired: Boolean(payload.betaRequired),
      betaOk: payload.betaOk !== false,
    };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof ModelRequestError
          ? error.message
          : "无法连接服务器，请确认地址正确、服务已启动。",
    };
  } finally {
    clearTimeout(timer);
  }
}
