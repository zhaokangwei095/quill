/**
 * Reading a form.
 *
 * The scanner turns the live DOM into an array of `FieldDescriptor`s with no
 * lingering references, so the plan can be computed in the service worker and
 * applied later even if the page re-rendered in between. Each field carries a
 * `ref` that is stable across re-renders of the same markup.
 */

import {
  classifyFields,
  detectSection,
  type FieldDescriptor,
  type FieldKind,
  type FieldOption,
  type FieldSection,
  type PageScan,
  type WidgetFramework,
} from "@quill/core";
import {
  detectMaxLength,
  groupLegend,
  isVisible,
  nearestHeading,
  nearbyHint,
  recoverLabel,
} from "./labels.js";

/* -------------------------------------------------------------- identity */

/** A small non-cryptographic hash, used to build stable refs. */
function hash(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193);
    h2 = Math.imul(h2 + code, 0x85ebca6b) ^ (h2 >>> 13);
  }
  return ((h1 >>> 0).toString(36) + (h2 >>> 0).toString(36)).slice(0, 10);
}

/**
 * A path from the document root. Used as a *hint*, not as identity, because
 * frameworks reuse nodes and reorder siblings.
 */
function domPath(element: Element): string {
  const parts: string[] = [];
  let current: Element | null = element;
  let depth = 0;
  while (current && depth < 8) {
    const parent: Element | null = current.parentElement;
    if (!parent) {
      parts.unshift(current.tagName.toLowerCase());
      break;
    }
    const index = Array.from(parent.children).indexOf(current);
    parts.unshift(`${current.tagName.toLowerCase()}[${index}]`);
    current = parent;
    depth += 1;
  }
  return parts.join(">");
}

/**
 * Stable identity for a field.
 *
 * Three inputs, in decreasing stability: an explicit `id`, then the form
 * `name`, then the DOM path. The label text is mixed in because two rows of a
 * repeatable section have identical attributes (name="school") but different
 * structure — including the path keeps them distinct without making the ref
 * change when the page re-renders.
 */
function buildRef(element: HTMLElement, label: string): string {
  const id = element.getAttribute("id");
  if (id) return `id:${id}`;
  const name = element.getAttribute("name");
  if (name) return `name:${name}#${hash(domPath(element))}`;
  return `path:${domPath(element)}#${hash(label)}`;
}

/* ----------------------------------------------------------------- kinds */

function detectKind(element: HTMLElement): FieldKind {
  const tag = element.tagName.toLowerCase();
  if (tag === "textarea") return "textarea";
  if (element.isContentEditable) return "contenteditable";
  if (tag === "select") return "select";
  if (tag !== "input") return "unknown";

  const type = (element as HTMLInputElement).type?.toLowerCase() ?? "text";
  switch (type) {
    case "email":
      return "email";
    case "tel":
      return "tel";
    case "url":
      return "url";
    case "number":
      return "number";
    case "date":
    case "month":
      return "date";
    case "file":
      return "file";
    case "radio":
      return "radio-group";
    case "checkbox":
      return "checkbox";
    case "hidden":
    case "submit":
    case "button":
    case "reset":
    case "image":
    case "password":
      return "unknown";
    default:
      return "text";
  }
}

/** Options for a `<select>`, including `<optgroup>`. */
function readSelectOptions(element: HTMLSelectElement): FieldOption[] {
  const options: FieldOption[] = [];
  for (const option of Array.from(element.options)) {
    const label = (option.textContent ?? "").trim();
    const value = option.value;
    // Skip the "please choose" placeholder, but keep its existence known.
    if ((!value || value === "-1" || value === "0") && !label) continue;
    options.push({
      value,
      label: label || value,
      ...(option.disabled ? { disabled: true } : {}),
    });
  }
  return options;
}

/**
 * Options for a custom dropdown (react-select, antd, element-ui …). These hide
 * a real list of nodes that are only rendered once the control is opened, so we
 * look for the usual places a page keeps them.
 */
function readCustomOptions(element: HTMLElement, framework: WidgetFramework): FieldOption[] {
  const scope =
    element.closest("[class*='select'],[class*='Select'],[class*='dropdown'],[class*='Dropdown']")?.parentElement ??
    element.parentElement;
  if (!scope) return [];

  const selectorsByFramework: Partial<Record<WidgetFramework, string>> = {
    antd: ".ant-select-item-option[title], .ant-select-item-option",
    "element-ui": ".el-select-dropdown__item",
    "react-select": "[class*='option']",
    select2: ".select2-results__option",
    vant: ".van-picker-column__item",
    arco: ".arco-select-option",
    semi: ".semi-select-option",
  };
  const selector = selectorsByFramework[framework];
  if (!selector) return [];

  const found: FieldOption[] = [];
  for (const node of Array.from(scope.querySelectorAll(selector))) {
    const label = (node.textContent ?? "").trim();
    if (!label) continue;
    // The DOM value of a custom option is usually a generated key, so the label
    // is the only reliable thing — we record it as both.
    found.push({ value: label, label });
  }
  return found;
}

/** Group radio buttons by `name`, since each is a separate input. */
function readRadioGroup(element: HTMLInputElement, scope: ParentNode): FieldDescriptor["options"] {
  const name = element.getAttribute("name");
  if (!name) return undefined;
  const options: FieldOption[] = [];
  const escaped = CSS.escape(name);
  for (const input of Array.from(scope.querySelectorAll<HTMLInputElement>(`input[type='radio'][name="${escaped}"]`))) {
    /*
     * `??` does not fall through an empty string, so `(cond ? text : "") ?? next`
     * returned "" whenever the input had no id — which is most of them. The
     * chain has to test for a non-empty result, not a non-nullish one.
     */
    const byFor = input.id
      ? document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(input.id)}"]`)?.textContent
      : undefined;
    const label = firstNonEmpty(byFor, input.closest("label")?.textContent, input.value);
    const text = label.replace(/\s+/g, " ").trim();
    if (text) options.push({ value: input.value, label: text });
  }
  return options.length > 0 ? options : undefined;
}

/** The first argument that is a non-empty string, or "" when there is none. */
function firstNonEmpty(...candidates: Array<string | null | undefined>): string {
  for (const candidate of candidates) {
    if (candidate && candidate.trim()) return candidate;
  }
  return "";
}

/* ------------------------------------------------------------ frameworks */

/**
 * Widget library detection. The fill technique differs per library — a native
 * `select` wants `.value` plus a `change` event, whereas react-select needs a
 * real pointer sequence on its option node.
 */
function detectFramework(element: HTMLElement): WidgetFramework {
  const signatures: Array<[string, WidgetFramework]> = [
    ["[class*='ant-select'],[class*='ant-input'],[class*='ant-form']", "antd"],
    ["[class*='el-select'],[class*='el-input'],[class*='el-form']", "element-ui"],
    ["[class*='select__control'],[class*='react-select']", "react-select"],
    ["[class*='select2'],[class*='select2-container']", "select2"],
    ["[class*='van-field'],[class*='van-picker']", "vant"],
    ["[class*='arco-select'],[class*='arco-input']", "arco"],
    ["[class*='semi-select'],[class*='semi-input']", "semi"],
    ["[data-automation-id],[data-automationid]", "workday"],
  ];
  for (const [selector, framework] of signatures) {
    try {
      if (element.closest(selector)) return framework;
    } catch {
      // A selector that the running browser cannot parse; skip it.
    }
  }
  if (document.querySelector("input[type='file'][id^='file-upload'], [id*='taleo']")) return "taleo";
  return "native";
}

/* ------------------------------------------------------------------- scan */

/** Elements that could be a fillable field. */
const FIELD_SELECTOR = [
  "input:not([type='hidden']):not([type='submit']):not([type='button']):not([type='reset']):not([type='image'])",
  "select",
  "textarea",
  "[contenteditable='true']",
  "[contenteditable='']",
  "[role='textbox']",
  "[role='combobox']",
  "[role='listbox']",
].join(",");

const MAX_FIELDS = 400;

function sectionFromText(...parts: Array<string | undefined>): FieldSection {
  const text = parts.filter(Boolean).join(" ");
  if (!text) return "unknown";
  return detectSection(text);
}

export interface ScanOptions {
  /** Include fields that are not visible (used by the calibration view). */
  includeHidden?: boolean;
  /** Restrict to a subtree, for in-page section refresh. */
  root?: ParentNode;
}

export interface ScanResult {
  scan: PageScan;
  /**
   * The live element behind each descriptor, keyed by `ref`.
   *
   * This exists because a descriptor's *position* is not usable as a lookup
   * key: `buildPlan` sorts decisions for application order, and the scanner
   * filters out hidden and unclassifiable nodes, so index i in the plan is not
   * index i in `querySelectorAll`. Handing back the actual elements removes the
   * ambiguity — every fill goes to the element the descriptor was read from.
   */
  elements: Map<string, HTMLElement>;
}

export function scanPage(options: ScanOptions = {}): ScanResult {
  const root = options.root ?? document;
  const elements = Array.from(root.querySelectorAll<HTMLElement>(FIELD_SELECTOR));
  const descriptors: FieldDescriptor[] = [];
  const byRef = new Map<string, HTMLElement>();
  const seenRadioGroups = new Set<string>();

  for (const element of elements) {
    if (descriptors.length >= MAX_FIELDS) break;
    if (!options.includeHidden && !isVisible(element)) continue;

    const kind = detectKind(element);
    if (kind === "unknown") continue;

    // Radio groups are represented once, by their first member.
    if (kind === "radio-group") {
      const name = element.getAttribute("name") ?? buildRef(element, "");
      if (seenRadioGroups.has(name)) continue;
      seenRadioGroups.add(name);
    }

    const recovered = recoverLabel(element);
    let label = recovered.text;
    let labelSource = recovered.source;

    /*
     * A radio group needs its question recovered from surrounding text, because
     * the first radio's own label is just "是". A lone checkbox does not: its
     * label *is* the statement ("我已阅读并同意隐私政策"), and overwriting it with
     * the enclosing section's heading produced a field called "提交".
     *
     * Only a checkbox that is genuinely one of several sharing a name is a group.
     */
    const checkboxName = element.getAttribute("name");
    const isCheckboxGroup =
      kind === "checkbox" &&
      Boolean(checkboxName) &&
      document.querySelectorAll(`input[type='checkbox'][name="${CSS.escape(checkboxName as string)}"]`).length > 1;

    if (kind === "radio-group" || isCheckboxGroup) {
      /*
       * Order matters. The question is almost always the text immediately before
       * the options — `<span>是否有亲属…</span><label>是…` — not the enclosing
       * section's `<legend>`, which names the whole section ("基本信息").
       * Preferring the legend produced a field labelled with its section heading,
       * which then classified as a heading rather than as the question.
       */
      const question = recoverGroupQuestion(element) || groupLegend(element);
      const legend = question;
      if (legend) {
        label = legend;
        labelSource = "wrapper";
      }
    }

    const hint = nearbyHint(element);
    const heading = nearestHeading(element);
    const framework = detectFramework(element);
    const tag = element.tagName.toLowerCase();
    const inputType = tag === "input" ? (element as HTMLInputElement).type : undefined;

    // Named `fieldOptions`, not `options`, which is the scan configuration.
    let fieldOptions: FieldOption[] | undefined;
    if (kind === "select") fieldOptions = readSelectOptions(element as HTMLSelectElement);
    else if (kind === "radio-group") fieldOptions = readRadioGroup(element as HTMLInputElement, root);
    else if (framework !== "native") {
      const custom = readCustomOptions(element, framework);
      if (custom.length > 0) fieldOptions = custom;
    }
    if (fieldOptions && fieldOptions.length === 0) fieldOptions = undefined;

    const maxLength = detectMaxLength(element, hint);

    const ref = buildRef(element, label);
    // The first element wins: a repeated ref means duplicate markup, and the
    // first is the one the person sees.
    if (!byRef.has(ref)) byRef.set(ref, element);

    descriptors.push({
      ref,
      kind,
      label,
      labelSource,
      ...(hint ? { hint } : {}),
      ...(element.getAttribute("name") ? { name: element.getAttribute("name") as string } : {}),
      ...(element.getAttribute("id") ? { id: element.getAttribute("id") as string } : {}),
      ...(element.getAttribute("placeholder") ? { placeholder: element.getAttribute("placeholder") as string } : {}),
      ...(element.getAttribute("autocomplete") ? { autocomplete: element.getAttribute("autocomplete") as string } : {}),
      ...(element.getAttribute("title") ? { title: element.getAttribute("title") as string } : {}),
      required: isRequired(element),
      disabled: isDisabled(element),
      readOnly: element.getAttribute("readonly") !== null || element.getAttribute("aria-readonly") === "true",
      ...(maxLength !== undefined ? { maxLength } : {}),
      ...(element.getAttribute("pattern") ? { pattern: element.getAttribute("pattern") as string } : {}),
      ...(inputType ? { inputType } : {}),
      ...(fieldOptions ? { options: fieldOptions } : {}),
      section: sectionFromText(heading, label, hint, element.getAttribute("name") ?? undefined),
      ...(heading ? { groupHeading: heading } : {}),
      framework,
    });
  }

  const classified = classifyFields(descriptors);
  const ats = detectAts();

  return {
    scan: {
      url: window.location.href,
      origin: window.location.origin,
      title: document.title,
      siteKey: siteKey(),
      scannedAt: Date.now(),
      fields: classified,
      ...(ats ? { ats } : {}),
    },
    elements: byRef,
  };
}

/**
 * For a radio/checkbox group, the question is often in a sibling element
 * rather than a `<legend>`: `<div><span>是否接受调剂</span><label>是…`.
 */
function recoverGroupQuestion(element: HTMLElement): string {
  let current: HTMLElement | null = element;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    let sibling = current.previousElementSibling;
    let hops = 0;
    while (sibling && hops < 3) {
      const text = (sibling.textContent ?? "").replace(/\s+/g, " ").trim();
      // The question is a short phrase that is not itself an answer option.
      if (text.length > 1 && text.length <= 40 && !/^(是|否|男|女|有|无)$/.test(text)) {
        return text;
      }
      sibling = sibling.previousElementSibling;
      hops += 1;
    }
    current = current.parentElement;
  }
  return "";
}

function isRequired(element: HTMLElement): boolean {
  if (element.getAttribute("required") !== null || element.getAttribute("aria-required") === "true") return true;
  // Chinese forms mark required fields with an asterisk in the label.
  const labelText = element.closest("label,tr,.form-item,.form-group,div")?.textContent ?? "";
  if (/[*＊]\s*$/.test(labelText.slice(0, 80)) || /^\s*[*＊]/.test(labelText)) return true;
  if (element.classList.contains("required") || element.classList.contains("is-required")) return true;
  const marker = element.closest(".required,.is-required,.ant-form-item-required,.el-form-item.is-required");
  return marker !== null;
}

function isDisabled(element: HTMLElement): boolean {
  if ((element as HTMLInputElement).disabled) return true;
  if (element.getAttribute("aria-disabled") === "true") return true;
  // A disabled fieldset disables everything inside it.
  const fieldset = element.closest("fieldset[disabled]");
  return fieldset !== null;
}

/** Site identity: the registrable-ish domain, used to scope memory. */
export function siteKey(): string {
  const host = window.location.hostname.toLowerCase();
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  // Keep the last two labels, with a carve-out for the common multi-part TLDs.
  const secondLevel = parts[parts.length - 2] ?? "";
  const multiPart = new Set(["com", "net", "org", "gov", "edu", "co"]);
  if (multiPart.has(secondLevel) && parts.length >= 3) {
    return parts.slice(-3).join(".");
  }
  return parts.slice(-2).join(".");
}

/** Recognise well-known applicant tracking systems for site-specific rules. */
function detectAts(): string | undefined {
  const host = window.location.hostname.toLowerCase();
  const signs: Array<[RegExp, string]> = [
    [/workday|myworkdayjobs/, "Workday"],
    [/taleo|oraclecloud/, "Taleo"],
    [/successfactors|sapsf/, "SuccessFactors"],
    [/icims/, "iCIMS"],
    [/greenhouse\.io/, "Greenhouse"],
    [/lever\.co/, "Lever"],
    [/smartrecruiters/, "SmartRecruiters"],
    [/(zhaopin|51job|lagou|boss|liepin|maimai)/, "中文招聘平台"],
    [/(beisen|dayee|moka|italent|kenexa)/, "中文 ATS"],
  ];
  for (const [pattern, name] of signs) {
    if (pattern.test(host)) return name;
  }
  // Some ATSs render into a known container.
  if (document.querySelector("[data-automation-id='jobPostingForm'],[class*='workday']")) return "Workday";
  if (document.querySelector("[id*='taleo'],[class*='taleo']")) return "Taleo";
  return undefined;
}

/**
 * The job title as the page states it, used to answer 应聘岗位 without asking.
 * Read from the document title and common heading patterns, and cleaned of the
 * boilerplate that surrounds it.
 */
export function detectPageRole(): string {
  const candidates: string[] = [];

  const meta = document.querySelector<HTMLMetaElement>("meta[property='og:title'],meta[name='title']");
  if (meta?.content) candidates.push(meta.content);

  for (const selector of [
    "h1",
    "[class*='job-title']",
    "[class*='jobTitle']",
    "[class*='position-name']",
    "[class*='post-title']",
    "[class*='jobName']",
  ]) {
    for (const node of Array.from(document.querySelectorAll(selector)).slice(0, 3)) {
      const text = (node.textContent ?? "").trim();
      if (text) candidates.push(text);
    }
  }
  candidates.push(document.title);

  const noise = /(招聘|官网|校园招聘|社会招聘|apply|careers?|jobs?|申请|投递|职位详情|岗位详情|-\s*$|_\s*$)/gi;
  for (const candidate of candidates) {
    const cleaned = candidate
      .split(/[|｜\-–—_·]/)
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => part.replace(noise, "").trim())
      .filter((part) => part.length >= 2 && part.length <= 40);
    // The segment that looks like a role wins.
    const role = cleaned.find((part) =>
      /(工程师|经理|专员|主管|总监|设计师|开发|运营|分析|顾问|助理|实习生|研究员|招聘|产品|测试|架构|实习生|teacher|engineer|manager|analyst|designer|developer|intern|specialist)/i.test(
        part,
      ),
    );
    if (role) return role;
    if (cleaned[0]) return cleaned[0];
  }
  return "";
}

/** The company name, read from the same places a human would look. */
export function detectCompany(): string {
  const selectors = [
    "[class*='company-name']",
    "[class*='companyName']",
    "[class*='corp-name']",
    "[itemprop='hiringOrganization']",
    "[class*='employer']",
  ];
  for (const selector of selectors) {
    const node = document.querySelector(selector);
    const text = (node?.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text && text.length <= 40) return text;
  }
  const title = document.title.split(/[|｜\-–—_·]/).map((part) => part.trim());
  for (const part of title) {
    if (/(有限公司|集团|科技|股份|银行|研究院|事务所|inc|ltd|corp)/i.test(part) && part.length <= 40) {
      return part;
    }
  }
  return "";
}

export { buildRef, hash };
