/**
 * Recovering the human-readable label for a widget.
 *
 * This is the difference between a useful fill and a harmful one. A form's
 * visible label is frequently not programmatically associated with its input:
 * Chinese ATSs in particular render a `<div>` of text next to a bare `<input>`,
 * or put the label in a table cell. The sources below are tried in order of
 * reliability, and the source used is recorded so the classifier can weight it.
 */

import type { LabelSource } from "@quill/core";

export interface RecoveredLabel {
  text: string;
  source: LabelSource;
}

const MAX_LABEL_LENGTH = 120;

function clean(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .replace(/\s+/g, " ")
    .replace(/[*＊]\s*$/, "")
    .replace(/[:：]\s*$/, "")
    .trim()
    .slice(0, MAX_LABEL_LENGTH);
}

/** Is this element actually rendered? Hidden template nodes must be skipped. */
export function isVisible(element: Element): boolean {
  if (!(element instanceof HTMLElement)) {
    // SVG and friends: fall back to a bounding box check.
    return element.getBoundingClientRect().height > 0;
  }
  if (element.hidden) return false;
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
  // `type=hidden` inputs and zero-size elements are template artifacts.
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  // A field inside a `hidden` container.
  if (element.closest("[hidden],[aria-hidden='true']")) return false;
  return true;
}

/** `label[for]`, or a label that wraps the control. */
function fromLabelElement(element: HTMLElement): RecoveredLabel | undefined {
  if (element.id) {
    const escaped = CSS.escape(element.id);
    const explicit = document.querySelector<HTMLLabelElement>(`label[for="${escaped}"]`);
    if (explicit) {
      const text = clean(explicit.textContent);
      if (text) return { text, source: "label-for" };
    }
  }
  const wrapper = element.closest("label");
  if (wrapper) {
    // Clone and strip the control itself so its value is not read as a label.
    const clone = wrapper.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("input,select,textarea,button,svg,script,style").forEach((node) => node.remove());
    const text = clean(clone.textContent);
    if (text) return { text, source: "wrapper" };
  }
  return undefined;
}

/** `aria-label`, or the concatenation of `aria-labelledby` targets. */
function fromAria(element: HTMLElement): RecoveredLabel | undefined {
  const ariaLabel = clean(element.getAttribute("aria-label"));
  if (ariaLabel) return { text: ariaLabel, source: "aria-label" };

  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => clean(document.getElementById(id)?.textContent))
      .filter(Boolean);
    if (parts.length > 0) return { text: parts.join(" "), source: "aria-labelledby" };
  }
  return undefined;
}

/**
 * Table layouts put the label in a previous cell — extremely common on
 * government, SOE and campus-recruitment portals.
 */
function fromTable(element: HTMLElement): RecoveredLabel | undefined {
  const cell = element.closest("td,th");
  if (!cell) return undefined;

  // Walk back through the preceding cells in the same row.
  let previous = cell.previousElementSibling;
  while (previous) {
    const text = clean(previous.textContent);
    if (text) return { text, source: "table-header" };
    previous = previous.previousElementSibling;
  }

  // Otherwise the label may sit in the cell directly above.
  const row = cell.closest("tr");
  const table = cell.closest("table");
  if (row && table) {
    const index = Array.from(cell.parentElement?.children ?? []).indexOf(cell);
    const previousRow = row.previousElementSibling;
    const above = previousRow?.children[index];
    const text = clean(above?.textContent);
    if (text) return { text, source: "table-header" };
  }
  return undefined;
}

/** Definition lists: `<dt>手机号</dt><dd><input></dd>`. */
function fromDefinitionList(element: HTMLElement): RecoveredLabel | undefined {
  const dd = element.closest("dd");
  if (dd) {
    const dt = dd.previousElementSibling;
    if (dt?.tagName === "DT") {
      const text = clean(dt.textContent);
      if (text) return { text, source: "preceding" };
    }
  }
  const dt = element.closest("dt");
  if (dt) {
    const next = dt.nextElementSibling;
    const text = clean(next?.querySelector("input,select,textarea") ? dt.textContent : "");
    if (text) return { text, source: "preceding" };
  }
  return undefined;
}

/**
 * The nearest preceding "label-like" text node, walking up and across the DOM.
 * This is the workhorse for `<div class="form-item"><span>姓名</span><input></div>`.
 */
function fromPreceding(element: HTMLElement): RecoveredLabel | undefined {
  let current: HTMLElement | null = element;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    // Look at previous siblings within this parent, nearest first.
    let sibling = current.previousElementSibling;
    let hops = 0;
    while (sibling && hops < 3) {
      const text = clean(sibling.textContent);
      const isLabelish =
        text.length > 0 &&
        text.length <= 60 &&
        !sibling.querySelector("input,select,textarea") &&
        !/^\d+$/.test(text);
      if (isLabelish) return { text, source: "preceding" };
      sibling = sibling.previousElementSibling;
      hops += 1;
    }
    current = current.parentElement;
  }
  return undefined;
}

/** The closest heading, used as section context rather than as a label. */
export function nearestHeading(element: Element): string {
  let current: Element | null = element;
  while (current) {
    let sibling: Element | null = current.previousElementSibling;
    while (sibling) {
      if (/^H[1-6]$/.test(sibling.tagName) || sibling.getAttribute("role") === "heading") {
        const text = clean(sibling.textContent);
        if (text) return text;
      }
      // A block whose own text is short and heading-like.
      const text = clean(sibling.textContent);
      if (text && text.length <= 24 && /[经历|信息|要求|技能|意向|评价|背景|情况|资料|联系|教育|工作|项目|证书|获奖]/.test(text)) {
        return text;
      }
      sibling = sibling.previousElementSibling;
    }
    current = current.parentElement;
  }
  return "";
}

/** The group legend of an enclosing fieldset or radiogroup. */
export function groupLegend(element: HTMLElement): string {
  const fieldset = element.closest("fieldset");
  const legend = fieldset?.querySelector("legend");
  if (legend) {
    const text = clean(legend.textContent);
    if (text) return text;
  }
  const group = element.closest("[role='group'],[role='radiogroup']");
  if (group) {
    const labelledBy = group.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = clean(document.getElementById(labelledBy)?.textContent);
      if (text) return text;
    }
    const ariaLabel = clean(group.getAttribute("aria-label"));
    if (ariaLabel) return ariaLabel;
  }
  return "";
}

/**
 * Helper text near the field. Useful both as weak label evidence and to detect
 * word limits ("不超过 100 字"), which changes how we compose an answer.
 */
export function nearbyHint(element: HTMLElement): string {
  const describedBy = element.getAttribute("aria-describedby");
  if (describedBy) {
    const parts = describedBy
      .split(/\s+/)
      .map((id) => clean(document.getElementById(id)?.textContent))
      .filter(Boolean);
    if (parts.length > 0) return parts.join(" ");
  }

  // A following sibling that is short and not a control.
  let sibling = element.nextElementSibling;
  let hops = 0;
  while (sibling && hops < 2) {
    if (!sibling.querySelector("input,select,textarea,button")) {
      const text = clean(sibling.textContent);
      if (text && text.length <= 80) return text;
    }
    sibling = sibling.nextElementSibling;
    hops += 1;
  }
  return "";
}

/** Escaped quotes / apostrophes, as I lamented everywhere else. */

/**
 * Best available label, in priority order. The returned `source` feeds the
 * classifier's confidence weighting.
 */
export function recoverLabel(element: HTMLElement): RecoveredLabel {
  const candidates: Array<RecoveredLabel | undefined> = [
    fromLabelElement(element),
    fromAria(element),
    fromTable(element),
    fromDefinitionList(element),
    fromPreceding(element),
  ];

  for (const candidate of candidates) {
    if (candidate && candidate.text) return candidate;
  }

  const placeholder = clean(element.getAttribute("placeholder"));
  if (placeholder) return { text: placeholder, source: "placeholder" };

  const title = clean(element.getAttribute("title"));
  if (title) return { text: title, source: "title-attribute" };

  const name = clean(element.getAttribute("name"));
  if (name) return { text: name, source: "name-attribute" };

  const heading = nearestHeading(element);
  if (heading) return { text: heading, source: "section-heading" };

  return { text: "", source: "none" };
}

/** Extract a word limit from hints, `maxlength`, or a data attribute. */
export function detectMaxLength(element: HTMLElement, hint: string): number | undefined {
  const attr = (element as HTMLInputElement).maxLength;
  if (typeof attr === "number" && attr > 0) return attr;

  const dataLimit = element.getAttribute("data-maxlength") ?? element.getAttribute("maxlength-text");
  if (dataLimit) {
    const parsed = Number.parseInt(dataLimit, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  const match = hint.match(/(?:不超过|最多|限)\s*(\d{1,4})\s*(?:个)?字|(?:max(?:imum)?)\s*(\d{1,4})\s*(?:characters?|chars?)/i);
  const value = match?.[1] ?? match?.[2];
  if (value) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0 && parsed < 20000) return parsed;
  }
  return undefined;
}
