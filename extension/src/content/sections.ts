/**
 * Empty repeatable sections.
 *
 * Many Chinese ATS pages render an experience/education section with **no
 * rows** and a single “添加” control. The scanner can only see fields that
 * exist, so those sections are invisible to it: the panel says “4 fields” on a
 * page whose résumé has three more sections waiting to be opened.
 *
 * This module finds those empty sections and clicks their add control. It is
 * deliberately confined to sections the profile can actually fill — education,
 * work experience and projects. Awards and certificates are stored as flat
 * strings, not per-entry records, so opening rows for them would only create
 * empty boxes the person has to deal with.
 *
 * Nothing here runs during a scan. The content script calls it only after the
 * person presses “填写”, preserving the product's promise that reading a page
 * never changes it.
 */

import type { RepeatSectionKey } from "../shared/protocol.js";

export interface DetectedSection {
  key: RepeatSectionKey;
  /** The page's own wording, e.g. “实习经历” rather than our canonical label. */
  label: string;
  /** The smallest ancestor that contains the heading and its controls. */
  container: HTMLElement;
  /** The element that adds one row. */
  addControl: HTMLElement;
  /** Count of visible form controls currently in the section. */
  fieldCount: number;
}

interface SectionRule {
  key: RepeatSectionKey;
  label: string;
  pattern: RegExp;
}

/**
 * Order matters only for labels; matching requires exactly one rule per
 * ancestor, so a container that mentions two sections is rejected rather than
 * guessed at.
 */
const SECTION_RULES: SectionRule[] = [
  /*
   * “学历” is here because Tencent's add control is “添加学历”, not “添加教育
   * 经历”. The control's own wrapper is skipped below, so this only helps map
   * the control to the education section; it does not make the button itself a
   * section.
   */
  { key: "education", label: "教育经历", pattern: /教育经历|教育背景|学习经历|学历信息|学历/ },
  { key: "projects", label: "项目经历", pattern: /项目经历|项目经验|科研经历|研究经历/ },
  { key: "experience", label: "工作经历", pattern: /工作经历|工作经验|实习经历|实习经验|职业经历|任职经历/ },
];

/** Never open more than this many rows from one section, whatever the profile says. */
export const MAX_ROWS_PER_SECTION = 6;

/** How long to wait for a framework to render a newly added row. */
const ROW_TIMEOUT_MS = 2_500;

/* --------------------------------------------------------------- candidates */

function normalize(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function isVisible(element: HTMLElement): boolean {
  if (element.getClientRects().length === 0) return false;
  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

/**
 * The text that makes an element an “add” control, or undefined.
 *
 * Two shapes are common: a button that says exactly “添加” / “新增”, and a
 * button whose full text names the thing (“添加教育经历”). A bare plus icon
 * with an aria-label counts too, as long as it carries no other text.
 */
function addLabel(element: HTMLElement): string | undefined {
  const text = normalize(element.textContent);
  const aria = normalize(element.getAttribute("aria-label") ?? element.getAttribute("title") ?? "");

  if (/^(?:\+|\＋)?\s*(添加|新增)(一项)?$/.test(text)) return text;
  if (text.length > 0 && text.length <= 16 && /^(?:\+|\＋)?\s*(添加|新增)/.test(text)) return text;
  if ((aria.includes("添加") || aria.includes("新增")) && text.length <= 8) return aria;
  return undefined;
}

/**
 * Every element on the page that plausibly adds a row.
 *
 * The selector pass catches buttons and icon controls; the text walker catches
 * the plain `<div>添加</div>` pattern that Ant Design wrappers often use. Both
 * are needed: Kuaishou's control is a div with no button semantics at all.
 */
function collectCandidates(): HTMLElement[] {
  const found = new Set<HTMLElement>();

  const selector = [
    "button",
    "a",
    '[role="button"]',
    '[class*="add"]',
    '[class*="Add"]',
    '[class*="plus"]',
    '[class*="Plus"]',
    '[class*="btn"]',
  ].join(",");

  for (const element of document.querySelectorAll<HTMLElement>(selector)) {
    if (addLabel(element)) found.add(element);
  }

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = normalize(node.nodeValue);
    if (!/^(?:\+|\＋)?\s*(添加|新增)(一项)?$/.test(text)) continue;
    const parent = node.parentElement;
    if (!parent) continue;
    found.add(parent);
    const clickable = parent.closest<HTMLElement>(
      'button, a, [role="button"], [class*="add"], [class*="plus"], [class*="btn"]',
    );
    if (clickable) found.add(clickable);
  }

  return [...found];
}

/* ---------------------------------------------------------------- sections */

function countFields(container: HTMLElement): number {
  const controls = container.querySelectorAll<HTMLElement>(
    'input:not([type="hidden"]), textarea, select, [contenteditable="true"]',
  );
  let count = 0;
  for (const control of controls) {
    if (isVisible(control)) count += 1;
  }
  return count;
}

/**
 * Does this section already contain something the person typed or chose?
 *
 * Used before opening more rows: if a row is already populated, adding rows
 * from the profile would duplicate work and could overwrite an answer the
 * person meant to keep. A placeholder ("请选择", "选择日期") does not count.
 * A checked "无实习经历" does count — it is an explicit statement that the
 * section should stay empty.
 */
export function hasUserContent(container: HTMLElement): boolean {
  const placeholder = /^(请选择.*|请输入.*|选择日期|--|—|-|)$/;
  for (const control of Array.from(container.querySelectorAll<HTMLElement>("input, textarea, select"))) {
    if (control instanceof HTMLInputElement) {
      if (control.type === "hidden" || control.type === "file") continue;
      if (control.type === "checkbox" || control.type === "radio") {
        if (control.checked) return true;
        continue;
      }
      if (control.value.trim() && !placeholder.test(control.value.trim())) return true;
    } else if (control instanceof HTMLTextAreaElement) {
      if (control.value.trim()) return true;
    } else if (control instanceof HTMLSelectElement) {
      if (control.value && control.value !== "0" && control.value !== "-1") return true;
    } else if (control.isContentEditable) {
      if ((control.textContent ?? "").trim()) return true;
    }
  }
  return false;
}

/**
 * The page's own name for this section.
 *
 * Prefer a short title-like element inside the container; fall back to the
 * canonical name. The label is only ever shown to the person, never used for
 * matching, so a tidy fallback is harmless.
 */
const ACTION_TEXT = /(删除|移除|添加|新增|编辑|修改|上传|下载|remove|delete|add|edit)/i;

/**
 * The text of a section title, without the controls that live inside it.
 *
 * Tencent puts the row's delete button inside its title element:
 * “项目经历-1 [删除经历]”. Reading `textContent` whole turned the section's name
 * into “项目经历-1 删除经历” in the panel's notices and fill report. Cloning and
 * dropping interactive descendants leaves the heading itself; a trailing row
 * number is removed because the notice names the section, not one row.
 */
function sectionTitleText(element: HTMLElement): string {
  const clone = element.cloneNode(true) as HTMLElement;
  clone
    .querySelectorAll("button, a, input, select, textarea, svg, [role='button']")
    .forEach((node) => node.remove());
  const text = normalize(clone.textContent);
  if (!text || ACTION_TEXT.test(text)) return "";
  return text.replace(/[-–—（(]\s*\d+\s*[)）]?$/, "").trim();
}

function sectionLabel(container: HTMLElement, rule: SectionRule): string {
  const titles = container.querySelectorAll<HTMLElement>(
    'h1, h2, h3, h4, h5, h6, legend, [class*="title"], [class*="Title"], [class*="header"], [class*="Header"]',
  );
  for (const title of titles) {
    const text = sectionTitleText(title);
    if (text.length > 0 && text.length <= 16 && rule.pattern.test(text)) return text;
  }
  return rule.label;
}

/**
 * Map an add control to its section by climbing ancestors.
 *
 * We accept an ancestor only when exactly one section rule matches its text.
 * A form-level ancestor mentions every section and is therefore rejected — and
 * it would have fields anyway, so it could never be a valid “empty” section.
 */
function sectionFor(control: HTMLElement): DetectedSection | undefined {
  /*
   * Start at the parent, never the control itself.
   *
   * A button that says “添加教育经历” contains the section name, so accepting
   * it as its own container would report a section that always has zero fields
   * — even after its rows exist — and the row-growth wait would never succeed.
   * The section is the thing the control lives in, not the control.
   */
  const controlText = normalize(control.textContent);
  let node: HTMLElement | null = control.parentElement;
  for (let depth = 0; depth < 8 && node && node !== document.body; depth += 1) {
    const text = normalize(node.textContent);
    if (text.length > 0 && text.length <= 220) {
      /*
       * Skip the button's own wrapper.
       *
       * A control that says “添加实习经历” sits inside an `.info_box` whose
       * entire text is that label; that wrapper matches the experience rule and
       * has zero fields, so it was mistaken for an empty section even when the
       * page already had a full row just above it. The section is the ancestor
       * that also contains the row or a heading, not the button's box.
       */
      const onlyTheButton =
        text === controlText ||
        (text.length <= controlText.length + 4 &&
          node.querySelectorAll('input,textarea,select,[contenteditable="true"]').length === 0);
      if (onlyTheButton) {
        node = node.parentElement;
        continue;
      }

      const matches = SECTION_RULES.filter((rule) => rule.pattern.test(text));
      const rule = matches[0];
      if (matches.length === 1 && rule) {
        return {
          key: rule.key,
          label: sectionLabel(node, rule),
          container: node,
          addControl: control,
          fieldCount: countFields(node),
        };
      }
    }
    node = node.parentElement;
  }
  return undefined;
}

function isDisabled(element: HTMLElement): boolean {
  return (
    element.getAttribute("aria-disabled") === "true" ||
    (element instanceof HTMLButtonElement && element.disabled)
  );
}

/**
 * All repeatable sections that have an add control, one per kind.
 *
 * If several controls map to the same section, the narrowest container wins:
 * a section-level plus is preferable to a stray “添加” inside a row.
 */
export function findSections(): DetectedSection[] {
  const byKey = new Map<RepeatSectionKey, DetectedSection>();

  for (const control of collectCandidates()) {
    if (!isVisible(control) || isDisabled(control)) continue;

    const section = sectionFor(control);
    if (!section) continue;

    const existing = byKey.get(section.key);
    if (!existing) {
      byKey.set(section.key, section);
      continue;
    }
    if (existing.container.contains(section.container)) {
      // The new container is narrower — prefer it.
      byKey.set(section.key, section);
    }
  }

  return [...byKey.values()];
}

/** Sections that currently render no fields at all. */
export function findEmptySections(): DetectedSection[] {
  return findSections().filter((section) => section.fieldCount === 0);
}

/* ------------------------------------------------------------------ action */

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(80);
  }
  return predicate();
}

/**
 * Open up to `desired` rows in one section.
 *
 * The section is re-located after every click because frameworks commonly
 * replace the empty-state control with a different one once the first row
 * exists. A click that produces no new field ends the loop — better to fill
 * what did appear than to keep poking an unresponsive control.
 *
 * Returns the number of rows that actually appeared.
 */
export async function addSectionRows(key: RepeatSectionKey, desired: number): Promise<number> {
  const target = Math.min(Math.max(desired, 0), MAX_ROWS_PER_SECTION);
  let added = 0;

  for (let index = 0; index < target; index += 1) {
    const section = findSections().find((item) => item.key === key);
    if (!section) break;

    const before = section.fieldCount;
    section.addControl.click();

    const grew = await waitFor(() => {
      const current = findSections().find((item) => item.key === key);
      return Boolean(current && current.fieldCount > before);
    }, ROW_TIMEOUT_MS);

    if (!grew) break;
    added += 1;
  }

  return added;
}
