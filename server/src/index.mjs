/**
 * Quill's resume recognition service.
 *
 * One job: accept a resume, run OCR when needed, and return a structured draft.
 * The platform key lives only in this process's environment. The service keeps
 * no files, no database and no logs of resume content.
 *
 *   POST /api/resume/extract    file bytes (or JSON { text }) -> draft
 *   GET  /api/health            liveness + whether a key is configured
 *
 * Run:  UNISOUND_API_KEY=... node server/src/index.mjs
 */

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { extractResume, MODES } from "./extract.mjs";
import { ProviderError } from "./unisound.mjs";

try {
  const envFile = new URL("../.env", import.meta.url);
  if (typeof process.loadEnvFile === "function") {
    process.loadEnvFile(envFile);
  } else {
    // Node 20.11 lacks loadEnvFile; keep the documented .env workflow working.
    for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (match && !match[1].startsWith("#") && !process.env[match[1]]) {
        process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
      }
    }
  }
} catch {
  // No .env file is normal in production, where the environment is provided.
}

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const MAX_BODY = Number(process.env.QUILL_MAX_UPLOAD_MB ?? 24) * 1024 * 1024;
const REQUEST_TIMEOUT_MS = Number(process.env.QUILL_REQUEST_TIMEOUT_MS ?? 180_000);
const RATE_LIMIT = Number(process.env.QUILL_RATE_LIMIT ?? 20);
const RATE_WINDOW_MS = 10 * 60_000;
const MAX_CONCURRENT = Number(process.env.QUILL_MAX_CONCURRENT ?? 3);
const DAILY_LIMIT = Number(process.env.QUILL_DAILY_LIMIT ?? 200);
const VERSION = "0.1.3";

/**
 * Private beta gate. When any code is configured, extraction requires the
 * matching `X-Quill-Beta` header. The code is a shared access credential, not
 * a user account; it exists to keep the platform key from becoming an open
 * proxy while the product is being tested.
 */
const BETA_CODES = new Set(
  [process.env.QUILL_BETA_CODE, process.env.QUILL_BETA_CODES]
    .filter((value) => typeof value === "string" && value.length > 0)
    .flatMap((value) => value.split(","))
    .map((code) => code.trim())
    .filter(Boolean),
);

const ALLOWED_ORIGINS = (process.env.QUILL_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const BINARY_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "application/octet-stream",
]);

/* ----------------------------------------------------------------- plumbing */

function resolveOrigin(requestOrigin) {
  if (ALLOWED_ORIGINS.length === 0) return "*";
  if (requestOrigin && ALLOWED_ORIGINS.includes(requestOrigin)) return requestOrigin;
  return undefined;
}

function sendJson(res, status, body, origin) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    ...(origin ? { "access-control-allow-origin": origin, vary: "origin" } : {}),
  });
  res.end(payload);
}

function sendError(res, status, code, message, origin, requestId) {
  sendJson(res, status, { ok: false, error: { code, message }, requestId }, origin);
}

const hits = new Map();

function rateLimited(key) {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((time) => now - time < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(key, recent);
  return recent.length > RATE_LIMIT;
}

setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [key, times] of hits) {
    const recent = times.filter((time) => time > cutoff);
    if (recent.length === 0) hits.delete(key);
    else hits.set(key, recent);
  }
}, RATE_WINDOW_MS).unref();

function clientIp(req) {
  if (process.env.TRUST_PROXY === "1") {
    /*
     * Cloudflare sets CF-Connecting-IP and clients cannot forge it. Prefer it
     * over X-Forwarded-For, whose first value can be supplied by the caller.
     */
    const cloudflare = req.headers["cf-connecting-ip"];
    if (typeof cloudflare === "string" && cloudflare.length > 0) {
      return cloudflare.trim();
    }
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.length > 0) {
      return forwarded.split(",")[0].trim();
    }
  }
  return req.socket.remoteAddress ?? "unknown";
}

function betaStatus(req) {
  if (BETA_CODES.size === 0) return { required: false, ok: true, provided: false };
  const provided = String(req.headers["x-quill-beta"] ?? "").trim();
  return {
    required: true,
    ok: provided.length > 0 && BETA_CODES.has(provided),
    provided: provided.length > 0,
  };
}

let daily = { day: "", count: 0 };

/** Reserve one extraction slot for today. `0` means unlimited. */
function takeDailySlot() {
  if (!(DAILY_LIMIT > 0)) return true;
  const today = new Date().toISOString().slice(0, 10);
  if (daily.day !== today) daily = { day: today, count: 0 };
  if (daily.count >= DAILY_LIMIT) return false;
  daily.count += 1;
  return true;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > limit) {
      req.resume();
      reject(new ProviderError("FILE_TOO_LARGE", "文件超过服务器允许的大小，请压缩后重试。", 413));
      return;
    }

    const chunks = [];
    let size = 0;
    let tooLarge = false;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) {
        reject(new ProviderError("FILE_TOO_LARGE", "文件超过服务器允许的大小，请压缩后重试。", 413));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

/* ------------------------------------------------------------------- routes */

async function handleExtract(req, res, origin, requestId) {
  const started = Date.now();

  if (rateLimited(clientIp(req))) {
    sendError(
      res,
      429,
      "RATE_LIMIT",
      "识别请求过于频繁，请稍等几分钟再试。",
      origin,
      requestId,
    );
    return;
  }

  const beta = betaStatus(req);
  if (beta.required && !beta.ok) {
    sendError(
      res,
      beta.provided ? 403 : 401,
      beta.provided ? "BETA_INVALID" : "BETA_REQUIRED",
      beta.provided
        ? "访问码不正确，请核对后重试。"
        : "识别服务需要访问码，请先在设置里填写访问码。",
      origin,
      requestId,
    );
    return;
  }

  if (!takeDailySlot()) {
    sendError(
      res,
      429,
      "DAILY_LIMIT",
      "今天的识别额度已经用完，请明天再试。",
      origin,
      requestId,
    );
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const mode = String(url.searchParams.get("mode") ?? req.headers["x-quill-mode"] ?? "auto")
    .trim()
    .toLowerCase();
  if (!MODES.has(mode)) {
    sendError(res, 400, "BAD_MODE", "不支持的识别模式。", origin, requestId);
    return;
  }

  const type = String(req.headers["content-type"] ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();

  if (type.startsWith("multipart/")) {
    sendError(
      res,
      415,
      "MULTIPART_NOT_SUPPORTED",
      "请以原始文件字节上传（Content-Type 设为文件类型），不需要 multipart。",
      origin,
      requestId,
    );
    return;
  }

  const rawFilename = req.headers["x-quill-filename"];
  let filename;
  if (typeof rawFilename === "string" && rawFilename.length > 0) {
    try {
      filename = decodeURIComponent(rawFilename).slice(0, 200);
    } catch {
      filename = rawFilename.slice(0, 200);
    }
  }

  const body = await readBody(req, MAX_BODY);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    let result;
    if (type === "application/json") {
      let parsed;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        throw new ProviderError("BAD_JSON", "请求内容不是有效的 JSON。", 400);
      }
      result = await extractResume({
        mode,
        text: typeof parsed?.text === "string" ? parsed.text : "",
        filename: typeof parsed?.filename === "string" ? parsed.filename : filename,
        signal: controller.signal,
      });
    } else if (type === "text/plain" || type === "text/markdown") {
      result = await extractResume({
        mode,
        text: body.toString("utf8"),
        filename,
        signal: controller.signal,
      });
    } else if (BINARY_TYPES.has(type) || type === "") {
      result = await extractResume({ mode, bytes: body, filename, signal: controller.signal });
    } else {
      throw new ProviderError(
        "UNSUPPORTED_TYPE",
        "不支持这种文件类型，请上传 PDF、PNG、JPG、DOCX 或 TXT。",
        415,
      );
    }

    sendJson(res, 200, { ...result, requestId }, origin);
    console.log(
      `[${new Date().toISOString()}] ${requestId} extract ok mode=${mode} source=${result.source} pages=${result.pageCount} ${Date.now() - started}ms`,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function route(req, res) {
  const origin = resolveOrigin(req.headers.origin);

  /*
   * CORS headers alone only stop the browser from reading a response; the
   * request would still spend model quota. Refuse a disallowed browser origin
   * outright. Non-browser clients (curl, health checks) send no Origin.
   */
  if (ALLOWED_ORIGINS.length > 0 && req.headers.origin && !origin) {
    sendError(res, 403, "ORIGIN_NOT_ALLOWED", "这个来源不在允许列表中。", undefined, randomUUID().slice(0, 8));
    return;
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      ...(origin ? { "access-control-allow-origin": origin, vary: "origin" } : {}),
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, x-quill-filename, x-quill-mode, x-quill-beta",
      "access-control-max-age": "86400",
    });
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const requestId = randomUUID().slice(0, 8);

  if (url.pathname === "/api/health" && req.method === "GET") {
    sendJson(
      res,
      200,
      {
        ok: true,
        service: "quill-resume",
        version: VERSION,
        modelConfigured: Boolean(process.env.UNISOUND_API_KEY),
        models: { ocr: "u2-ocr", structure: "u2-flash" },
        betaRequired: BETA_CODES.size > 0,
        betaOk: betaStatus(req).ok,
        limits: {
          maxUploadMb: Math.round(MAX_BODY / 1024 / 1024),
          timeoutMs: REQUEST_TIMEOUT_MS,
          dailyLimit: DAILY_LIMIT > 0 ? DAILY_LIMIT : null,
        },
      },
      origin,
    );
    return;
  }

  if (url.pathname === "/api/resume/extract" && req.method === "POST") {
    await handleExtract(req, res, origin, requestId);
    return;
  }

  sendError(res, 404, "NOT_FOUND", "没有这个接口。", origin, requestId);
}

/* ------------------------------------------------------------------- server */

let active = 0;

const server = createServer((req, res) => {
  void (async () => {
    if (active >= MAX_CONCURRENT) {
      sendError(
        res,
        429,
        "SERVER_BUSY",
        "当前识别人数较多，请稍等片刻再试。",
        resolveOrigin(req.headers.origin),
        randomUUID().slice(0, 8),
      );
      return;
    }

    active += 1;
    try {
      await route(req, res);
    } catch (error) {
      const origin = resolveOrigin(req.headers.origin);
      if (error instanceof ProviderError) {
        sendError(res, error.status, error.code, error.message, origin, randomUUID().slice(0, 8));
        console.warn(`[${new Date().toISOString()}] provider ${error.code} status=${error.status}`);
      } else if (error?.name === "AbortError") {
        sendError(
          res,
          504,
          "TIMEOUT",
          "识别超时了，请稍后重试；如果文件较大，可以先压缩。",
          origin,
          randomUUID().slice(0, 8),
        );
      } else {
        sendError(
          res,
          500,
          "INTERNAL",
          "服务器处理这份简历时出错了，请稍后重试。",
          origin,
          randomUUID().slice(0, 8),
        );
        // The name and message only — never the request body.
        console.error(`[${new Date().toISOString()}] internal ${error?.name ?? "Error"}: ${error?.message ?? ""}`);
      }
    } finally {
      active -= 1;
    }
  })();
});

server.requestTimeout = REQUEST_TIMEOUT_MS + 30_000;
server.headersTimeout = 30_000;
server.listen(PORT, HOST, () => {
  console.log(`quill-resume ${VERSION} listening on http://${HOST}:${PORT}`);
  console.log(
    process.env.UNISOUND_API_KEY
      ? "model key: configured"
      : "model key: MISSING — set UNISOUND_API_KEY before using /api/resume/extract",
  );
  if (ALLOWED_ORIGINS.length === 0) {
    console.log("cors: any origin (set QUILL_ALLOWED_ORIGINS to restrict)");
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
