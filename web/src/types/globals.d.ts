/**
 * Ambient declarations for the browsers-only libraries the workbench loads
 * dynamically.
 *
 * `mammoth/mammoth.browser.js` is the pre-bundled browser build and ships no
 * types of its own (the package's types describe the Node entry point, which
 * pulls in `fs`). Declaring just the shape we use is more honest than casting
 * to `any` at the call site.
 */

declare module "mammoth/mammoth.browser.js" {
  export interface MammothMessage {
    type: "warning" | "error";
    message: string;
  }
  export interface MammothResult {
    value: string;
    messages: MammothMessage[];
  }
  export function extractRawText(input: { arrayBuffer: ArrayBuffer }): Promise<MammothResult>;
}

