/**
 * Thin wrappers around the message protocol.
 *
 * The UI never touches `chrome.*` directly for data: every read and write goes
 * through here, so there is exactly one place where a response is unwrapped and
 * exactly one place where a failure becomes an exception.
 */

import type { ExtensionRequest, ExtensionResponse, ExtensionState } from "../shared/protocol.js";

/** Send a request and throw on failure. */
export async function send<R extends ExtensionResponse>(request: ExtensionRequest): Promise<R> {
  const response = (await chrome.runtime.sendMessage(request)) as R | undefined;
  if (!response) throw new Error("扩展后台没有响应，请重试");
  if (!response.ok) throw new Error(response.error);
  return response;
}

/** Send a request, returning undefined instead of throwing. */
export async function trySend<R extends ExtensionResponse>(request: ExtensionRequest): Promise<R | undefined> {
  try {
    return await send<R>(request);
  } catch (error) {
    console.warn("[quill]", error);
    return undefined;
  }
}

export async function getState(): Promise<ExtensionState> {
  const response = await send<Extract<ExtensionResponse, { type: "get-state" }>>({ type: "get-state" });
  return response.state;
}

/**
 * Subscribe to state broadcasts. Returns an unsubscribe function so React
 * effects cannot leak listeners across remounts.
 */
export function onStateChanged(listener: (state: ExtensionState) => void): () => void {
  const handler = (message: unknown): void => {
    if (typeof message === "object" && message !== null && (message as { type?: string }).type === "state-changed") {
      listener((message as { state: ExtensionState }).state);
    }
  };
  chrome.runtime.onMessage.addListener(handler);
  return () => chrome.runtime.onMessage.removeListener(handler);
}

/**
 * Apply the person's appearance preference to <html>. `system` follows the OS
 * via the media query in the token sheet, so it needs no attribute at all.
 */
export function applyAppearance(appearance: "system" | "light" | "dark"): void {
  const root = document.documentElement;
  if (appearance === "system") root.removeAttribute("data-appearance");
  else root.dataset.appearance = appearance;
}

/** A stable id for React lists built from strings. */
export function keyOf(...parts: Array<string | number | undefined>): string {
  return parts.filter((part) => part !== undefined).join("::");
}

/** Human-readable relative time, in the register the rest of the UI uses. */
export function relativeTime(at: number, now = Date.now()): string {
  const diff = now - at;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function formatDate(at: number | undefined): string {
  if (!at) return "";
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Copy text, with a fallback for the clipboard API being unavailable. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** Trigger a file download from a Blob, without leaking an object URL. */
export function download(filename: string, content: string, mime = "text/plain;charset=utf-8"): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Give the browser a beat to start the download before revoking.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
