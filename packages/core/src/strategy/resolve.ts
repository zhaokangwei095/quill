/**
 * Resolving a canonical key against everything we know.
 *
 * Priority order, highest first:
 *   1. Site memory      — the person answered this exact question on this site.
 *   2. Confirmed memory — the person confirmed it in the workbench.
 *   3. Learned memory   — the person typed it by hand on some page.
 *   4. Profile          — parsed from the uploaded resume or edited by hand.
 *   5. Composed         — assembled from resume material for long-form answers.
 *   6. Default          — a sensible, disclosed choice (e.g. 无 for a checkbox).
 *
 * Nothing here writes to a page. It produces candidates with evidence; the
 * caller decides what to apply.
 */

import type {
  Decision,
  DecisionStatus,
  Evidence,
  FieldDescriptor,
  FieldValue,
  MemoryEntry,
  Profile,
} from "../types.js";
import { isEssayKey } from "../types.js";
import { DEFINITION_BY_KEY, NEVER_AUTOFILL_KEYS } from "../fields/taxonomy.js";
import { clampToLength, normalize, unique } from "../text.js";
import { composeAnswer, isComposableKey } from "./compose.js";
import { matchOption } from "./options.js";

export interface ResolveContext {
  profile: Profile;
  memory: MemoryEntry[];
  siteKey: string;
  /** Job title from the page, used for preference answers. */
  pageRole?: string;
  company?: string;
  /** Compose long-form answers when the profile lacks them. */
  composeEssays: boolean;
}

export interface Candidate {
  value: FieldValue;
  evidence: Evidence;
  confidence: number;
  /**
   * Source priority. Candidates are considered tier by tier: a lower number is
   * more authoritative, and only candidates within the winning tier can create
   * a `choice`. Without this, a learned memory (0.84) and a resume value (0.90)
   * would look like two equally plausible answers and the field would be
   * reported as needing a decision — even though memory is *defined* to win.
   */
  tier: number;
}

export const TIER = {
  siteMemory: 0,
  confirmedMemory: 1,
  learnedMemory: 2,
  profile: 3,
  composed: 4,
  fallback: 5,
} as const;

/* ------------------------------------------------------------ memory index */

/**
 * Memory is keyed two ways: by canonical key (survives site redesigns) and by
 * the literal label snapshot (survives taxonomy changes). We try both.
 */
export function indexMemory(memory: MemoryEntry[]): {
  byKey: Map<string, MemoryEntry[]>;
  byLabel: Map<string, MemoryEntry[]>;
} {
  const byKey = new Map<string, MemoryEntry[]>();
  const byLabel = new Map<string, MemoryEntry[]>();
  for (const entry of memory) {
    const keyList = byKey.get(entry.key) ?? [];
    keyList.push(entry);
    byKey.set(entry.key, keyList);

    const label = normalize(entry.labelSnapshot);
    if (label) {
      const labelList = byLabel.get(label) ?? [];
      labelList.push(entry);
      byLabel.set(label, labelList);
    }
  }

  // Most-trusted first: a value confirmed by hand beats one merely typed once.
  const rank = (entries: MemoryEntry[]) =>
    entries.sort((a, b) => {
      const originRank = (entry: MemoryEntry) =>
        entry.origin === "confirmed" ? 3 : entry.origin === "learned" ? 2 : 1;
      return originRank(b) - originRank(a) || b.hits - a.hits || b.updatedAt - a.updatedAt;
    });
  for (const entries of byKey.values()) rank(entries);
  for (const entries of byLabel.values()) rank(entries);
  return { byKey, byLabel };
}

/* ------------------------------------------------------------ profile read */

/**
 * Read a profile value for a canonical key. Repeatable sections accept a
 * zero-based index so the 2nd education row reads the 2nd entry.
 */
export function readProfile(
  profile: Profile,
  key: string,
  context: { pageRole?: string; company?: string; index?: number } = {},
): { value: FieldValue; quote?: string } | undefined {
  const index = context.index ?? 0;

  switch (key) {
    /* ------------------------------------------------------------ identity */
    case "identity.fullName":
      return text(profile.identity.fullName);
    case "identity.firstName":
      return text(splitName(profile.identity.fullName).given);
    case "identity.lastName":
      return text(splitName(profile.identity.fullName).family);
    case "identity.namePinyin":
      return text(profile.identity.namePinyin ?? profile.identity.fullName);
    case "identity.englishName":
      return text(profile.identity.englishName ?? profile.identity.fullName);
    case "identity.gender":
      return text(profile.identity.gender);
    case "identity.birthDate":
      return date(profile.identity.birthDate);
    case "identity.age":
      return text(ageFrom(profile.identity.birthDate));
    case "identity.birthPlace":
      return text(profile.identity.birthPlace);
    case "identity.nativePlace":
      return text(profile.identity.nativePlace);
    case "identity.ethnicity":
      return text(profile.identity.ethnicity);
    case "identity.nationality":
      return text(profile.identity.nationality ?? "中国");
    case "identity.politicalStatus":
      return text(profile.identity.politicalStatus);
    case "identity.maritalStatus":
      return text(profile.identity.maritalStatus);
    case "identity.idType":
      return text(profile.identity.idType ?? (profile.identity.idNumber ? "居民身份证" : undefined));
    case "identity.idNumber":
      return text(profile.identity.idNumber);
    case "identity.height":
      return text(profile.identity.height);
    case "identity.weight":
      return text(profile.identity.weight);
    case "identity.vision":
      return text(profile.identity.vision);
    case "identity.healthStatus":
      return text(profile.identity.healthStatus);
    case "identity.bloodType":
      return text(profile.identity.bloodType);
    case "identity.household":
      return text(profile.identity.household);
    case "identity.relativesInCompany":
      return text(profile.identity.relativesInCompany);

    /* ------------------------------------------------------------- contact */
    case "contact.phone":
      return text(profile.contact.phone);
    case "contact.landline":
      return text(profile.contact.alternatePhone);
    case "contact.email":
      return text(profile.contact.email);
    case "contact.wechat":
      return text(profile.contact.wechat);
    case "contact.qq":
      return text(profile.contact.qq);
    case "contact.currentCity":
      return text(profile.contact.currentCity);
    case "contact.address":
      return text(profile.contact.address);
    case "contact.postalCode":
      return text(profile.contact.postalCode);
    case "contact.homepage":
      return text(profile.contact.homepage);
    case "contact.github":
      return text(profile.contact.github);
    case "contact.linkedin":
      return text(profile.contact.linkedin);
    case "contact.emergencyName":
      return text(profile.contact.emergencyContactName);
    case "contact.emergencyPhone":
      return text(profile.contact.emergencyContactPhone);
    case "contact.emergencyRelation":
      return text(profile.contact.emergencyContactRelation);

    /* ----------------------------------------------------------- education */
    case "education.school":
      return text(entryAt(profile.education, index)?.school);
    case "education.highSchool":
      return text(profile.education.find((item) => item.degree === "高中")?.school);
    case "education.college":
      return text(entryAt(profile.education, index)?.college);
    case "education.major":
      return text(entryAt(profile.education, index)?.major);
    case "education.degree": {
      const education = entryAt(profile.education, index);
      // A form normally asks this once, so answer with the highest degree.
      if (index === 0 && profile.education.length > 1) {
        const highest = highestDegree(profile.education);
        if (highest) return text(highest);
      }
      return text(education?.degree);
    }
    case "education.academicDegree":
      return text(entryAt(profile.education, index)?.academicDegree);
    case "education.startDate":
      return date(entryAt(profile.education, index)?.dates?.start);
    case "education.endDate": {
      const education = entryAt(profile.education, index);
      if (education?.dates?.current) return { value: { text: "至今" } };
      return date(education?.dates?.end);
    }
    case "education.graduationStatus": {
      const education = entryAt(profile.education, index);
      const end = education?.dates?.end;
      const year = end ? Number.parseInt(end.slice(0, 4), 10) : Number.NaN;
      if (!Number.isFinite(year) && !education?.dates?.current) return undefined;
      const thisYear = new Date().getFullYear();
      const isFresh = education?.dates?.current === true || year >= thisYear;
      return {
        value: { text: isFresh ? "应届毕业生" : "往届毕业生", raw: isFresh ? "fresh" : "previous" },
      };
    }
    case "education.studyMode":
      return text(entryAt(profile.education, index)?.studyMode);
    case "education.gpa":
      return text(entryAt(profile.education, index)?.gpa);
    case "education.rank":
      return text(entryAt(profile.education, index)?.rank);
    case "education.duration":
      return text(entryAt(profile.education, index)?.duration);
    case "education.city":
      return text(entryAt(profile.education, index)?.city);
    case "education.courses":
      return text(entryAt(profile.education, index)?.courses);
    case "education.honors": {
      const honors = entryAt(profile.education, index)?.honors;
      return honors && honors.length > 0 ? list(honors) : undefined;
    }
    case "education.overseas": {
      const education = entryAt(profile.education, index);
      if (education?.overseas === undefined) return undefined;
      return { value: { text: education.overseas ? "是" : "否" } };
    }

    /* ---------------------------------------------------------- experience */
    case "work.company":
      return text(entryAt(profile.experience, index)?.company);
    case "work.department":
      return text(entryAt(profile.experience, index)?.department);
    case "work.title":
      return text(entryAt(profile.experience, index)?.title ?? context.pageRole);
    case "work.employmentType":
      return text(entryAt(profile.experience, index)?.employmentType);
    case "work.city":
      return text(entryAt(profile.experience, index)?.city);
    case "work.startDate":
      return date(entryAt(profile.experience, index)?.dates?.start);
    case "work.endDate": {
      const experience = entryAt(profile.experience, index);
      if (experience?.dates?.current) return { value: { text: "至今" } };
      return date(experience?.dates?.end);
    }
    case "work.description": {
      const experience = entryAt(profile.experience, index);
      if (!experience || experience.highlights.length === 0) return undefined;
      return list(experience.highlights);
    }
    case "work.salary":
      return text(entryAt(profile.experience, index)?.salary);
    case "work.leaveReason":
      return text(entryAt(profile.experience, index)?.leaveReason);
    case "work.teamSize":
      return text(entryAt(profile.experience, index)?.teamSize);
    case "work.reportsTo":
      return text(entryAt(profile.experience, index)?.reportsTo);
    case "work.refereeName":
      return text(entryAt(profile.experience, index)?.refereeName);
    case "work.refereePhone":
      return text(entryAt(profile.experience, index)?.refereePhone);
    case "work.refereeRelation":
      return text(entryAt(profile.experience, index)?.refereeRelation);

    /* ------------------------------------------------------------- project */
    case "project.name":
      return text(entryAt(profile.projects, index)?.name);
    case "project.role":
      return text(entryAt(profile.projects, index)?.role);
    case "project.description": {
      const project = entryAt(profile.projects, index);
      if (!project) return undefined;
      const body = project.summary ? [project.summary, ...project.highlights] : project.highlights;
      return body.length > 0 ? list(body) : undefined;
    }
    case "project.startDate":
      return date(entryAt(profile.projects, index)?.dates?.start);
    case "project.endDate": {
      const project = entryAt(profile.projects, index);
      if (project?.dates?.current) return { value: { text: "至今" } };
      return date(project?.dates?.end);
    }
    case "project.link":
      return text(entryAt(profile.projects, index)?.link);

    /* --------------------------------------------------------------- skill */
    case "skill.summary": {
      const items = profile.skills.items;
      return items.length > 0 ? { value: { text: items.join(", "), multiple: items } } : undefined;
    }
    case "skill.certificates":
      return profile.skills.certificates.length > 0 ? list(profile.skills.certificates) : undefined;
    case "skill.awards":
      return profile.skills.awards.length > 0 ? list(profile.skills.awards) : undefined;
    case "skill.interests":
      return profile.skills.interests.length > 0 ? list(profile.skills.interests) : undefined;
    case "skill.language": {
      const languages = unique([
        ...profile.education.flatMap((item) => item.languages ?? []),
        ...profile.skills.certificates.filter((item) => /(英语|日语|韩语|雅思|托福|CET|IELTS|TOEFL)/i.test(item)),
        ...profile.skills.items.filter((item) => /(英语|日语|CET|雅思|托福)/i.test(item)),
      ]);
      return languages.length > 0 ? list(languages) : undefined;
    }
    case "skill.computer": {
      const items = profile.skills.items.filter((item) => /(计算机|办公|office|excel|word|ppt)/i.test(item));
      return items.length > 0 ? list(items) : undefined;
    }

    /* ---------------------------------------------------------- preference */
    case "preference.position":
      return text(profile.preference.position ?? context.pageRole);
    case "preference.city":
      return profile.preference.cities.length > 0 ? list(profile.preference.cities) : undefined;
    case "preference.salary":
      return text(profile.preference.salary);
    case "preference.availableFrom":
      return text(profile.preference.availableFrom);
    case "preference.jobType":
      return text(profile.preference.jobType);
    case "preference.relocation":
      return text(profile.preference.relocation);
    case "preference.travel":
      return text(profile.preference.travel);
    case "preference.overtime":
      return text(profile.preference.overtime);
    case "preference.industry":
      return profile.preference.industries.length > 0 ? list(profile.preference.industries) : undefined;
    case "preference.source":
      return text(profile.preference.sourceChannel ?? "招聘官网");

    default:
      break;
  }

  if (key.startsWith("essay.")) {
    return readEssay(profile, key, context);
  }
  const stored = profile.essays.unclassified[key];
  return stored ? text(stored) : undefined;
}

function readEssay(
  profile: Profile,
  key: string,
  context: { pageRole?: string; company?: string },
): { value: FieldValue; quote?: string } | undefined {
  const direct: Record<string, string | undefined> = {
    "essay.selfIntro": profile.essays.selfIntro,
    "essay.whyCompany": profile.essays.whyCompany,
    "essay.whyRole": profile.essays.whyRole,
    "essay.strengths": profile.essays.strengths,
    "essay.weakness": profile.essays.weakness,
    "essay.careerPlan": profile.essays.careerPlan,
    "essay.achievement": profile.essays.achievement,
    "essay.hobby":
      profile.essays.hobby ??
      (profile.skills.interests.length > 0 ? profile.skills.interests.join("、") : undefined),
    "essay.additional": profile.essays.additional,
  };
  const value = direct[key];
  if (value) return { value: { text: value }, quote: value };

  if (isComposableKey(key)) {
    const composed = composeAnswer(key, profile, context);
    if (composed) return { value: { text: composed } };
  }
  return undefined;
}

/* ----------------------------------------------------------------- helpers */

function text(value: string | undefined): { value: FieldValue } | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = String(value).trim();
  return trimmed ? { value: { text: trimmed } } : undefined;
}

function list(values: string[]): { value: FieldValue } {
  return { value: { text: values.join("\n"), multiple: values } };
}

function date(value: string | undefined): { value: FieldValue } | undefined {
  if (!value) return undefined;
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
  return { value: { text: value, iso } };
}

export function entryAt<T>(entries: T[], index: number): T | undefined {
  if (entries.length === 0) return undefined;
  return entries[Math.min(index, entries.length - 1)];
}

function splitName(fullName: string | undefined): { family?: string; given?: string } {
  if (!fullName) return {};
  const trimmed = fullName.trim();
  if (/[\u4E00-\u9FFF]/.test(trimmed)) {
    return { family: trimmed.slice(0, 1), given: trimmed.slice(1) };
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return { family: parts[0], given: parts[0] };
  return { family: parts[parts.length - 1], given: parts.slice(0, -1).join(" ") };
}

export function ageFrom(birthDate: string | undefined): string | undefined {
  if (!birthDate) return undefined;
  const year = Number.parseInt(birthDate.slice(0, 4), 10);
  if (!Number.isFinite(year)) return undefined;
  const month = Number.parseInt(birthDate.slice(5, 7) || "0", 10) || 0;
  const now = new Date();
  let age = now.getFullYear() - year;
  if (month > 0 && now.getMonth() + 1 < month) age -= 1;
  return age > 0 && age < 100 ? String(age) : undefined;
}

const DEGREE_ORDER = ["博士", "硕士", "MBA", "本科", "学士", "大专", "专科", "中专", "高中"];

/**
 * Highest qualification, normalised to the *level* wording Chinese forms use.
 * A resume says 学士学位; the dropdown says 本科.
 */
export function highestDegree(education: Array<{ degree?: string }>): string | undefined {
  let bestRank = Number.POSITIVE_INFINITY;
  for (const item of education) {
    if (!item.degree) continue;
    const rank = DEGREE_ORDER.findIndex((level) => item.degree?.includes(level));
    if (rank >= 0 && rank < bestRank) bestRank = rank;
  }
  if (!Number.isFinite(bestRank)) return undefined;
  const level = DEGREE_ORDER[bestRank];
  if (level === "博士") return "博士研究生";
  if (level === "硕士") return "硕士研究生";
  if (level === "本科" || level === "学士") return "本科";
  return level;
}

/* ------------------------------------------------------------- main entry */

/** Build the ordered candidate list for one field. */
export function resolveField(field: FieldDescriptor, context: ResolveContext): Candidate[] {
  const key = field.key;
  if (!key || key === "unknown") return [];
  if (NEVER_AUTOFILL_KEYS.has(key)) return [];

  const candidates: Candidate[] = [];
  const { byKey, byLabel } = indexMemory(context.memory);

  // 1. Site memory — the same question, on this site.
  const siteEntries = (byKey.get(key) ?? []).filter((entry) => entry.siteKey === context.siteKey);
  const topSite = siteEntries[0];
  if (topSite) {
    candidates.push({
      value: coerceMemoryValue(topSite, field),
      evidence: { source: "site-memory", detail: `沿用你在 ${context.siteKey} 此前的填写` },
      confidence: 0.96,
      tier: TIER.siteMemory,
    });
  }

  // 2 & 3. Confirmed then learned memory, matched by canonical key.
  for (const entry of byKey.get(key) ?? []) {
    if (entry === topSite) continue;
    candidates.push({
      value: coerceMemoryValue(entry, field),
      evidence: {
        source: "memory",
        detail: entry.origin === "confirmed" ? "来自你已确认的记忆" : `来自你第 ${entry.hits} 次填写的记录`,
      },
      confidence: entry.origin === "confirmed" ? 0.93 : 0.84,
      tier: entry.origin === "confirmed" ? TIER.confirmedMemory : TIER.learnedMemory,
    });
  }

  // Label-based memory catches keys the taxonomy did not anticipate.
  if (candidates.length === 0 && field.label) {
    const top = (byLabel.get(normalize(field.label)) ?? [])[0];
    if (top) {
      candidates.push({
        value: coerceMemoryValue(top, field),
        evidence: { source: "memory", detail: `按字段名「${top.labelSnapshot}」匹配到的记忆` },
        confidence: 0.72,
        // Label-only matches are less authoritative than a confirmed key.
        tier: TIER.learnedMemory + 1,
      });
    }
  }

  // 4. Profile.
  const index = field.repeatIndex ? field.repeatIndex - 1 : 0;
  const fromProfile = readProfile(context.profile, key, {
    pageRole: context.pageRole,
    company: context.company,
    index,
  });
  if (fromProfile) {
    // An essay value with no verbatim quote was composed, not copied.
    const composed = key.startsWith("essay.") && fromProfile.quote === undefined;
    candidates.push({
      value: fromProfile.value,
      evidence: {
        source: composed ? "composed" : "profile",
        detail: composed ? "由简历内容整理生成" : "来自简历 / 工作台资料",
        ...(fromProfile.quote ? { quote: fromProfile.quote } : {}),
      },
      confidence: composed ? 0.66 : 0.9,
      tier: composed ? TIER.composed : TIER.profile,
    });
  }

  // 5. Compose long-form answers when nothing explicit exists.
  if (candidates.length === 0 && isComposableKey(key) && context.composeEssays) {
    const composed = composeAnswer(key, context.profile, {
      pageRole: context.pageRole,
      company: context.company,
    });
    if (composed) {
      candidates.push({
        value: { text: composed },
        evidence: { source: "composed", detail: "由简历中的经历与技能整理生成" },
        confidence: 0.58,
        tier: TIER.composed,
      });
    }
  }

  // 6. Disclosed defaults for boolean-ish questions.
  if (candidates.length === 0) {
    const fallback = defaultFor(key);
    if (fallback) {
      candidates.push({
        value: { text: fallback },
        evidence: { source: "default", detail: "常见填法，请确认" },
        confidence: 0.4,
        tier: TIER.fallback,
      });
    }
  }

  return candidates
    .map((candidate) => adaptToOptions(candidate, field))
    .filter((candidate): candidate is Candidate => candidate !== undefined);
}

function coerceMemoryValue(entry: MemoryEntry, field: FieldDescriptor): FieldValue {
  const value: FieldValue = { text: entry.value };
  if (field.kind === "date") {
    const iso = toIso(entry.value);
    if (iso) value.iso = iso;
  }
  if (field.kind === "checkbox-group" || field.kind === "select" || field.kind === "combobox") {
    if (/[、,，;；]/.test(entry.value)) {
      value.multiple = entry.value
        .split(/[、,，;；]/)
        .map((part) => part.trim())
        .filter(Boolean);
    }
  }
  return value;
}

/** Accept "2024年9月" and "2024.09" from memory and normalise to ISO. */
export function toIso(value: string): string | undefined {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const match = trimmed.match(/^(\d{4})\s*[年/\-.]\s*(\d{1,2})(?:\s*[月/\-.]\s*(\d{1,2}))?/);
  if (!match) return undefined;
  const [, year, month, day] = match;
  const mm = String(Number.parseInt(month ?? "1", 10)).padStart(2, "0");
  const dd = String(Number.parseInt(day ?? "1", 10)).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

/**
 * Fit a value to a closed option list. Returns `undefined` when nothing
 * reasonable matches — leaving a field blank beats picking wrong.
 */
function adaptToOptions(candidate: Candidate, field: FieldDescriptor): Candidate | undefined {
  if (!field.options || field.options.length === 0) return candidate;
  const match = matchOption(candidate.value, field.options);
  if (!match) return undefined;
  return {
    ...candidate,
    value: { ...candidate.value, text: match.label, raw: match.value },
    confidence: candidate.confidence * match.confidence,
  };
}

/**
 * Answers that are safe to *propose* when nothing else exists. These are never
 * applied silently — they arrive as `review` status.
 */
function defaultFor(key: string): string | undefined {
  switch (key) {
    case "identity.nationality":
      return "中国";
    case "identity.idType":
      return "居民身份证";
    case "preference.relocation":
      return "是";
    case "preference.travel":
      return "是";
    case "preference.overtime":
      return "是";
    case "identity.relativesInCompany":
      return "无";
    default:
      return undefined;
  }
}

/* ---------------------------------------------------------------- assembly */

export interface DecideOptions extends ResolveContext {
  /** Apply only decisions at or above this confidence. */
  autoApplyThreshold?: number;
  preserveExisting?: boolean;
  /** Current page values, keyed by field ref. */
  existingValues?: Map<string, string>;
}

/**
 * Turn candidates into a reviewable decision.
 *
 *  - `ready`   one strong candidate, safe to apply
 *  - `review`  one candidate we are not certain about
 *  - `choice`  several plausible candidates with different values
 *  - `missing` nothing at all
 */
export function decideForField(field: FieldDescriptor, options: DecideOptions): Decision {
  const definition = field.key ? DEFINITION_BY_KEY.get(field.key) : undefined;
  const candidates = resolveField(field, options);

  const base = {
    ref: field.ref,
    key: field.key ?? "unknown",
    label: field.label || field.placeholder || field.name || field.key || "未命名字段",
    kind: field.kind,
    required: field.required,
  };

  // Never touch content the person already has, unless told otherwise.
  const existing = options.existingValues?.get(field.ref);
  if (existing && existing.trim() && options.preserveExisting !== false) {
    return {
      ...base,
      status: "ready",
      value: { text: existing },
      confidence: 1,
      evidence: { source: "none", detail: "页面已有内容，保持不变" },
      rationale: "检测到已填写内容，保持不变",
    };
  }

  if (candidates.length === 0) {
    return {
      ...base,
      status: "missing",
      confidence: 0,
      evidence: { source: "none", detail: "简历与记忆中均无对应信息" },
      rationale: isEssayKey(field.key ?? "")
        ? "需要结合岗位补充一段文字，暂无可用素材"
        : "资料库中没有可用的值",
    };
  }

  /*
   * Only the most authoritative tier can produce a `choice`. A learned memory
   * and a resume value for the same key are not two answers to choose between —
   * memory is defined to win. A choice appears only when candidates *within*
   * the winning tier genuinely disagree, e.g. two confirmed memory values.
   */
  const winningTier = Math.min(...candidates.map((candidate) => candidate.tier));
  const distinct = distinctByValue(candidates.filter((candidate) => candidate.tier === winningTier));
  const best = distinct[0] as Candidate;

  if (distinct.length > 1) {
    return {
      ...base,
      status: "choice",
      candidates: distinct.slice(0, 4).map((candidate) => ({
        value: candidate.value,
        evidence: candidate.evidence,
      })),
      confidence: best.confidence,
      evidence: best.evidence,
      rationale: `有 ${distinct.length} 个可能的取值，需要你确认`,
    };
  }

  const threshold = options.autoApplyThreshold ?? 0.85;
  const status: DecisionStatus = best.confidence >= threshold ? "ready" : "review";

  let caution: string | undefined;
  if (best.evidence.source === "composed") caution = "由简历内容整理，建议通读后提交";
  else if (best.evidence.source === "default") caution = "常见默认值，请确认后使用";

  const value =
    field.maxLength && best.value.text.length > field.maxLength
      ? { ...best.value, text: clampToLength(best.value.text, field.maxLength) }
      : best.value;

  if (field.maxLength && best.value.text.length > field.maxLength) {
    caution = caution ?? `内容超出 ${field.maxLength} 字限制，将自动截断`;
  }

  return {
    ...base,
    status,
    value,
    confidence: best.confidence,
    evidence: best.evidence,
    rationale: rationaleFor(best, definition?.label),
    ...(caution ? { caution } : {}),
  };
}

function rationaleFor(candidate: Candidate, definitionLabel?: string): string {
  switch (candidate.evidence.source) {
    case "site-memory":
      return "沿用你在此网站此前的填写";
    case "memory":
      return "沿用你之前的填写记录";
    case "profile":
      return `匹配简历中的${definitionLabel ?? "资料"}`;
    case "composed":
      return "由简历经历整理成一段回答";
    case "default":
      return "没有对应资料，填入常见选项";
    default:
      return "匹配到的资料";
  }
}

function distinctByValue(candidates: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const candidate of candidates) {
    const key = `${normalize(candidate.value.text)}|${candidate.value.raw ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}
