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

/** Is the element rendered at all? (Ignoring its own size.) */
function isRendered(element: HTMLElement): boolean {
  if (element.hidden) return false;
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return false;
  if (element.closest("[hidden],[aria-hidden='true']")) return false;
  return true;
}

/**
 * Element UI hides the real checkbox input as a 0×0, opacity-0 element and makes
 * its wrapping `<label>` the visible control. The input is still the thing that
 * holds the state and receives clicks, so it must stay in the scan; testing only
 * its own box dropped every “至今 / 无实习经历” question.
 *
 * Only accept the zero-size case when a visible label with text owns the input.
 * A zero-size template node or a switch with no label stays rejected.
 */
function hasVisibleProxyLabel(element: HTMLElement): boolean {
  if (!(element instanceof HTMLInputElement)) return false;
  if (element.type !== "checkbox" && element.type !== "radio") return false;
  return Array.from(element.labels ?? []).some((label) => {
    if (!isRendered(label)) return false;
    const rect = label.getBoundingClientRect();
    return (rect.width > 0 || rect.height > 0) && clean(label.textContent).length > 0;
  });
}

/** Is this element actually rendered? Hidden template nodes must be skipped. */
export function isVisible(element: Element): boolean {
  if (!(element instanceof HTMLElement)) {
    // SVG and friends: fall back to a bounding box check.
    return element.getBoundingClientRect().height > 0;
  }
  if (!isRendered(element)) return false;
  /*
   * `opacity: 0` is *not* a reason to skip a form control.
   *
   * Element UI, Ant Design and many Chinese ATSs render the real radio /
   * checkbox input transparent on top of a styled label. Skipping those hid
   * required questions such as 性别, 至今 and 无实习经历 from the scanner
   * entirely.
   */
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return hasVisibleProxyLabel(element);
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

/** Classes used by every major UI kit for a field's visible question text. */
const LABEL_LIKE_SELECTOR = [
  /*
   * Deliberately *not* bare `label`, `legend` or `dt`: a fieldset's legend names
   * the whole section (“实习或工作经历”, “开放问答”), and treating it as the
   * nearest field's label swallowed the real label one level down. Section
   * headings stay in `nearestHeading`; `fromTable` and `fromDefinitionList`
   * handle table cells and `<dt>` before this helper runs.
   */
  ".el-form-item__label",
  ".ant-form-item-label",
  ".form-item-label",
  ".control-label",
  ".field-label",
  ".form-label",
  '[class*="subtitle"]',
  '[class*="Subtitle"]',
  '[class*="label"]',
  '[class*="Label"]',
].join(",");

/** Helper text must never be mistaken for the question. */
const HINT_CLASS = /(tip|hint|help|desc|note|warning|error|text_box|currentEducationtText|placeholder)/i;

/**
 * A node whose class also names a field label is a label, not helper text.
 *
 * Tencent decorates the real `.subtitle` of 感兴趣的事业群 with `boleTip` (a
 * tooltip trigger). The hint test matched the “Tip” inside that class and threw
 * the label away, so the field fell back to the section title “意向信息”.
 */
const LABEL_CLASS = /(subtitle|form-item-label|ant-form-item-label|control-label|field-label|form-label|(^|[_\-\s])label($|[_\-\s]))/i;

function classText(element: Element): string {
  return element.getAttribute("class") ?? "";
}

function isHintLike(element: Element): boolean {
  const classes = classText(element);
  if (LABEL_CLASS.test(classes)) return false;
  if (HINT_CLASS.test(classes)) return true;
  return element.getAttribute("role") === "tooltip";
}

/** An option list rendered as DOM text: never a field label. */
function isOptionList(element: Element): boolean {
  if (
    element.matches(
      'ul,[role="listbox"],[class*="dropdown-menu"],[class*="select-dropdown"],[class*="options"]',
    )
  ) {
    return true;
  }
  return Boolean(
    element.querySelector('ul[role="listbox"],[class*="dropdown-menu"],[class*="select-dropdown"]'),
  );
}

/** Is this candidate the kind of short text a question would be? */
function isQuestionText(text: string): boolean {
  if (!text || text.length > 40) return false;
  if (/^[-–—~～至到]$/.test(text)) return false;
  if (/^(请选择|请输入|选择日期|点击选择)/.test(text)) return false;
  return true;
}

/**
 * A placeholder that names the question rather than demonstrating an answer.
 *
 * Tencent's identity box holds two controls under one `.subtitle` “个人证件”:
 * a dropdown trigger that chooses 居民身份证 and a free-text input for the
 * number. Treating the shared subtitle as both labels made the number input an
 * ID-type field, so a profile with “居民身份证” would type that word into the
 * number box. The input's own placeholder is the only text that distinguishes
 * them.
 */
function labelFromPlaceholder(element: HTMLElement): string {
  const raw = clean(element.getAttribute("placeholder"));
  if (!raw) return "";
  const stripped = raw.replace(/^请(?:输入|填写|选择)(?:您的|你的)?\s*/, "").trim();
  const candidate = stripped || raw;
  if (candidate.length < 2 || candidate.length > 40) return "";
  if (/^(请)?(输入|填写|选择)(日期|内容|信息|选项)?$/.test(candidate)) return "";
  // “如：20-30万/年” is an example, not a question.
  if (/^(如|例如|例[:：]|格式|点击|drag|select|enter)/i.test(candidate)) return "";
  return candidate;
}

/**
 * Does a sibling dropdown trigger already own this container's subtitle?
 *
 * When it does, the subtitle describes the trigger, not the free-text input
 * beside it. The shape is common in Chinese ATSs (证件类型 + 证件号码,
 * 国家/地区 + 区号 + 号码).
 */
function hasCompetingTrigger(element: HTMLElement): boolean {
  const box = element.closest<HTMLElement>(
    ".info_box, .el-form-item, .ant-form-item, .form-item, .form-group, .field, .row",
  );
  if (!box) return false;
  return Array.from(
    box.querySelectorAll<HTMLElement>("[role='button'][aria-haspopup], .el-dropdown-link"),
  ).some((trigger) => trigger !== element && !trigger.contains(element));
}

/**
 * A label inside the control's own widget container.
 *
 * Chinese ATSs commonly render a field as:
 *
 *   `<div class="info_box">
 *      <div class="subtitle">手机号码</div>
 *      <div class="input_box"><input …></div>
 *      <div class="phone-tip">如您是中国大陆籍…</div>
 *    </div>`
 *
 * `fromPreceding` reached the hint before the subtitle, so the phone question
 * became “如您是中国大陆籍…” and the email question “建议填写常用的QQ邮箱”.
 * This source looks for an explicit subtitle / form-item label inside the same
 * widget container and ignores hint text and open option lists.
 */
function fromFieldLabel(element: HTMLElement): RecoveredLabel | undefined {
  let ancestor: HTMLElement | null = element.parentElement;
  for (let depth = 0; depth < 6 && ancestor && ancestor !== document.body; depth += 1) {
    // A container holding a whole form belongs to other fields too.
    const controls = ancestor.querySelectorAll("input,select,textarea,[contenteditable='true']");
    if (controls.length > 6) break;

    const candidates: Array<{ node: HTMLElement; text: string }> = [];
    for (const node of Array.from(ancestor.querySelectorAll<HTMLElement>(LABEL_LIKE_SELECTOR))) {
      if (node === element || node.contains(element) || element.contains(node)) continue;
      if (node.querySelector("input,select,textarea,button,option")) continue;
      if (isHintLike(node) || isOptionList(node) || !isVisible(node)) continue;
      /*
       * A checkbox's own “至今 / 无实习经历” text labels that checkbox, not the
       * date inputs beside it. Letting it into their candidate pool made every
       * date input in the row read “至今” (and then classify as a boolean).
       */
      if (isChoiceLabelForOther(node, element)) continue;
      const text = clean(node.textContent);
      if (isQuestionText(text) && !isFieldTag(text)) candidates.push({ node, text });
    }

    if (candidates.length > 0) {
      /*
       * Prefer the label immediately before the control, in document order.
       *
       * Length is not a usable proxy here: Tencent's identity box stacks a group
       * heading “证件信息” above the field's own “国家/地区”, and the heading is
       * the shorter string. The nearest preceding label is the field's question;
       * a group heading sits further away. Labels that follow the control (an
       * inline checkbox caption) are only used when nothing precedes it.
       */
      const preceding = candidates.filter(
        (candidate) =>
          candidate.node.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
      const chosen = preceding.length > 0 ? preceding[preceding.length - 1] : candidates[0];
      if (chosen) return { text: chosen.text, source: "wrapper" };
    }

    ancestor = ancestor.parentElement;
  }
  return undefined;
}

/** “选填 / 必填 / *” decorate a question; they are not the question. */
function isFieldTag(text: string): boolean {
  const bare = text.replace(/[（(].*?[)）]/g, "").trim();
  return /^(选填|必填|可选|可填|optional|required|\*|＊)$/i.test(bare);
}

/**
 * Is this label-like node the caption of a different checkbox/radio?
 *
 * The check is deliberately scoped to choice widgets. A `<label>` wrapping a
 * text input is a legitimate label source, but `.el-checkbox__label` is the
 * caption of its own input and must not name the neighbouring date field.
 */
function isChoiceLabelForOther(node: HTMLElement, element: HTMLElement): boolean {
  const choice = node.closest<HTMLElement>(
    ".el-checkbox, .el-radio, .ant-checkbox-wrapper, .ant-radio-wrapper, label",
  );
  if (!choice) return false;
  const control = choice.querySelector<HTMLInputElement>(
    "input[type='checkbox'], input[type='radio']",
  );
  return Boolean(control && control !== element);
}

/**
 * The nearest preceding "label-like" text node, walking up and across the DOM.
 * This is the workhorse for `<div class="form-item"><span>姓名</span><input></div>`.
 */
function fromPreceding(element: HTMLElement): RecoveredLabel | undefined {
  let current: HTMLElement | null = element;
  /*
   * Component libraries nest a control six or seven levels deep. Baidu's
   * antd-style select is input → search span → selector → select → brick-select
   * → control → control-wrap → field, and the visible label sits one level above
   * the last; a limit of 6 stopped just short and the 专业 dropdown fell back to
   * the section heading as its label.
   */
  for (let depth = 0; depth < 10 && current; depth += 1) {
    // Look at previous siblings within this parent, nearest first.
    let sibling = current.previousElementSibling;
    let hops = 0;
    while (sibling && hops < 4) {
      const text = clean(sibling.textContent);
      /*
       * Hints sit directly next to the control and are often *before* it in
       * DOM order. A dropdown's option list is a sibling too. Neither is the
       * question; keep walking so the real subtitle one hop further back wins.
       */
      const skip = isHintLike(sibling) || isOptionList(sibling);
      const isLabelish =
        !skip &&
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
      /*
       * A block that contains another control is a field row, not a heading.
       * Tencent's education row exposes its 学历 select as text — options and all
       * — and that option list ("…高中大专") was being used as the group heading
       * of the neighbouring school input, which then tripped its exclusions.
       */
      if (sibling.querySelector("input,select,textarea,button")) {
        sibling = sibling.previousElementSibling;
        continue;
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
  const placeholder = labelFromPlaceholder(element);

  /*
   * A container that holds a dropdown trigger *and* a text input gives the
   * subtitle to the trigger. The input's placeholder is then the only text that
   * says what the input itself wants (Tencent's 个人证件/证件号码 pair). Keep
   * explicit labels and table headers ahead of it: those are per-control.
   */
  const placeholderOwnsQuestion = Boolean(placeholder) && hasCompetingTrigger(element);

  const candidates: Array<RecoveredLabel | undefined> = [
    fromLabelElement(element),
    fromAria(element),
    fromTable(element),
    fromDefinitionList(element),
    placeholderOwnsQuestion ? { text: placeholder, source: "placeholder" as const } : undefined,
    fromFieldLabel(element),
    fromPreceding(element),
  ];

  for (const candidate of candidates) {
    if (candidate && candidate.text) return candidate;
  }

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
