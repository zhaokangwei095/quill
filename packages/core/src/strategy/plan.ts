/**
 * Turning a page scan into a plan the person can review.
 *
 * This is the "think about a fill strategy" step in the product: it groups the
 * page, decides per field, orders the work so that dependent answers are
 * available first, and produces the notes the overlay shows.
 */

import { tallyDecisions, type Decision, type FieldDescriptor, type FillPlan, type PageScan } from "../types.js";
import { DEFINITION_BY_KEY, NEVER_AUTOFILL_KEYS } from "../fields/taxonomy.js";
import { decideForField, type DecideOptions } from "./resolve.js";

export interface PlanOptions extends DecideOptions {
  /** Extra field-level notes produced by the scanner (ATS quirks). */
  notes?: string[];
}

/**
 * Order matters when applying: section headers and repeat-row structure should
 * be settled before values are typed, and short fields before long ones so a
 * validation error on a textarea does not discard earlier work.
 */
const SECTION_ORDER: Record<string, number> = {
  identity: 0,
  contact: 1,
  education: 2,
  experience: 3,
  project: 4,
  skill: 5,
  preference: 6,
  essay: 7,
  meta: 8,
  unknown: 9,
};

const KIND_ORDER: Record<string, number> = {
  select: 0,
  combobox: 1,
  "radio-group": 2,
  checkbox: 3,
  "checkbox-group": 4,
  date: 5,
  text: 6,
  email: 7,
  tel: 8,
  number: 9,
  url: 10,
  textarea: 11,
  contenteditable: 12,
  file: 13,
  unknown: 14,
};

export function buildPlan(scan: PageScan, options: PlanOptions): FillPlan {
  const decisions: Decision[] = [];
  const notes = [...(options.notes ?? [])];

  // Repeat counting per section, so the 2nd 学校名称 reads the 2nd entry.
  const seenByKey = new Map<string, number>();
  for (const field of scan.fields) {
    const key = field.key ?? "unknown";
    const seen = seenByKey.get(key) ?? 0;
    seenByKey.set(key, seen + 1);

    // Only repeatable sections get an index; elsewhere a duplicate is a
    // template artifact and should not shift later reads.
    const isRepeatable =
      field.section === "education" || field.section === "experience" || field.section === "project";
    const indexed: FieldDescriptor =
      isRepeatable && seen > 0 ? { ...field, repeatIndex: seen + 1 } : field;

    decisions.push(decideForField(indexed, options));
  }

  // Sort for application order while keeping the panel grouped by page position.
  decisions.sort((a, b) => {
    const sectionA = sectionRank(a);
    const sectionB = sectionRank(b);
    if (sectionA !== sectionB) return sectionA - sectionB;
    const kindA = KIND_ORDER[a.kind] ?? 99;
    const kindB = KIND_ORDER[b.kind] ?? 99;
    if (kindA !== kindB) return kindA - kindB;
    return a.label.localeCompare(b.label, "zh-Hans-CN");
  });

  const tally = tallyDecisions(decisions);

  /*
   * Consent checkboxes and captchas are fields we must *never* fill. Listing
   * them as "资料库中没有这一项" is worse than saying nothing: it invites the
   * person to type a value into a control that only they may legitimately
   * operate, and it pads the missing list with items that are not missing
   * anything. They are counted separately and explained once.
   */
  const handsOff = decisions.filter((decision) => NEVER_AUTOFILL_KEYS.has(decision.key)).length;
  const actionable = decisions.filter((decision) => !NEVER_AUTOFILL_KEYS.has(decision.key));

  // Surface the strategy itself — the person should not have to guess why the
  // extension is confident about some fields and silent about others.
  const missingRequired = actionable.filter((decision) => decision.status === "missing" && decision.required);
  if (missingRequired.length > 0) {
    notes.push(
      `${missingRequired.length} 个必填项缺少可用资料：${missingRequired
        .slice(0, 3)
        .map((decision) => decision.label)
        .join("、")}${missingRequired.length > 3 ? " 等" : ""}`,
    );
  }
  const choices = actionable.filter((decision) => decision.status === "choice");
  if (choices.length > 0) {
    notes.push(`${choices.length} 个字段存在多个可能取值，需要你选择`);
  }
  const composed = actionable.filter((decision) => decision.evidence.source === "composed");
  if (composed.length > 0) {
    notes.push(`${composed.length} 段文字由简历内容整理生成，建议提交前通读`);
  }
  if (handsOff > 0) {
    notes.push(`${handsOff} 项（验证码 / 协议勾选）需要你自己操作，Quill 不会代填`);
  }

  return {
    url: scan.url,
    siteKey: scan.siteKey,
    createdAt: Date.now(),
    decisions,
    tally,
    notes,
  };
}

function sectionRank(decision: Decision): number {
  const definition = DEFINITION_BY_KEY.get(decision.key);
  const section = definition?.section ?? keySection(decision.key);
  return SECTION_ORDER[section] ?? 9;
}

function keySection(key: string): string {
  const prefix = key.split(".")[0] ?? "";
  return prefix === "work" ? "experience" : prefix;
}

/* ------------------------------------------------------------- selection */

export interface SelectionFilter {
  /** Include fields whose tag is trustworthy enough to write silently. */
  includeReady?: boolean;
  /** Include inferred values the person must confirm. */
  includeReview?: boolean;
  /** Restrict to specific refs (used by "apply this one" in the panel). */
  refs?: string[];
  /** Skip a set of refs (used for "ignore" in the panel). */
  excludeRefs?: string[];
}

export function selectDecisions(plan: FillPlan, filter: SelectionFilter = {}): Decision[] {
  const includeReady = filter.includeReady ?? true;
  const includeReview = filter.includeReview ?? false;
  const refs = filter.refs ? new Set(filter.refs) : undefined;
  const exclude = filter.excludeRefs ? new Set(filter.excludeRefs) : undefined;

  return plan.decisions.filter((decision) => {
    if (!decision.value) return false;
    if (refs && !refs.has(decision.ref)) return false;
    if (exclude?.has(decision.ref)) return false;
    if (decision.status === "ready") return includeReady;
    if (decision.status === "review") return includeReview;
    return false;
  });
}

/** Decisions that need a human, in the order the panel should list them. */
export function attentionDecisions(plan: FillPlan): Decision[] {
  const rank = (decision: Decision) => {
    if (decision.status === "missing" && decision.required) return 0;
    if (decision.status === "choice") return 1;
    if (decision.status === "missing") return 2;
    if (decision.status === "review") return 3;
    return 4;
  };
  return [...plan.decisions]
    .filter((decision) => decision.status !== "ready")
    .sort((a, b) => rank(a) - rank(b));
}

/** A one-line summary for the collapsed overlay. */
export function planSummary(plan: FillPlan): string {
  const { ready, review, choice, missing } = plan.tally;
  const parts: string[] = [];
  if (ready > 0) parts.push(`${ready} 项可直接填写`);
  if (review > 0) parts.push(`${review} 项待确认`);
  if (choice > 0) parts.push(`${choice} 项需选择`);
  if (missing > 0) parts.push(`${missing} 项缺资料`);
  return parts.length > 0 ? parts.join(" · ") : "未识别到可填写的字段";
}
