/**
 * @quill/core — the shared brain.
 *
 * Everything in here is environment-agnostic: it runs in the extension's
 * service worker, in a content script, and in the web workbench unchanged. The
 * only DOM-aware code lives in `extension/src/content`, and the only storage
 * code lives behind the `Store` interface.
 */

export * from "./types.js";
export * from "./text.js";
export * from "./profile.js";
export * from "./profileMatch.js";
export * from "./resume/reparse.js";
export * from "./fields/index.js";
export * from "./resume/index.js";
export * from "./strategy/index.js";
export * from "./tailor/index.js";
export * from "./ledger/index.js";
export * from "./diagnostics.js";
