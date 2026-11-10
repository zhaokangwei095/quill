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

/**
 * A real pointer sequence.
 *
 * Element UI's select opens on the *wrapper's* mouse sequence, not on a bare
 * `.click()` of its readonly input; the same is true for many Ant Design
 * controls. Dispatching mousedown/mouseup/click is what a person actually does.
 */
function mouseClick(element: HTMLElement): void {
  const rect = element.getBoundingClientRect();
  const init: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  };
  element.dispatchEvent(new MouseEvent("mousedown", init));
  element.dispatchEvent(new MouseEvent("mouseup", init));
  element.dispatchEvent(new MouseEvent("click", init));
}

function optionText(option: HTMLElement): string {
  return (option.textContent ?? "").replace(/\s+/g, " ").trim();
}

function optionSelected(option: HTMLElement): boolean {
  return (
    option.classList.contains("selected") ||
    option.classList.contains("is-selected") ||
    option.classList.contains("is-checked") ||
    option.getAttribute("aria-selected") === "true"
  );
}

/** The selected label(s) a custom control currently displays. */
function selectedText(root: HTMLElement): string {
  const tags = Array.from(
    root.querySelectorAll<HTMLElement>(".el-select__tags .el-tag, .ant-select-selection-item"),
  )
    .map(optionText)
    .filter(Boolean);
  if (tags.length > 0) return tags.join("、");

  const input = root.querySelector<HTMLInputElement>(
    "input.el-input__inner, input.ant-select-selection-search-input",
  );
  if (input?.value.trim()) return input.value.trim();

  const trigger = root.querySelector<HTMLElement>(".el-dropdown-link, .place-select");
  if (trigger) return optionText(trigger);
  return "";
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

/** The visible label/proxy that toggles a checkbox or radio. */
function labelElement(input: HTMLInputElement): HTMLElement | undefined {
  if (input.id) {
    const explicit = document.querySelector<HTMLElement>(`label[for="${CSS.escape(input.id)}"]`);
    if (explicit) return explicit;
  }
  return (
    input.closest<HTMLElement>(
      "label, .el-radio, .el-checkbox, .ant-radio-wrapper, .ant-checkbox-wrapper",
    ) ?? undefined
  );
}

/**
 * Set a checkbox/radio, falling back to its styled label.
 *
 * Element UI renders the real input at `opacity: 0` underneath a label. A
 * programmatic `input.click()` usually works, but some libraries stop the
 * native activation; clicking the wrapping label is what a person does and is
 * the reliable fallback.
 */
function setChecked(input: HTMLInputElement, desired: boolean): void {
  if (input.checked === desired) return;
  input.click();
  if (input.checked === desired) return;
  labelElement(input)?.click();
  if (input.checked === desired) return;
  input.checked = desired;
  dispatchInputEvents(input);
}

function radioGroupMembers(element: HTMLElement): HTMLInputElement[] {
  const name = element.getAttribute("name");
  if (name) {
    return Array.from(
      document.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(name)}"]`),
    );
  }
  const container = element.closest<HTMLElement>(
    ".el-radio-group, .ant-radio-group, [role='radiogroup'], fieldset, .info_box, .el-form-item, .ant-form-item, .form-item",
  );
  return container ? Array.from(container.querySelectorAll<HTMLInputElement>("input[type='radio']")) : [];
}

function writeRadioGroup(element: HTMLElement, value: FieldValue): FillOutcome {
  const group = radioGroupMembers(element);
  if (group.length === 0) return { ref: "", ok: false, reason: "单选项缺少分组" };
  const wanted = [value.raw, value.text].filter((item): item is string => Boolean(item));

  for (const input of group) {
    const labelText = labelElement(input)?.textContent ?? "";
    const candidates = [input.value, labelText.replace(/\s+/g, " ").trim()].filter(Boolean);
    if (!candidates.some((candidate) => wanted.includes(candidate))) continue;

    setChecked(input, true);
    if (input.checked) {
      return { ref: "", ok: true, actual: labelText.trim() || input.value };
    }
  }
  // Name what we actually looked for and what was on offer, so a mismatch is
  // diagnosable from the panel without opening devtools.
  const available = group
    .map((input) => `${input.value}="${(labelElement(input)?.textContent ?? input.value).trim()}"`)
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
    const ownLabel = labelElement(element)?.textContent?.trim() ?? "";
    if (!ownLabel.includes(value.text)) return { ref: "", ok: false, reason: "无法判定勾选状态" };
  }
  const desired = truthy && !falsy;
  setChecked(element, desired);
  return { ref: "", ok: true, actual: element.checked ? "已勾选" : "未勾选" };
}

function writeCheckboxGroup(element: HTMLElement, value: FieldValue): FillOutcome {
  const name = element.getAttribute("name");
  const container = element.closest<HTMLElement>(
    ".el-checkbox-group, .ant-checkbox-group, [role='group'], .info_box, .el-form-item, .ant-form-item, .form-item",
  );
  const group = name
    ? Array.from(
        document.querySelectorAll<HTMLInputElement>(`input[type="checkbox"][name="${CSS.escape(name)}"]`),
      )
    : container
      ? Array.from(container.querySelectorAll<HTMLInputElement>("input[type='checkbox']"))
      : [];
  if (group.length === 0) return { ref: "", ok: false, reason: "多选项缺少分组" };
  const wanted = value.multiple ?? value.text.split(/[、,，;；\n]/).map((part) => part.trim()).filter(Boolean);
  let hits = 0;

  for (const input of group) {
    const labelText = labelElement(input)?.textContent ?? "";
    const clean = labelText.replace(/\s+/g, " ").trim();
    const shouldCheck = wanted.some((needle) => needle === input.value || needle === clean || clean.includes(needle));
    if (shouldCheck) setChecked(input, true);
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

const CUSTOM_OPTION_SELECTORS: Record<string, string> = {
  antd: ".ant-select-item-option, .ant-dropdown-menu-item, .ant-cascader-menu-item",
  "element-ui": ".el-select-dropdown__item, .el-dropdown-menu__item",
  "react-select": "[class*='option']",
  select2: ".select2-results__option",
  vantage: ".van-picker-column__item",
  vant: ".van-picker-column__item",
  arco: ".arco-select-option",
  semi: ".semi-select-option",
};

function customOptions(framework: string): HTMLElement[] {
  const selector = CUSTOM_OPTION_SELECTORS[framework] ?? "[role='option'],[role='menuitem']";
  return Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(isRendered);
}

function pickOption(options: HTMLElement[], needle: string): HTMLElement | undefined {
  const compact = (text: string) => text.replace(/\s+/g, "");
  return (
    options.find((option) => optionText(option) === needle) ??
    options.find((option) => compact(optionText(option)) === compact(needle)) ??
    options.find((option) => optionText(option).includes(needle) || needle.includes(optionText(option)))
  );
}

/**
 * Custom dropdowns (react-select, antd, element-ui) render options into a
 * portal only after the control is opened. Filling one therefore means:
 * open it, wait for the list, then click the option node. Element UI's
 * read-only input needs a mouse sequence on its wrapper, and multiple selects
 * keep the menu open between choices.
 */
async function writeCustomSelect(element: HTMLElement, value: FieldValue, framework: string): Promise<FillOutcome> {
  const root =
    element.closest<HTMLElement>(".el-select, .ant-select, .el-dropdown, .ant-dropdown") ?? element;
  const trigger =
    root.querySelector<HTMLElement>(".el-input, .ant-select-selector, .el-dropdown-link") ?? element;
  const valueText = (value.raw ?? value.text).trim();
  const multiple =
    (value.multiple && value.multiple.length > 0) ||
    root.classList.contains("ant-select-multiple") ||
    root.querySelector(".el-select__tags") !== null ||
    root.querySelector(".el-select-dropdown.is-multiple") !== null ||
    root.hasAttribute("multiple") ||
    root.hasAttribute("max-tag-count");
  const targets = (
    multiple && value.multiple && value.multiple.length > 0
      ? value.multiple
      : multiple
        ? value.text.split(/[、,，;；\n]/)
        : [value.text]
  )
    .map((item) => item.trim())
    .filter(Boolean);

  element.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
  element.focus();
  mouseClick(trigger);
  await wait(180);

  let options = customOptions(framework);
  if (options.length === 0) {
    mouseClick(element);
    await wait(180);
    options = customOptions(framework);
  }
  if (options.length === 0 && !multiple) {
    const current = selectedText(root);
    if (current && current.includes(valueText)) return { ref: "", ok: true, actual: current };
  }
  if (options.length === 0) {
    return { ref: "", ok: false, reason: `下拉列表没有打开（${framework}）` };
  }

  const available = customOptions(framework).map(optionText).slice(0, 20).join("、");
  const picked: string[] = [];

  for (const wanted of targets) {
    const option = pickOption(customOptions(framework), wanted);
    if (!option) continue;
    if (multiple && optionSelected(option)) {
      picked.push(optionText(option));
      continue;
    }
    mouseClick(option);
    await wait(150);
    picked.push(optionText(option));
  }

  // Close without changing what was selected. A body click is the gesture
  // Element UI's click-outside directive listens for.
  document.body.click();
  await wait(120);

  const actual = selectedText(root);
  const compactActual = actual.replace(/\s+/g, "");
  const ok = multiple
    ? targets.every(
        (target) => compactActual.includes(target.replace(/\s+/g, "")) || picked.includes(target),
      )
    : compactActual.length > 0 &&
      targets.every(
        (target) =>
          compactActual.includes(target.replace(/\s+/g, "")) ||
          target.replace(/\s+/g, "").includes(compactActual),
      );

  return ok
    ? { ref: "", ok: true, actual }
    : {
        ref: "",
        ok: false,
        actual,
        reason: available
          ? `没有匹配「${targets.join("、")}」，可选：${available}`
          : `没有匹配「${targets.join("、")}」`,
      };
}

/* ------------------------------------------------------------- cascader */

/*
 * A few common city → province mappings. A cascader only renders one level at
 * a time, so when the profile stores “青岛” and the first level asks for a
 * province there is nothing on screen to match. The hint lets us choose 山东省,
 * after which the city level matches normally. Province-level values need no
 * hint and are unaffected.
 */
const CITY_PROVINCE: Record<string, string> = {
  北京: "北京",
  上海: "上海",
  天津: "天津",
  重庆: "重庆",
  青岛: "山东",
  济南: "山东",
  深圳: "广东",
  广州: "广东",
  杭州: "浙江",
  南京: "江苏",
  苏州: "江苏",
  武汉: "湖北",
  成都: "四川",
  西安: "陕西",
  长沙: "湖南",
  合肥: "安徽",
  厦门: "福建",
  福州: "福建",
  郑州: "河南",
  大连: "辽宁",
  沈阳: "辽宁",
  哈尔滨: "黑龙江",
  长春: "吉林",
  昆明: "云南",
  南昌: "江西",
  太原: "山西",
  石家庄: "河北",
  兰州: "甘肃",
  贵阳: "贵州",
  南宁: "广西",
  海口: "海南",
  银川: "宁夏",
  西宁: "青海",
  乌鲁木齐: "新疆",
  拉萨: "西藏",
  呼和浩特: "内蒙古",
};

function isCascader(element: HTMLElement): boolean {
  return Boolean(element.closest(".el-cascader, .ant-cascader, [class*='cascader']"));
}

function compactPlace(value: string): string {
  return value.replace(/\s+/g, "").replace(/[省市区县]/g, "");
}

function cascaderLabel(node: HTMLElement): string {
  return optionText(
    node.querySelector<HTMLElement>(".el-cascader-node__label, .ant-cascader-menu-item-content") ?? node,
  );
}

function visibleCascaderPanels(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(".el-cascader-panel, .ant-cascader-menus"),
  ).filter(isRendered);
}

async function writeCascader(element: HTMLElement, value: FieldValue): Promise<FillOutcome> {
  const target = (value.raw ?? value.text).trim();
  const input = element as HTMLInputElement;
  const compactTarget = compactPlace(target);
  const provinceHint = Object.entries(CITY_PROVINCE).find(([city]) => target.includes(city))?.[1];

  element.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
  element.focus();
  mouseClick(element);
  await wait(250);

  let panel = visibleCascaderPanels()[0];
  if (!panel) {
    mouseClick(element.closest<HTMLElement>(".el-input") ?? element);
    await wait(250);
    panel = visibleCascaderPanels()[0];
  }
  if (!panel) return { ref: "", ok: false, reason: "级联选择面板没有打开" };

  const picked: string[] = [];
  for (let level = 0; level < 6; level += 1) {
    const menus = Array.from(
      panel.querySelectorAll<HTMLElement>(".el-cascader-menu, .ant-cascader-menu"),
    ).filter(isRendered);
    const menu = menus[menus.length - 1];
    if (!menu) break;
    const nodes = Array.from(
      menu.querySelectorAll<HTMLElement>(".el-cascader-node, .ant-cascader-menu-item"),
    ).filter(isRendered);
    if (nodes.length === 0) break;

    const labels = nodes.map(cascaderLabel);
    const match =
      nodes.find((node) => cascaderLabel(node) === target) ??
      nodes.find((node) => target.includes(cascaderLabel(node)) || cascaderLabel(node).includes(target)) ??
      nodes.find(
        (node) =>
          compactTarget.includes(compactPlace(cascaderLabel(node))) ||
          compactPlace(cascaderLabel(node)).includes(compactTarget),
      ) ??
      (picked.length > 0
        ? nodes.find(
            (node) =>
              cascaderLabel(node).includes(picked[picked.length - 1] ?? "") ||
              (picked[picked.length - 1] ?? "").includes(cascaderLabel(node)),
          )
        : undefined) ??
      (provinceHint
        ? nodes.find((node) => cascaderLabel(node).includes(provinceHint))
        : undefined) ??
      (nodes.length === 1 ? nodes[0] : undefined) ??
      (picked.length === 0 && /^[一-龥]+$/.test(target)
        ? nodes.find((node) => /中国大陆|中国/.test(cascaderLabel(node)))
        : undefined);

    if (!match) {
      element.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Escape", code: "Escape", keyCode: 27 }),
      );
      return {
        ref: "",
        ok: false,
        reason: `级联选项中没有「${target}」，当前层：${labels.join("、")}`,
      };
    }

    const label = cascaderLabel(match);
    const isLeaf = !match.querySelector(".el-icon-arrow-right, .ant-cascader-menu-item-expand-icon");
    mouseClick(match);
    picked.push(label);
    await wait(180);
    if (isLeaf || input.value.trim()) break;
    const nextPanel = visibleCascaderPanels()[0];
    if (!nextPanel) break;
    panel = nextPanel;
  }

  element.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, key: "Escape", code: "Escape", keyCode: 27 }),
  );
  document.body.click();
  await wait(120);

  const actual =
    input.value.trim() || selectedText(element.closest<HTMLElement>(".el-cascader") ?? element);
  const last = picked[picked.length - 1] ?? "";
  const compactLast = compactPlace(last);
  const ok =
    actual.length > 0 &&
    (compactLast.length === 0 ||
      compactTarget.includes(compactLast) ||
      compactLast.includes(compactTarget) ||
      picked.some((part) => compactTarget.includes(compactPlace(part))));

  return ok
    ? { ref: "", ok: true, actual }
    : { ref: "", ok: false, actual, reason: `级联选择未接受「${target}」` };
}

/* ----------------------------------------------------------- date picker */

function isElementDatePicker(element: HTMLElement): boolean {
  return Boolean(element.closest(".el-date-editor, .ant-picker"));
}

function visibleDatePickerPanel(): HTMLElement | undefined {
  return Array.from(
    document.querySelectorAll<HTMLElement>(".el-picker-panel.el-date-picker, .ant-picker-dropdown"),
  ).find(isRendered);
}

/**
 * Drive an Element UI date picker.
 *
 * Its input is controlled by Vue: assigning `.value` and dispatching `input`
 * shows the text for a moment, but the next render reverts it because the
 * component only emits a model update when a day/month/year cell is clicked.
 * The writer therefore opens the panel, navigates to the target month with the
 * header buttons, and clicks the cell a person would click.
 */
async function writeElementDatePicker(element: HTMLElement, value: FieldValue): Promise<FillOutcome> {
  const iso = value.iso ?? toIsoFromText(value.text);
  if (!iso) return { ref: "", ok: false, reason: "无法解析为日期" };
  const [year = 0, month = 1, day = 1] = iso
    .split("-")
    .map((part) => Number.parseInt(part, 10));
  const editor = element.closest<HTMLElement>(".el-date-editor") ?? element;
  const type = editor.className.includes("--year")
    ? "year"
    : editor.className.includes("--month")
      ? "month"
      : "date";

  element.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
  element.focus();
  await wait(200);
  let panel = visibleDatePickerPanel();
  if (!panel) {
    mouseClick(element);
    await wait(250);
    panel = visibleDatePickerPanel();
  }
  if (!panel) return { ref: "", ok: false, reason: "日期面板没有打开" };

  if (type === "year") {
    for (let step = 0; step < 24; step += 1) {
      const header = panel.querySelector<HTMLElement>(".el-date-picker__header-label");
      const currentYear = Number((header?.textContent ?? "").match(/\d{4}/)?.[0]);
      if (currentYear === year) break;
      const direction = currentYear && year < currentYear ? "前一年" : "后一年";
      const button = panel.querySelector<HTMLElement>(`button[aria-label='${direction}']`);
      if (!button) break;
      mouseClick(button);
      await wait(120);
      panel = visibleDatePickerPanel();
      if (!panel) break;
    }
    if (!panel) return { ref: "", ok: false, reason: "日期面板已关闭" };
    const cell = Array.from(
      panel.querySelectorAll<HTMLElement>(".el-year-table td.available .cell, .el-year-table td.available"),
    ).find((node) => Number((node.textContent ?? "").trim()) === year);
    if (!cell) return { ref: "", ok: false, reason: `年份面板中没有 ${year}` };
    mouseClick(cell);
    await wait(220);
  } else if (type === "month") {
    const names = ["一月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "十一月", "十二月"];
    for (let step = 0; step < 24; step += 1) {
      const header = panel.querySelector<HTMLElement>(".el-date-picker__header-label");
      const currentYear = Number((header?.textContent ?? "").match(/\d{4}/)?.[0]);
      if (currentYear === year) break;
      const direction = currentYear && year < currentYear ? "前一年" : "后一年";
      const button = panel.querySelector<HTMLElement>(`button[aria-label='${direction}']`);
      if (!button) break;
      mouseClick(button);
      await wait(120);
      panel = visibleDatePickerPanel();
      if (!panel) break;
    }
    if (!panel) return { ref: "", ok: false, reason: "日期面板已关闭" };
    const targetName = names[month - 1] ?? `${month}月`;
    const cell = Array.from(panel.querySelectorAll<HTMLElement>(".el-month-table td .cell")).find(
      (node) => (node.textContent ?? "").trim() === targetName,
    );
    if (!cell) return { ref: "", ok: false, reason: `月份面板中没有 ${targetName}` };
    mouseClick(cell);
    await wait(220);
  } else {
    for (let step = 0; step < 36; step += 1) {
      const labels = Array.from(
        panel.querySelectorAll<HTMLElement>(".el-date-picker__header-label"),
      ).map((node) => node.textContent ?? "");
      const joined = labels.join(" ");
      const currentYear = Number(joined.match(/(\d{4})\s*年/)?.[1]);
      const currentMonth = Number(joined.match(/(\d{1,2})\s*月/)?.[1]);
      if (!currentYear || !currentMonth) break;
      if (currentYear === year && currentMonth === month) break;

      const direction =
        year < currentYear
          ? "前一年"
          : year > currentYear
            ? "后一年"
            : month < currentMonth
              ? "上个月"
              : "下个月";
      const button = panel.querySelector<HTMLElement>(`button[aria-label='${direction}']`);
      if (!button) break;
      mouseClick(button);
      await wait(110);
      panel = visibleDatePickerPanel();
      if (!panel) break;
    }
    if (!panel) return { ref: "", ok: false, reason: "日期面板已关闭" };
    const cell = Array.from(panel.querySelectorAll<HTMLElement>(".el-date-table td.available")).find(
      (node) => Number((node.textContent ?? "").trim()) === day,
    );
    if (!cell) return { ref: "", ok: false, reason: `日期面板中没有 ${day} 日` };
    mouseClick(cell);
    await wait(220);
  }

  element.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, key: "Escape", code: "Escape", keyCode: 27 }),
  );
  document.body.click();
  await wait(120);

  const actual = (element as HTMLInputElement).value.trim();
  const digits = actual.replace(/\D/g, "");
  const expected = type === "year" ? String(year) : `${year}${String(month).padStart(2, "0")}`;
  return digits.includes(expected)
    ? { ref: "", ok: true, actual }
    : { ref: "", ok: false, actual, reason: "日期控件未接受该值" };
}

function isRendered(element: HTMLElement): boolean {
  if (element.closest("[aria-hidden='true']")) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * Choose the matching suggestion after typing into an autocomplete.
 *
 * Tencent's school, company and major inputs render a `<ul><li>` list under the
 * input. Free text usually stays in the box, but clicking the matching entry is
 * what makes the framework store the selected entity and enables its
 * validation. This is a no-op when no suggestion is rendered.
 */
async function acceptSuggestion(
  element: HTMLElement,
  value: string,
  key?: string,
): Promise<string | undefined> {
  /*
   * Autocomplete belongs to short entity names (school, company, major). A long
   * essay must never be matched against arbitrary `<li>` text: the old
   * `value.includes(option)` direction matched almost any list item inside the
   * field's container and clicked away the text we had just written.
   */
  const needle = value.trim();
  if (needle.length === 0 || needle.length > 40) return undefined;
  if (element.tagName.toLowerCase() === "textarea") return undefined;

  const autocompleteKey = key === "education.school" || key === "education.major" || key === "work.company";
  const autocompleteWidget = Boolean(
    element.getAttribute("aria-autocomplete") ||
      element.matches("input[list], [role='combobox']") ||
      element.closest("[class*='autocomplete'],[class*='auto-complete'],[class*='suggest']"),
  );
  if (!autocompleteKey && !autocompleteWidget) return undefined;

  const box =
    element.closest<HTMLElement>(".info_box, .el-form-item, .ant-form-item, .form-item, .form-group") ??
    element.parentElement;
  if (!box) return undefined;

  const findMatch = (): HTMLElement | undefined => {
    const options = Array.from(
      box.querySelectorAll<HTMLElement>("ul li, [role='option'], [class*='option'], [class*='suggest']"),
    ).filter(isRendered);
    return (
      options.find((option) => optionText(option) === needle) ??
      options.find((option) => {
        const text = optionText(option);
        return text.length > 1 && text.includes(needle) && text.length <= needle.length + 24;
      })
    );
  };

  let match = findMatch();
  if (!match) {
    match = await new Promise<HTMLElement | undefined>((resolve) => {
      let settled = false;
      const observer = new MutationObserver(() => {
        const candidate = findMatch();
        if (candidate) finish(candidate);
      });
      const timeout = window.setTimeout(() => finish(undefined), 200);
      const finish = (candidate: HTMLElement | undefined): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        observer.disconnect();
        resolve(candidate);
      };
      observer.observe(box, { childList: true, subtree: true, characterData: true, attributes: true });
      const candidate = findMatch();
      if (candidate) finish(candidate);
    });
  }
  if (!match) return undefined;
  mouseClick(match);
  await wait(120);
  return readValue(element);
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

  /*
   * A read-only input is normally not ours to touch, but Element UI and Ant
   * Design render their select, cascader and date-picker inputs read-only on
   * purpose: the component owns the value and expects clicks on its panel.
   * Those are the *only* read-only controls we drive.
   */
  const customWidget = element.closest(
    "[class*='ant-select'],[class*='el-select'],[class*='el-cascader'],[class*='el-date-editor'],[class*='el-dropdown'],[class*='ant-picker'],[class*='select__control'],[class*='semi-select'],[class*='arco-select'],[role='combobox']",
  );
  if ((element as HTMLInputElement).readOnly && !customWidget) {
    return { ref: decision.ref, ok: false, reason: "字段为只读" };
  }

  const framework = element.closest(
    "[class*='ant-select'],[class*='el-select'],[class*='el-cascader'],[class*='el-date-editor'],[class*='el-dropdown'],[class*='ant-picker'],[class*='select__control'],[class*='semi-select'],[class*='arco-select']",
  );
  const isNativeSelect = element.tagName.toLowerCase() === "select";

  let outcome: FillOutcome;
  try {
    if (decision.kind === "radio-group") outcome = writeRadioGroup(element, decision.value);
    else if (decision.kind === "checkbox-group") outcome = writeCheckboxGroup(element, decision.value);
    else if (decision.kind === "checkbox") outcome = writeCheckbox(element as HTMLInputElement, decision.value);
    else if (decision.kind === "select" && isNativeSelect) outcome = writeSelect(element as HTMLSelectElement, decision.value);
    else if (isCascader(element)) outcome = await writeCascader(element, decision.value);
    else if (isElementDatePicker(element)) outcome = await writeElementDatePicker(element, decision.value);
    else if (decision.kind === "combobox" || (framework && !isNativeSelect)) {
      outcome = await writeCustomSelect(element, decision.value, detectFrameworkName(element));
    } else if (decision.kind === "date") outcome = writeDate(element, decision.value, "date");
    else {
      outcome = writeText(element, decision.value.text);
      if (outcome.ok) {
        const actual = await acceptSuggestion(element, decision.value.text, decision.key);
        if (actual) {
          const same =
            actual.includes(decision.value.text) || decision.value.text.includes(actual);
          outcome = same
            ? { ...outcome, actual }
            : { ...outcome, actual, ok: false, reason: "自动补全候选与资料不一致" };
        }
      }
    }
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
  if (element.closest("[class*='ant-select'],[class*='ant-picker'],[class*='ant-dropdown'],[class*='ant-cascader']")) return "antd";
  if (
    element.closest(
      "[class*='el-select'],[class*='el-cascader'],[class*='el-dropdown'],[class*='el-date-editor']",
    )
  ) {
    return "element-ui";
  }
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
