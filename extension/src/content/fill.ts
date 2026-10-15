/**
 * Writing values into a live page.
 *
 * Every technique here exists because the naive version fails on some real
 * site. React discards a `.value` assignment unless the native setter is used;
 * Vue's `v-model` needs an `input` event with the right properties; a native
 * `<select>` sometimes needs the index rather than the value; custom dropdowns
 * only react to a real pointer sequence.
 *
 * The golden rule: dispatch events the way a *user* would, in the order a user
 * would, and verify the value actually stuck before reporting success.
 */

import type { Decision, FieldValue } from "@quill/core";

export interface FillOutcome {
  ref: string;
  ok: boolean;
  /** What the page now contains, read back after the write. */
  actual?: string;
  reason?: string;
}

/* ------------------------------------------------------- native setter */

/**
 * React (and some other frameworks) install a property descriptor on
 * `HTMLInputElement.prototype.value` that shadows the native one. Assigning
 * through it marks the field as "controlled" and gets reverted on the next
 * render, so we reach for the prototype's own setter instead.
 */
function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  if (descriptor?.set) descriptor.set.call(element, value);
  else element.value = value;
}

/** Events a real user interaction produces, in order. */
function dispatchInputEvents(element: HTMLElement, options: { commit?: boolean } = {}): void {
  const base = { bubbles: true, cancelable: true, composed: true };
  element.dispatchEvent(new Event("focus", base));
  element.dispatchEvent(new InputEvent("input", { ...base, inputType: "insertText", data: null }));
  element.dispatchEvent(new Event("change", base));
  if (options.commit) {
    element.dispatchEvent(new KeyboardEvent("keydown", { ...base, key: "Enter", code: "Enter", keyCode: 13 }));
    element.dispatchEvent(new KeyboardEvent("keyup", { ...base, key: "Enter", code: "Enter", keyCode: 13 }));
  }
  element.dispatchEvent(new Event("blur", { bubbles: false, cancelable: true }));
}

/* ------------------------------------------------------------- controls */

function find(ref: string): HTMLElement | undefined {
  // The ref encodes how it was built so we can reverse it exactly.
  if (ref.startsWith("id:")) {
    const id = ref.slice(3);
    const byId = document.getElementById(id);
    if (byId) return byId as HTMLElement;
  }
  if (ref.startsWith("name:")) {
    // `name:<name>#<hash>` — the hash disambiguates repeats, which we cannot
    // reverse, so the first match is the best available guess.
    const name = ref.slice(5).split("#")[0] ?? "";
    const found = document.querySelector<HTMLElement>(`[name="${CSS.escape(name)}"]`);
    if (found) return found;
  }
  return undefined;
}

/**
 * Locate a field by index in a fresh scan, which is how we survive re-renders:
 * the ref is matched first, then we reconcile by position and label.
 */
export function locateField(
  ref: string,
  index: number,
  elements: HTMLElement[],
  label: string,
): HTMLElement | undefined {
  const byRef = find(ref);
  if (byRef && document.contains(byRef)) return byRef;

  const atIndex = index >= 0 ? elements[index] : undefined;
  if (atIndex && document.contains(atIndex)) {
    // Only trust the index if the label still matches — otherwise the page has
    // reordered and we would fill the wrong field.
    const text = (atIndex.getAttribute("aria-label") ?? atIndex.closest("label")?.textContent ?? "").trim();
    if (!label || !text || text.includes(label) || label.includes(text)) return atIndex;
  }

  // Last resort: a label-text search.
  if (label) {
    const escaped = label.replace(/"/g, '\\"');
    const byLabel = document.querySelector<HTMLElement>(
      `[aria-label="${escaped}"],[placeholder="${escaped}"]`,
    );
    if (byLabel) return byLabel;
  }
  return undefined;
}

/* --------------------------------------------------------------- writers */

function writeText(element: HTMLElement, value: string): FillOutcome {
  const tag = element.tagName.toLowerCase();

  if (tag === "textarea") {
    setNativeValue(element as HTMLTextAreaElement, value);
    dispatchInputEvents(element);
    const actual = (element as HTMLTextAreaElement).value;
    return actual === value
      ? { ref: "", ok: true, actual }
      : { ref: "", ok: false, actual, reason: "页面未接受该值" };
  }

  if (tag === "input") {
    const input = element as HTMLInputElement;
    /*
     * A single-line input cannot hold the newline-separated form that
     * `FieldValue.text` uses for multi-selects and multi-city answers. Writing
     * "深圳\n广州" into an `<input>` produces a value the form's own validation
     * rejects, so the lines are joined with the separator a Chinese form would
     * expect from a person.
     */
    const single = input.type !== "hidden" && !value.includes("\n") ? value : value.split("\n").map((line) => line.trim()).filter(Boolean).join("、");
    input.focus();
    setNativeValue(input, single);
    dispatchInputEvents(element);
    // Some frameworks append instead of replacing if a previous value existed.
    if (input.value !== single) {
      setNativeValue(input, single);
      dispatchInputEvents(element);
    }
    const actual = input.value;
    return actual === single
      ? { ref: "", ok: true, actual }
      : { ref: "", ok: false, actual, reason: `期望 "${single}"，实际 "${actual}"` };
  }

  if (element.isContentEditable || element.getAttribute("role") === "textbox") {
    element.focus();
    // Rich-text editors track the selection; execCommand keeps them consistent
    // with what a paste would do.
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
    let inserted = false;
    try {
      inserted = document.execCommand("insertText", false, value);
    } catch {
      inserted = false;
    }
    if (!inserted) {
      element.textContent = value;
      dispatchInputEvents(element);
    }
    const actual = element.textContent ?? "";
    return actual.includes(value)
      ? { ref: "", ok: true, actual }
      : { ref: "", ok: false, actual, reason: "富文本编辑器未接受该值" };
  }

  return { ref: "", ok: false, reason: `不支持的字段类型 ${tag}` };
}

function writeSelect(element: HTMLSelectElement, value: FieldValue): FillOutcome {
  const target = value.raw ?? value.text;
  const wanted = [...value.multiple ?? [value.text]];

  const matchesOption = (option: HTMLOptionElement, needle: string): boolean => {
    const optionText = (option.textContent ?? "").trim();
    return (
      option.value === needle ||
      optionText === needle ||
      optionText === value.text ||
      option.value === value.text
    );
  };

  if (element.multiple) {
    let changed = false;
    for (const option of Array.from(element.options)) {
      const shouldSelect = wanted.some((needle) => matchesOption(option, needle));
      if (option.selected !== shouldSelect) {
        option.selected = shouldSelect;
        changed = true;
      }
    }
    if (changed) dispatchInputEvents(element);
    const actual = Array.from(element.selectedOptions).map((option) => option.textContent?.trim() ?? "").join("、");
    return { ref: "", ok: actual.length > 0, actual };
  }

  // Single select: match by value, by label, then by the requested text.
  let chosen: HTMLOptionElement | undefined;
  for (const option of Array.from(element.options)) {
    if (option.disabled) continue;
    if (matchesOption(option, target) || matchesOption(option, value.text)) {
      chosen = option;
      break;
    }
  }
  if (!chosen) {
    return { ref: "", ok: false, reason: `选项中没有「${value.text}」` };
  }

  // Setting `selectedIndex` as well as `value` keeps frameworks that watch
  // either one in sync.
  chosen.selected = true;
  element.value = chosen.value;
  element.selectedIndex = chosen.index;
  dispatchInputEvents(element);

  const actual = element.selectedOptions[0]?.textContent?.trim() ?? "";
  return actual
    ? { ref: "", ok: true, actual }
    : { ref: "", ok: false, reason: "选择未被页面接受" };
}

function writeRadioGroup(element: HTMLElement, value: FieldValue): FillOutcome {
  const name = element.getAttribute("name");
  if (!name) return { ref: "", ok: false, reason: "单选项缺少 name" };
  const group = Array.from(
    document.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(name)}"]`),
  );
  const wanted = [value.raw, value.text].filter((item): item is string => Boolean(item));

  for (const input of group) {
    const labelText =
      (input.id ? document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(input.id)}"]`)?.textContent : "") ??
      input.closest("label")?.textContent ??
      "";
    const candidates = [input.value, labelText.replace(/\s+/g, " ").trim()].filter(Boolean);
    if (!candidates.some((candidate) => wanted.includes(candidate))) continue;

    // `click()` is what a user does and what frameworks listen for, but it
    // fails on elements hidden behind a styled label.
    input.click();
    if (!input.checked) {
      input.checked = true;
      dispatchInputEvents(input);
    }
    if (input.checked) {
      return { ref: "", ok: true, actual: labelText.trim() || input.value };
    }
  }
  // Name what we actually looked for and what was on offer, so a mismatch is
  // diagnosable from the panel without opening devtools.
  const available = group
    .map((input) => {
      const text =
        (input.id ? document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(input.id)}"]`)?.textContent : "") ??
        input.closest("label")?.textContent ??
        input.value;
      return `${input.value}="${text.trim()}"`;
    })
    .join(", ");
  return {
    ref: "",
    ok: false,
    reason: `没有匹配的选项：想填「${wanted.join("」或「")}」，页面上是 ${available}`,
  };
}

function writeCheckbox(element: HTMLInputElement, value: FieldValue): FillOutcome {
  const truthy = /^(是|yes|true|1|y|有|接受|同意|愿意)$/i.test(value.text.trim());
  const falsy = /^(否|no|false|0|n|无|没有|不接受|不同意)$/i.test(value.text.trim());
  if (!truthy && !falsy) {
    // Not a yes/no checkbox — treat the value as the option's own label.
    const ownLabel = element.closest("label")?.textContent?.trim() ?? "";
    if (!ownLabel.includes(value.text)) return { ref: "", ok: false, reason: "无法判定勾选状态" };
  }
  const desired = truthy && !falsy;
  if (element.checked !== desired) {
    element.click();
    if (element.checked !== desired) {
      element.checked = desired;
      dispatchInputEvents(element);
    }
  }
  return { ref: "", ok: true, actual: element.checked ? "已勾选" : "未勾选" };
}

function writeCheckboxGroup(element: HTMLElement, value: FieldValue): FillOutcome {
  const name = element.getAttribute("name");
  if (!name) return { ref: "", ok: false, reason: "多选项缺少 name" };
  const group = Array.from(
    document.querySelectorAll<HTMLInputElement>(`input[type="checkbox"][name="${CSS.escape(name)}"]`),
  );
  const wanted = value.multiple ?? value.text.split(/[、,，;；\n]/).map((part) => part.trim()).filter(Boolean);
  let hits = 0;

  for (const input of group) {
    const labelText =
      (input.id ? document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(input.id)}"]`)?.textContent : "") ??
      input.closest("label")?.textContent ??
      "";
    const clean = labelText.replace(/\s+/g, " ").trim();
    const shouldCheck = wanted.some((needle) => needle === input.value || needle === clean || clean.includes(needle));
    if (shouldCheck && !input.checked) {
      input.click();
      if (!input.checked) {
        input.checked = true;
        dispatchInputEvents(input);
      }
    }
    if (input.checked) hits += 1;
  }
  return hits > 0
    ? { ref: "", ok: true, actual: `已勾选 ${hits} 项` }
    : { ref: "", ok: false, reason: "没有匹配的选项" };
}

function writeDate(element: HTMLElement, value: FieldValue, kind: string): FillOutcome {
  const input = element as HTMLInputElement;
  const iso = value.iso;

  // `<input type="date">` wants YYYY-MM-DD; `<input type="month">` wants YYYY-MM.
  if (input.type === "date") {
    const dateValue = iso ?? toIsoFromText(value.text);
    if (!dateValue) return { ref: "", ok: false, reason: "无法解析为日期" };
    setNativeValue(input, dateValue);
    dispatchInputEvents(element);
    return input.value
      ? { ref: "", ok: true, actual: input.value }
      : { ref: "", ok: false, reason: "日期未被接受" };
  }
  if (input.type === "month") {
    const monthValue = (iso ?? toIsoFromText(value.text))?.slice(0, 7);
    if (!monthValue) return { ref: "", ok: false, reason: "无法解析为月份" };
    setNativeValue(input, monthValue);
    dispatchInputEvents(element);
    return input.value ? { ref: "", ok: true, actual: input.value } : { ref: "", ok: false, reason: "月份未被接受" };
  }

  /*
   * Text inputs styled as date pickers (very common in Chinese ATSs) accept a
   * plain string. We use the format the placeholder suggests when it is
   * unambiguous, because those widgets validate on blur.
   */
  const placeholder = input.getAttribute("placeholder") ?? "";
  const formatted = formatLikePlaceholder(value.text, placeholder, kind);
  input.focus();
  setNativeValue(input, formatted);
  dispatchInputEvents(element, { commit: true });
  if (input.value === formatted) return { ref: "", ok: true, actual: formatted };

  // Some pickers reject partial dates; try the full ISO form.
  setNativeValue(input, iso ?? value.text);
  dispatchInputEvents(element, { commit: true });
  return input.value
    ? { ref: "", ok: true, actual: input.value }
    : { ref: "", ok: false, reason: "日期控件未接受该值" };
}

function toIsoFromText(value: string): string | undefined {
  const match = value.match(/^(\d{4})\s*[年/\-.]\s*(\d{1,2})(?:\s*[月/\-.]\s*(\d{1,2}))?/);
  if (!match) return undefined;
  const [, year, month, day] = match;
  return `${year}-${String(Number.parseInt(month ?? "1", 10)).padStart(2, "0")}-${String(
    Number.parseInt(day ?? "1", 10),
  ).padStart(2, "0")}`;
}

/** Choose a date format the widget's own placeholder implies. */
function formatLikePlaceholder(value: string, placeholder: string, kind: string): string {
  const iso = toIsoFromText(value);
  if (!iso) return value;
  const [year, month, day] = iso.split("-");
  if (kind === "date") {
    if (/年.*月.*日/.test(placeholder)) return `${year}年${Number(month)}月${Number(day)}日`;
    if (/yyyy[\/\-.]mm[\/\-.]dd/i.test(placeholder)) {
      const separator = placeholder.match(/[\/\-.]/)?.[0] ?? "/";
      return [year, month, day].join(separator);
    }
    if (/dd[\/\-.]mm/i.test(placeholder)) return [day, month, year].join(placeholder.match(/[\/\-.]/)?.[0] ?? "/");
    if (/年.*月/.test(placeholder)) return `${year}年${Number(month)}月`;
    return `${year}-${month}-${day}`;
  }
  // Month-level widgets accept a partial date; the widget adds its own suffix.
  if (/年.*月/.test(placeholder)) return `${year}年${Number(month)}月`;
  return `${year}-${month}`;
}

/**
 * Custom dropdowns (react-select, antd, element-ui) render options into a
 * portal only after the control is opened. Filling one therefore means:
 * open it, wait for the list, then click the option node.
 */
async function writeCustomSelect(element: HTMLElement, value: FieldValue, framework: string): Promise<FillOutcome> {
  const target = (value.raw ?? value.text).trim();
  element.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
  element.focus();
  element.click();
  await wait(120);

  const optionSelectors: Record<string, string> = {
    antd: ".ant-select-item-option",
    "element-ui": ".el-select-dropdown__item",
    "react-select": "[class*='option']",
    select2: ".select2-results__option",
    vantage: ".van-picker-column__item",
    vant: ".van-picker-column__item",
    arco: ".arco-select-option",
    semi: ".semi-select-option",
  };
  const selector = optionSelectors[framework] ?? "[role='option']";
  const options = Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(isRendered);

  const match = options.find((option) => {
    const text = (option.textContent ?? "").trim();
    return text === target || text === value.text || text.includes(value.text);
  });

  if (!match) {
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return { ref: "", ok: false, reason: `下拉列表中未找到「${value.text}」` };
  }

  // Native pointer events are what these libraries actually listen for; a bare
  // `click()` is ignored by react-select.
  const rect = match.getBoundingClientRect();
  const init: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  };
  match.dispatchEvent(new MouseEvent("mousedown", init));
  match.dispatchEvent(new MouseEvent("mouseup", init));
  match.dispatchEvent(new MouseEvent("click", init));
  await wait(60);

  const actual = (element.textContent ?? element.getAttribute("value") ?? "").trim();
  // A custom select echoes the chosen label in its own text.
  if (actual.includes(value.text) || actual.includes(target)) {
    return { ref: "", ok: true, actual: value.text };
  }
  const inputValue = (element as HTMLInputElement).value;
  if (inputValue && (inputValue.includes(value.text) || inputValue === target)) {
    return { ref: "", ok: true, actual: inputValue };
  }
  return { ref: "", ok: false, actual, reason: "自定义下拉未接受该值" };
}

function isRendered(element: HTMLElement): boolean {
  if (element.closest("[aria-hidden='true']")) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ api */

/**
 * Apply one decision. Async because custom dropdowns need to wait for their
 * option list to render.
 */
export async function applyDecision(
  decision: Decision,
  element: HTMLElement | undefined,
): Promise<FillOutcome> {
  if (!decision.value) return { ref: decision.ref, ok: false, reason: "没有可填写的值" };
  if (!element) return { ref: decision.ref, ok: false, reason: "页面上已找不到该字段" };

  if (element.getAttribute("aria-disabled") === "true" || (element as HTMLInputElement).disabled) {
    return { ref: decision.ref, ok: false, reason: "字段当前不可编辑" };
  }
  if ((element as HTMLInputElement).readOnly) {
    return { ref: decision.ref, ok: false, reason: "字段为只读" };
  }

  const framework = element.closest("[class*='ant-select'],[class*='el-select'],[class*='select__control'],[class*='semi-select'],[class*='arco-select']");
  const isNativeSelect = element.tagName.toLowerCase() === "select";

  let outcome: FillOutcome;
  try {
    if (decision.kind === "radio-group") outcome = writeRadioGroup(element, decision.value);
    else if (decision.kind === "checkbox-group") outcome = writeCheckboxGroup(element, decision.value);
    else if (decision.kind === "checkbox") outcome = writeCheckbox(element as HTMLInputElement, decision.value);
    else if (decision.kind === "select" && isNativeSelect) outcome = writeSelect(element as HTMLSelectElement, decision.value);
    else if (decision.kind === "combobox" || (framework && !isNativeSelect)) {
      outcome = await writeCustomSelect(element, decision.value, detectFrameworkName(element));
    } else if (decision.kind === "date") outcome = writeDate(element, decision.value, "date");
    else outcome = writeText(element, decision.value.text);
  } catch (error) {
    outcome = {
      ref: decision.ref,
      ok: false,
      reason: error instanceof Error ? error.message : "填写时发生未知错误",
    };
  }

  return { ...outcome, ref: decision.ref };
}

function detectFrameworkName(element: HTMLElement): string {
  if (element.closest("[class*='ant-select']")) return "antd";
  if (element.closest("[class*='el-select']")) return "element-ui";
  if (element.closest("[class*='select__control']")) return "react-select";
  if (element.closest("[class*='select2']")) return "select2";
  if (element.closest("[class*='van-picker'],[class*='van-field']")) return "vant";
  if (element.closest("[class*='arco-select']")) return "arco";
  if (element.closest("[class*='semi-select']")) return "semi";
  return "react-select";
}

/** Highlight a filled field so the person can audit the page quickly. */
export function markFilled(element: HTMLElement, ok: boolean): void {
  const previous = element.style.boxShadow;
  const colour = ok ? "rgba(0, 113, 227, 0.55)" : "rgba(224, 45, 27, 0.55)";
  element.style.transition = "box-shadow 240ms cubic-bezier(0.16, 1, 0.3, 1)";
  element.style.boxShadow = `0 0 0 2px ${colour}`;
  element.dataset.quillFilled = ok ? "true" : "failed";
  window.setTimeout(() => {
    element.style.boxShadow = previous;
  }, 2600);
}

/** Read the current value of a field, for the "existing content" check. */
export function readValue(element: HTMLElement): string {
  const tag = element.tagName.toLowerCase();
  if (tag === "select") {
    const select = element as HTMLSelectElement;
    if (select.multiple) {
      return Array.from(select.selectedOptions).map((option) => option.textContent?.trim() ?? "").join("、");
    }
    const chosen = select.selectedOptions[0];
    // Ignore the "please select" placeholder.
    return chosen && chosen.value ? (chosen.textContent?.trim() ?? "") : "";
  }
  if (tag === "input") {
    const input = element as HTMLInputElement;
    if (input.type === "radio") {
      const name = input.getAttribute("name");
      if (!name) return input.checked ? input.value : "";
      const checked = document.querySelector<HTMLInputElement>(
        `input[type="radio"][name="${CSS.escape(name)}"]:checked`,
      );
      return checked?.value ?? "";
    }
    if (input.type === "checkbox") return input.checked ? "true" : "";
    return input.value.trim();
  }
  if (element.isContentEditable) return (element.textContent ?? "").trim();
  return ((element as HTMLTextAreaElement).value ?? "").trim();
}
