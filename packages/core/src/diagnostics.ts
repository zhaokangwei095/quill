/**
 * Diagnostics: the part of the product that helps us fix the product.
 *
 * The design constraint is trust. A diagnostic bundle must be useful enough to
 * reproduce a scan/plan/fill failure without the page, while never carrying the
 * person's answers, resume text or identity. So this module has two jobs:
 *
 *   1. define a small, stable schema (events + last-operation snapshot), and
 *   2. redact aggressively on the way out — by key name for structured data,
 *      and by pattern for any free text that slipped through.
 *
 * It is environment-agnostic on purpose: the same schema is produced in the
 * service worker and consumed by tests and the support tooling.
 */

export type DiagnosticLevel = "debug" | "info" | "warn" | "error";

export type DiagnosticScope = "content" | "worker" | "panel" | "workbench" | "popup" | "options";

export interface DiagnosticEvent {
  schemaVersion: 1;
  id: string;
  at: number;
  level: DiagnosticLevel;
  scope: DiagnosticScope;
  /** Stable, searchable event name, e.g. `fill.completed`. */
  event: string;
  /** Ties events from one scan/fill together. */
  opId?: string;
  siteKey?: string;
  data?: Record<string, unknown>;
}

/** A field's shape, never its value. */
export interface DiagnosticField {
  label: string;
  key?: string;
  confidence?: number;
  labelSource?: string;
  section?: string;
  kind?: string;
  framework?: string;
  required?: boolean;
  repeatIndex?: number;
}

export interface DiagnosticPage {
  siteKey: string;
  /** Origin + path (+ safe hash route), never query parameters. */
  url: string;
  title?: string;
}

export interface DiagnosticPlanDecision {
  label: string;
  key: string;
  status: string;
  confidence?: number;
  evidence?: string;
}

export interface DiagnosticPlan {
  tally: Record<string, number>;
  notes: string[];
  decisions: DiagnosticPlanDecision[];
}

export interface DiagnosticSections {
  empty: Array<{
    key: string;
    label: string;
    fieldCount?: number;
    /** Rows the page already renders. */
    existing?: number;
    /** Rows a fill would add. */
    toAdd?: number;
  }>;
  added: Array<{ label: string; rows: number }>;
}

export interface DiagnosticFill {
  filled: number;
  failed: number;
  skipped: number;
  outcomes: Array<{ label: string; ok: boolean; reason?: string }>;
  prepared?: Array<{ label: string; rows: number }>;
}

export interface DiagnosticError {
  event?: string;
  message: string;
  stack?: string;
}

/** What the last operation looked like. Contains no answers. */
export interface DiagnosticSnapshot {
  page?: DiagnosticPage;
  scan?: {
    fieldCount: number;
    ats?: string;
    fields: DiagnosticField[];
  };
  plan?: DiagnosticPlan;
  sections?: DiagnosticSections;
  fill?: DiagnosticFill;
  errors?: DiagnosticError[];
}

export interface DiagnosticEnvironment {
  browser: string;
  platform: string;
  language: string;
  extensionVersion: string;
}

export interface DiagnosticBundle {
  schemaVersion: 1;
  reportId: string;
  createdAt: number;
  /** The person's own description of what went wrong. */
  description?: string;
  environment: DiagnosticEnvironment;
  snapshot: DiagnosticSnapshot;
  events: DiagnosticEvent[];
}

export interface DiagnosticsState {
  events: DiagnosticEvent[];
  snapshot?: DiagnosticSnapshot;
}

export const DIAGNOSTIC_EVENT_LIMIT = 500;
export const DIAGNOSTIC_BYTE_LIMIT = 256_000;

/* ------------------------------------------------------------------ ids */

let sequence = 0;

/** Short, sortable id. Uniqueness only needs to hold within one browser session. */
export function diagnosticId(prefix: string): string {
  sequence = (sequence + 1) % 1_000_000;
  return `${prefix}-${Date.now().toString(36)}-${sequence.toString(36)}`;
}

export function createDiagnosticEvent(input: {
  scope: DiagnosticScope;
  level?: DiagnosticLevel;
  event: string;
  opId?: string;
  siteKey?: string;
  data?: Record<string, unknown>;
}): DiagnosticEvent {
  return {
    schemaVersion: 1,
    id: diagnosticId("ev"),
    at: Date.now(),
    level: input.level ?? "info",
    scope: input.scope,
    event: input.event,
    ...(input.opId ? { opId: input.opId } : {}),
    ...(input.siteKey ? { siteKey: input.siteKey } : {}),
    ...(input.data ? { data: input.data } : {}),
  };
}

/* -------------------------------------------------------------- redaction */

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_PATTERN = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
const ID_CARD_PATTERN = /(?<!\d)\d{17}[\dXx](?!\d)/g;
const LONG_TOKEN_PATTERN = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;

/**
 * Scrub free text. This is defence in depth: callers already avoid logging
 * values, but error messages and third-party stack traces can embed anything.
 */
export function redactText(input: string): string {
  return input
    .replace(BEARER_PATTERN, "Bearer [token]")
    .replace(EMAIL_PATTERN, "[email]")
    .replace(PHONE_PATTERN, "[phone]")
    .replace(ID_CARD_PATTERN, "[id]")
    .replace(LONG_TOKEN_PATTERN, "[token]")
    .replace(URL_PATTERN, (match) => sanitizePageUrl(match).url)
    .slice(0, 8_000);
}

const SENSITIVE_KEY =
  /^(value|values|password|passwd|pwd|token|access_?token|refresh_?token|secret|cookie|authorization|auth|answer|actual|proposed_?values|resume|resume_?text|raw_?text|content|html|outer_?html|inner_?html|body|text)$/i;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key) || /value(s)?$/i.test(key);
}

/**
 * Recursively redact structured data.
 *
 * Objects are walked by key; arrays are treated as sequences of the same kind
 * of thing, which is how our events use them. Depth and width are bounded so a
 * pathological object cannot turn a diagnostic export into a memory event.
 */
export function redactData(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth-limited]";
  if (typeof value === "string") return redactText(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => redactData(item, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (count >= 200) break;
      out[key] = isSensitiveKey(key) ? "[redacted]" : redactData(item, depth + 1);
      count += 1;
    }
    return out;
  }
  return String(value);
}

export function redactEvent(event: DiagnosticEvent): DiagnosticEvent {
  return {
    ...event,
    ...(event.siteKey ? { siteKey: redactText(event.siteKey) } : {}),
    ...(event.data ? { data: redactData(event.data) as Record<string, unknown> } : {}),
  };
}

/* ------------------------------------------------------------------- urls */

/**
 * Keep the parts that identify the page, drop the parts that leak.
 *
 * Query strings routinely carry session ids, emails and prefill tokens. The
 * path identifies the job; a hash route identifies the SPA step. Everything
 * after a `?` goes, including inside the hash.
 */
export function sanitizePageUrl(raw: string): { url: string; siteKey: string } {
  try {
    const parsed = new URL(raw);
    const siteKey = parsed.hostname.replace(/^www\./, "");
    const hash = parsed.hash && parsed.hash.startsWith("#/") && !parsed.hash.includes("?")
      ? parsed.hash.slice(0, 120)
      : "";
    const path = parsed.pathname.slice(0, 180);
    return { url: `${parsed.origin}${path}${hash}`, siteKey };
  } catch {
    return { url: raw.split("?")[0]?.slice(0, 240) ?? "", siteKey: "" };
  }
}

/* ------------------------------------------------------------ ring buffer */

/** Append one event, dropping the oldest once the count limit is reached. */
export function appendDiagnosticEvent(
  events: DiagnosticEvent[],
  event: DiagnosticEvent,
  limit = DIAGNOSTIC_EVENT_LIMIT,
): DiagnosticEvent[] {
  const next = [...events, redactEvent(event)];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

/**
 * Enforce both the count and the byte budget.
 *
 * `chrome.storage.local` holds about 10 MB in total, and the profile, memory
 * and ledger all live there. Diagnostics get a hard 256 KB ceiling so a busy
 * debug session can never evict someone's resume.
 */
export function compactDiagnosticEvents(
  events: DiagnosticEvent[],
  byteLimit = DIAGNOSTIC_BYTE_LIMIT,
  eventLimit = DIAGNOSTIC_EVENT_LIMIT,
): DiagnosticEvent[] {
  let next = events.slice(-eventLimit);
  if (next.length === 0) return next;

  let bytes = JSON.stringify(next).length;
  while (bytes > byteLimit && next.length > 1) {
    // Drop 10% at a time; dropping one event at a time would stringify the
    // whole array repeatedly on a large buffer.
    const drop = Math.max(1, Math.ceil(next.length * 0.1));
    next = next.slice(drop);
    bytes = JSON.stringify(next).length;
  }
  return next;
}

/* ----------------------------------------------------------------- bundle */

export function buildDiagnosticBundle(input: {
  reportId: string;
  createdAt: number;
  description?: string;
  environment: DiagnosticEnvironment;
  snapshot: DiagnosticSnapshot;
  events: DiagnosticEvent[];
}): DiagnosticBundle {
  return {
    schemaVersion: 1,
    reportId: input.reportId,
    createdAt: input.createdAt,
    ...(input.description?.trim() ? { description: redactText(input.description.trim()).slice(0, 4_000) } : {}),
    environment: {
      browser: redactText(input.environment.browser).slice(0, 400),
      platform: redactText(input.environment.platform).slice(0, 120),
      language: redactText(input.environment.language).slice(0, 40),
      extensionVersion: redactText(input.environment.extensionVersion).slice(0, 40),
    },
    snapshot: redactData(input.snapshot) as DiagnosticSnapshot,
    events: compactDiagnosticEvents(input.events.map(redactEvent)),
  };
}
