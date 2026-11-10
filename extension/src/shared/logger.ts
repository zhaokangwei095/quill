/**
 * Extension-side logging helpers.
 *
 * The rule is simple: logging is always best-effort. Every function here
 * swallows its own failure, because a diagnostic pipeline that can break a fill
 * is worse than no diagnostics at all.
 *
 * Events are sent to the service worker, which is the only writer. Keeping a
 * single sink means events from a content script, the panel and the workbench
 * end up in one ordered ring buffer instead of three private ones.
 */

import {
  createDiagnosticEvent,
  redactText,
  type DiagnosticBundle,
  type DiagnosticLevel,
  type DiagnosticScope,
  type DiagnosticSnapshot,
} from "@quill/core";
import type { ExtensionRequest, ExtensionResponse } from "./protocol.js";

let opSequence = 0;

/** A short id that groups all events from one scan/fill. */
export function newOperationId(prefix: string): string {
  opSequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${opSequence.toString(36)}`;
}

export async function logEvent(
  scope: DiagnosticScope,
  level: DiagnosticLevel,
  event: string,
  data?: Record<string, unknown>,
  context?: { opId?: string; siteKey?: string },
): Promise<void> {
  try {
    const payload = createDiagnosticEvent({
      scope,
      level,
      event,
      ...(context?.opId ? { opId: context.opId } : {}),
      ...(context?.siteKey ? { siteKey: context.siteKey } : {}),
      ...(data ? { data } : {}),
    });
    await chrome.runtime.sendMessage({ type: "log-event", event: payload } satisfies ExtensionRequest);
  } catch {
    // No listener, worker asleep, extension reloading — none of these should
    // ever surface as an error in the page.
  }
}

export function logSoon(
  scope: DiagnosticScope,
  level: DiagnosticLevel,
  event: string,
  data?: Record<string, unknown>,
  context?: { opId?: string; siteKey?: string },
): void {
  void logEvent(scope, level, event, data, context);
}

function describeError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      message: redactText(error.message || error.name || "Error"),
      ...(error.stack ? { stack: redactText(error.stack).slice(0, 4_000) } : {}),
    };
  }
  if (typeof error === "string") return { message: redactText(error) };
  try {
    return { message: redactText(JSON.stringify(error)).slice(0, 1_000) };
  } catch {
    return { message: "未知错误" };
  }
}

export function captureException(
  scope: DiagnosticScope,
  event: string,
  error: unknown,
  data?: Record<string, unknown>,
  context?: { opId?: string; siteKey?: string },
): void {
  const described = describeError(error);
  logSoon(
    scope,
    "error",
    event,
    { ...data, ...described },
    context,
  );
}

/**
 * Catch errors that escape our own try/catch blocks.
 *
 * React errors are caught by the error boundary separately; this covers the
 * browser-level errors that would otherwise exist only in a console the person
 * will never open.
 */
const INSTALLED = new Set<DiagnosticScope>();

export function installGlobalErrorCapture(scope: DiagnosticScope): void {
  if (INSTALLED.has(scope) || typeof window === "undefined") return;
  INSTALLED.add(scope);

  window.addEventListener("error", (event) => {
    captureException(scope, "window.error", event.error ?? event.message, {
      source: event.filename ?? "",
      line: event.lineno ?? 0,
      column: event.colno ?? 0,
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    captureException(scope, "window.unhandledrejection", event.reason);
  });
}

/** Persist the context of the current operation for the diagnostic bundle. */
export async function saveDiagnosticSnapshot(snapshot: DiagnosticSnapshot): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: "diagnostics-snapshot", snapshot } satisfies ExtensionRequest);
  } catch {
    // Best-effort.
  }
}

export async function exportDiagnostics(description?: string): Promise<DiagnosticBundle | undefined> {
  try {
    const response = (await chrome.runtime.sendMessage({
      type: "diagnostics-export",
      ...(description?.trim() ? { description: description.trim() } : {}),
    } satisfies ExtensionRequest)) as ExtensionResponse;
    if (response.ok && response.type === "diagnostics-export") return response.bundle;
  } catch {
    // Fall through.
  }
  return undefined;
}

export async function clearDiagnostics(): Promise<boolean> {
  try {
    const response = (await chrome.runtime.sendMessage({
      type: "diagnostics-clear",
    } satisfies ExtensionRequest)) as ExtensionResponse;
    return response.ok && response.type === "diagnostics-clear";
  } catch {
    return false;
  }
}
