/**
 * Turning a page scan into a plan the person can review.
 *
 * This is the "think about a fill strategy" step in the product: it groups the
 * page, decides per field, orders the work so that dependent answers are
 * available first, and produces the notes the overlay shows.
 */

import {
  tallyDecisions,
  type Decision,
  type FieldDescriptor,
  type FillPlan,
  type HiringTrack,
  type PageScan,
} from "../types.js";
import { ABSENCE_KEYS, DEFINITION_BY_KEY, NEVER_AUTOFILL_KEYS } from "../fields/taxonomy.js";
import { decideForField, type DecideOptions } from "./resolve.js";
import { effectiveHiringTrack, experiencesForTrack } from "./experience.js";

const TRACK_LABELS: Record<Exclude<HiringTrack, "unknown">, string> = {
  internship: "实习",
  campus: "校招",
  experienced: "社招",
};

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

/** Skill keys that belong to a structured, repeatable award row. */
const REPEATABLE_SKILL_KEYS = new Set(["skill.awards", "skill.awardLevel", "skill.awardDate"]);

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
  const declaredTrack = options.profile.preference.targetTrack;
  const effectiveTrack = effectiveHiringTrack(scan.hiringTrack, declaredTrack);
  /*
   * Whether the page splits GPA and its scale into two questions is a property
   * of the scan, not of the profile. Pass it down so `education.gpa` knows
   * whether to return "3.7" (there is a separate scale box) or "3.7/4.0".
   */
  const planOptions: PlanOptions = {
    ...options,
    hiringTrack: effectiveTrack,
    hasGpaBase:
      options.hasGpaBase === true || scan.fields.some((field) => field.key === "education.gpaBase"),
  };

  /*
   * Say which education policy we inferred. The person should not have to
   * wonder why Quill filled only the master's row on one site and both rows on
   * another; the difference is the page's own wording, and it is worth naming.
   */
  const hasEducation = scan.fields.some((field) => field.section === "education");
  if (hasEducation && scan.educationPolicy === "current-only") {
    notes.push("这一页只要求当前/最高学历，已按最高一段教育经历填写；本科等历史学历无需添加。");
  } else if (hasEducation && scan.educationPolicy === "full-history") {
    notes.push("这一页要求完整教育经历，按学历从高到低填写；需要时会自动补足学历行。");
  }

  if (scan.hiringTrack === "internship") {
    notes.push("识别为实习招聘：到岗时间优先按实习可到岗信息处理，经历栏优先匹配实习经历。");
  } else if (scan.hiringTrack === "campus") {
    notes.push("识别为校招：经历栏优先匹配实习经历，不会把全职工作经历当作实习经历填写。");
  } else if (scan.hiringTrack === "experienced") {
    notes.push("识别为社招：经历栏优先匹配全职或正式工作经历。");
  } else if (effectiveTrack) {
    notes.push(`页面没有明确招聘类型，按这份简历标记为${TRACK_LABELS[effectiveTrack]}来筛选经历。`);
  }
  if (
    scan.hiringTrack &&
    scan.hiringTrack !== "unknown" &&
    declaredTrack &&
    declaredTrack !== scan.hiringTrack
  ) {
    notes.push(
      `页面识别为${TRACK_LABELS[scan.hiringTrack]}，这份简历标记为${TRACK_LABELS[declaredTrack]}；经历筛选以页面类型为准。`,
    );
  }
  if (
    effectiveTrack &&
    options.profile.experience.length > 0 &&
    experiencesForTrack(options.profile.experience, effectiveTrack).length === 0
  ) {
    notes.push("资料库没有标注为当前招聘类型的经历，Quill 不会用相反类型的经历顶替。");
  }

  /*
   * Skills are mostly one-off questions, but a structured 获奖信息 section is a
   * repeatable row: 获奖类型 / 奖项名称 / 获奖时间 repeat once per award. Count
   * first so the *first* row is indexed too — otherwise row 1 would answer with
   * the whole awards list while row 2 answered with one award.
   */
  const keyCounts = new Map<string, number>();
  for (const field of scan.fields) {
    const key = field.key ?? "unknown";
    keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
  }

  // Repeat counting per section, so the 2nd 学校名称 reads the 2nd entry.
  const seenByKey = new Map<string, number>();
  for (const field of scan.fields) {
    const key = field.key ?? "unknown";
    const repeatKey =
      field.section === "experience"
        ? `${key}:${field.experienceKind ?? effectiveTrack ?? "all"}`
        : key;
    const seen = seenByKey.get(repeatKey) ?? 0;
    seenByKey.set(repeatKey, seen + 1);

    /*
     * Only repeatable sections get an index; elsewhere a duplicate is a
     * template artifact and should not shift later reads. A skill key earns an
     * index only when the page actually rendered it more than once.
     */
    const isRepeatableSection =
      field.section === "education" || field.section === "experience" || field.section === "project";
    const isRepeatedAward =
      field.section === "skill" && REPEATABLE_SKILL_KEYS.has(key) && (keyCounts.get(key) ?? 0) > 1;
    const indexed: FieldDescriptor =
      (isRepeatableSection && seen > 0) || isRepeatedAward
        ? { ...field, repeatIndex: seen + 1 }
        : field;

    decisions.push(decideForField(indexed, planOptions));
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
  const absence = decisions.filter((decision) => ABSENCE_KEYS.has(decision.key)).length;
  const handsOff = decisions.filter(
    (decision) => NEVER_AUTOFILL_KEYS.has(decision.key) && !ABSENCE_KEYS.has(decision.key),
  ).length;
  const actionable = decisions.filter((decision) => !NEVER_AUTOFILL_KEYS.has(decision.key));

  // Surface the strategy itself — the person should not have to guess why the
  // extension is confident about some fields and silent about others.
  const missingRequired = actionable.filter((decision) => decision.status === "missing" && decision.required);
  if (
    effectiveTrack === "internship" &&
    decisions.some((decision) => decision.key === "preference.availableFrom" && decision.status === "missing")
  ) {
    notes.push("这份实习申请询问到岗时间，但资料库没有可确认的答案；请在网页字段中自行填写。");
  }
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
  if (absence > 0) {
    notes.push(`${absence} 项「无实习 / 项目 / 获奖」声明需要你本人确认，Quill 不会代勾`);
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
