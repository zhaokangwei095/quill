/**
 * Watching for answers the person types themselves.
 *
 * This is the "learn from what the user does" half of the product. The rule is
 * narrow on purpose: we only learn from a field the engine *did not* fill. If
 * the person edits a value we proposed, that is a correction and it is handled
 * explicitly by the panel, not silently here.
 *
 * Why `change` rather than `input`: `input` fires on every keystroke, and typing
 * "13800138000" would emit eleven observations. `change` fires when the field is
 * committed — on blur or Enter — which is exactly when a value is final.
 */

import type { FieldDescriptor, PageScan } from "@quill/core";

export interface WatchOptions {
  getScan: () => PageScan | undefined;
  /** Values we proposed for a ref, so we can detect a correction. */
  getProposed: (ref: string) => string[];
  isEnabled: () => Promise<boolean>;
  onObserved: (field: FieldDescriptor, value: string) => Promise<void>;
  /** Re-scan after a person commits any field value, even if learning is off. */
  onFieldCommitted?: (field: FieldDescriptor, value: string) => Promise<void>;
  /**
   * True while the extension is writing into the page.
   *
   * The filler dispatches real `input`/`change`/`blur` events, because that is
   * what React and Vue listen for. Those events are indistinguishable from a
   * person's unless we are told they are ours — and without this flag the
   * extension observed its own writes and "learned" every value it had just
   * proposed, which both duplicated the profile into memory and destroyed
   * provenance.
   */
  isFilling: () => boolean;
}

/** Fields we never learn from, whatever the user does. */
const IGNORED_INPUT_TYPES = new Set(["password", "hidden", "file", "submit", "button", "image", "reset"]);

export function startLearningWatcher(options: WatchOptions): () => void {
  let enabled = false;
  /** Debounce per element, so a blur followed by a change is one observation. */
  const recentlySeen = new WeakMap<HTMLElement, number>();
  /** Values we recorded, keyed by ref, so we do not re-report the same thing. */
  const lastReported = new Map<string, string>();
  /** Values already re-scanned after commit; avoids duplicate blur/change scans. */
  const lastCommitted = new Map<string, string>();

  void options
    .isEnabled()
    .then((value) => {
      enabled = value;
    })
    .catch(() => {
      enabled = false;
    });

  const handle = async (event: Event, element: HTMLElement): Promise<void> => {
    if (event.type === "input") return; // only `change` and `blur` reach here

    const inputType = element instanceof HTMLInputElement ? element.type.toLowerCase() : "";
    if (IGNORED_INPUT_TYPES.has(inputType)) return;

    // A checkbox or radio is an interaction, not a typed answer. Radios and
    // checkboxes are also very often form plumbing ("同意条款") we must not learn.
    if (inputType === "checkbox" || inputType === "radio") return;

    const now = Date.now();
    const seen = recentlySeen.get(element);
    // Two events within 250ms are the same commit.
    if (seen !== undefined && now - seen < 250) return;
    recentlySeen.set(element, now);

    const scan = options.getScan();
    if (!scan) return;

    const field = matchField(element, scan);
    /*
     * Unclassified fields are the ones learning exists for: 导师, 内推串码, an
     * employer's own AI-tools question. `considerObservation` files them under a
     * label-derived custom key, so filtering them out here discarded exactly the
     * answers the person had to type by hand.
     */
    if (!field) return;

    const value = readRaw(element);
    if (!value) return;

    // Never observe or re-scan while the extension is the one writing.
    if (options.isFilling()) return;

    // Never learn our own output, nor re-scan a duplicate commit.
    const proposed = options.getProposed(field.ref);
    if (proposed.some((candidate) => normalize(candidate) === normalize(value))) return;
    if (lastCommitted.get(field.ref) === value) return;
    lastCommitted.set(field.ref, value);

    if (enabled && lastReported.get(field.ref) !== value) {
      lastReported.set(field.ref, value);
      try {
        await options.onObserved(field, value);
      } catch {
        // A learning failure must not suppress the page re-scan.
      }
    }

    // Updating the page is independent of the optional learning preference.
    await options.onFieldCommitted?.(field, value);
  };

  const listener = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.closest("quill-panel")) return; // our own UI
    void handle(event, target);
  };

  /*
   * Capture phase: many sites stop propagation of `change`, and a capturing
   * listener still sees the event before that happens.
   */
  document.addEventListener("change", listener, true);
  document.addEventListener("blur", listener, true);

  return () => {
    document.removeEventListener("change", listener, true);
    document.removeEventListener("blur", listener, true);
  };
}

/**
 * Find the descriptor for a live element. Descriptors were produced by a prior
 * scan, so we match on the same identity the scanner used — id first, then the
 * element's own attributes, then position in the document.
 */
function matchField(element: HTMLElement, scan: PageScan): FieldDescriptor | undefined {
  const id = element.getAttribute("id");
  if (id) {
    const byId = scan.fields.find((field) => field.ref === `id:${id}`);
    if (byId) return byId;
  }

  const name = element.getAttribute("name");
  if (name) {
    const candidates = scan.fields.filter((field) => field.name === name);
    if (candidates.length === 1) return candidates[0];
  }

  // Positional reconciliation against the live field list.
  const live = liveFields();
  const index = live.indexOf(element);
  if (index >= 0) {
    const positional = scan.fields[index];
    if (positional && labelsAgree(positional, element)) return positional;
  }

  // Last resort: the visible label must match.
  return scan.fields.find((field) => labelsAgree(field, element));
}

function liveFields(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      "input:not([type='hidden']):not([type='submit']):not([type='button']):not([type='reset']),select,textarea,[contenteditable='true']",
    ),
  );
}

function labelsAgree(field: FieldDescriptor, element: HTMLElement): boolean {
  const own = (element.getAttribute("aria-label") ?? element.getAttribute("placeholder") ?? "").trim();
  if (!own) return true; // nothing to contradict
  if (!field.label) return true;
  const a = normalize(field.label);
  const b = normalize(own);
  return a.includes(b) || b.includes(a);
}

function readRaw(element: HTMLElement): string {
  if (element instanceof HTMLSelectElement) {
    /*
     * A `<select>` is neither an input nor a textarea, so an earlier version
     * fell through to `textContent` and read the *entire option list*
     * ("请选择\n男\n女") as the answer. Read the chosen option instead.
     */
    if (element.multiple) {
      return Array.from(element.selectedOptions)
        .map((option) => option.textContent?.trim() ?? "")
        .join("、");
    }
    const chosen = element.selectedOptions[0];
    // Ignore the "please choose" placeholder: it is not an answer.
    return chosen && chosen.value ? (chosen.textContent?.trim() ?? "") : "";
  }
  if (element instanceof HTMLInputElement) {
    if (element.type === "checkbox" || element.type === "radio") return "";
    return element.value.trim();
  }
  if (element instanceof HTMLTextAreaElement) {
    return element.value.trim();
  }
  return (element.textContent ?? "").trim();
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "").replace(/[*＊]/g, "");
}
