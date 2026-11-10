/**
 * Re-parsing an already stored resume.
 *
 * Re-parsing is destructive by nature: the stored profile also contains
 * corrections the person typed by hand, and the parser has no way to know which
 * values those were. The old flow asked with a single `window.confirm`, which
 * told the person nothing about what they were about to lose.
 *
 * This module produces a reviewable diff first, then offers two explicit
 * outcomes:
 *
 *  - `merge`   keep every existing value, fill blanks from the new parse;
 *  - `replace` use the new parse wholesale, after the diff was shown.
 *
 * The store keeps a one-deep backup either way, so "撤销" is possible even if
 * the person chose replace.
 */

import { formatRange } from "../text.js";
import type {
  Contact,
  Education,
  Essays,
  Experience,
  Identity,
  JobPreference,
  Profile,
  Project,
  Skill,
} from "../types.js";
import { cloneProfile } from "../profile.js";

export type ProfileChangeKind = "added" | "changed" | "removed";

export interface ProfileChange {
  /** Stable-ish location such as `education[1].school`. */
  path: string;
  /** Human label shown in the confirmation panel. */
  label: string;
  kind: ProfileChangeKind;
  previous?: string;
  next?: string;
  /** Mask the values before displaying them. */
  sensitive?: boolean;
}

export interface ReparsePreview {
  changes: ProfileChange[];
  added: number;
  changed: number;
  removed: number;
  total: number;
  /** Existing values the replace option would overwrite. */
  overwrites: number;
  /** Existing values the replace option would drop (the parser found nothing). */
  losses: number;
  /** Warnings produced by the new parse, shown before the person applies it. */
  parseWarnings: string[];
  sourceChars: number;
  identical: boolean;
}

/* ------------------------------------------------------------- descriptors */

function blank(value: string | undefined): boolean {
  return !value || value.trim().length === 0;
}

function textOf(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "boolean") return value ? "是" : "否";
  return String(value).trim();
}

interface ScalarField {
  path: string;
  label: string;
  sensitive?: boolean;
  read: (profile: Profile) => string | undefined;
  write: (profile: Profile, value: string | undefined) => void;
}

const IDENTITY_FIELDS: Array<[keyof Identity, string, boolean?]> = [
  ["fullName", "姓名"],
  ["englishName", "英文名"],
  ["namePinyin", "姓名拼音"],
  ["formerName", "曾用名"],
  ["gender", "性别"],
  ["birthDate", "出生日期"],
  ["ethnicity", "民族"],
  ["politicalStatus", "政治面貌"],
  ["nativePlace", "籍贯"],
  ["birthPlace", "出生地"],
  ["household", "户口所在地"],
  ["maritalStatus", "婚姻状况"],
  ["nationality", "国籍"],
  ["idType", "证件类型"],
  ["idNumber", "身份证号", true],
  ["height", "身高"],
  ["weight", "体重"],
  ["vision", "视力"],
  ["bloodType", "血型"],
  ["healthStatus", "健康状况"],
  ["relativesInCompany", "亲属在本单位任职"],
];

const CONTACT_FIELDS: Array<[keyof Contact, string, boolean?]> = [
  ["phone", "手机号码", true],
  ["alternatePhone", "备用电话", true],
  ["email", "电子邮箱", true],
  ["wechat", "微信"],
  ["qq", "QQ"],
  ["currentCity", "现居住地"],
  ["address", "通讯地址", true],
  ["postalCode", "邮政编码"],
  ["homepage", "个人主页"],
  ["github", "GitHub"],
  ["linkedin", "LinkedIn"],
  ["emergencyContactName", "紧急联系人"],
  ["emergencyContactPhone", "紧急联系人电话", true],
  ["emergencyContactRelation", "与紧急联系人关系"],
];

const PREFERENCE_FIELDS: Array<[keyof JobPreference, string]> = [
  ["position", "意向岗位"],
  ["salary", "期望薪资"],
  ["availableFrom", "到岗时间"],
  ["jobType", "求职类型"],
  ["targetTrack", "投递类型"],
  ["relocation", "接受调剂"],
  ["travel", "接受出差"],
  ["overtime", "接受加班"],
  ["sourceChannel", "投递渠道"],
];

function identityField([key, label, sensitive]: [keyof Identity, string, boolean?]): ScalarField {
  return {
    path: `identity.${String(key)}`,
    label,
    ...(sensitive ? { sensitive: true } : {}),
    read: (profile) => profile.identity[key],
    write: (profile, value) => {
      profile.identity[key] = value;
    },
  };
}

function contactField([key, label, sensitive]: [keyof Contact, string, boolean?]): ScalarField {
  return {
    path: `contact.${String(key)}`,
    label,
    ...(sensitive ? { sensitive: true } : {}),
    read: (profile) => profile.contact[key],
    write: (profile, value) => {
      profile.contact[key] = value;
    },
  };
}

function preferenceField([key, label]: [keyof JobPreference, string]): ScalarField {
  return {
    path: `preference.${String(key)}`,
    label,
    read: (profile) => textOf(profile.preference[key]),
    write: (profile, value) => {
      (profile.preference as unknown as Record<string, unknown>)[key] = value;
    },
  };
}

const SCALAR_FIELDS: ScalarField[] = [
  ...IDENTITY_FIELDS.map(identityField),
  ...CONTACT_FIELDS.map(contactField),
  ...PREFERENCE_FIELDS.map(preferenceField),
];

const ESSAY_FIELDS: Array<[Exclude<keyof Essays, "unclassified">, string]> = [
  ["selfIntro", "自我介绍 / 自我评价"],
  ["whyCompany", "为什么选择这家公司"],
  ["whyRole", "为什么选择这个岗位"],
  ["strengths", "个人优势"],
  ["weakness", "个人短板"],
  ["careerPlan", "职业规划"],
  ["achievement", "最有成就感的事"],
  ["hobby", "兴趣爱好"],
  ["additional", "补充信息"],
];

/* ------------------------------------------------------------------- diff */

function makeChange(
  path: string,
  label: string,
  previous: string | undefined,
  next: string | undefined,
  sensitive = false,
): ProfileChange | undefined {
  const before = (previous ?? "").trim();
  const after = (next ?? "").trim();
  if (before === after) return undefined;
  const kind: ProfileChangeKind = before.length === 0 ? "added" : after.length === 0 ? "removed" : "changed";
  return {
    path,
    label,
    kind,
    ...(before ? { previous: before } : {}),
    ...(after ? { next: after } : {}),
    ...(sensitive ? { sensitive: true } : {}),
  };
}

const EDUCATION_FIELDS: Array<[string, string]> = [
  ["school", "学校"],
  ["college", "院系"],
  ["major", "专业"],
  ["degree", "学历"],
  ["academicDegree", "学位"],
  ["studyMode", "学习形式"],
  ["gpa", "GPA"],
  ["gpaBase", "满绩"],
  ["rank", "专业排名"],
  ["city", "城市"],
  ["courses", "主修课程"],
];

const EXPERIENCE_FIELDS: Array<[string, string]> = [
  ["company", "公司 / 单位"],
  ["department", "部门"],
  ["title", "职位"],
  ["employmentType", "工作性质"],
  ["city", "工作地点"],
  ["salary", "薪资"],
  ["reportsTo", "汇报对象"],
  ["teamSize", "团队规模"],
  ["leaveReason", "离职原因"],
  ["refereeName", "证明人"],
  ["refereeTitle", "证明人职务"],
  ["refereePhone", "证明人电话"],
  ["refereeRelation", "与证明人关系"],
];

const PROJECT_FIELDS: Array<[string, string]> = [
  ["name", "项目名称"],
  ["role", "角色"],
  ["summary", "项目描述"],
  ["link", "项目链接"],
];

function scalarEntityChanges<T extends object>(
  basePath: string,
  baseLabel: string,
  before: T[],
  after: T[],
  fields: Array<[string, string]>,
  arrayFields: Array<[string, string]> = [],
  labelOf: (entity: T) => string,
): ProfileChange[] {
  const changes: ProfileChange[] = [];
  const count = Math.max(before.length, after.length);

  for (let index = 0; index < count; index += 1) {
    const previous = before[index];
    const next = after[index];
    const where = `${baseLabel} ${index + 1}`;
    const path = `${basePath}[${index}]`;

    if (!previous && next) {
      const summary = labelOf(next);
      const change = makeChange(path, where, undefined, summary || "新增记录");
      if (change) changes.push(change);
      continue;
    }
    if (previous && !next) {
      const summary = labelOf(previous);
      const change = makeChange(path, where, summary || "已有记录", undefined);
      if (change) changes.push(change);
      continue;
    }
    if (!previous || !next) continue;

    const beforeRecord = previous as Record<string, unknown>;
    const afterRecord = next as Record<string, unknown>;

    for (const [key, label] of fields) {
      const change = makeChange(`${path}.${key}`, `${where} · ${label}`, textOf(beforeRecord[key]), textOf(afterRecord[key]));
      if (change) changes.push(change);
    }
    for (const [key, label] of arrayFields) {
      const beforeValue = Array.isArray(beforeRecord[key]) ? (beforeRecord[key] as string[]).join("、") : "";
      const afterValue = Array.isArray(afterRecord[key]) ? (afterRecord[key] as string[]).join("、") : "";
      const change = makeChange(`${path}.${key}`, `${where} · ${label}`, beforeValue, afterValue);
      if (change) changes.push(change);
    }

    const beforeDates = (previous as { dates?: { start?: string; end?: string; current?: boolean } }).dates;
    const afterDates = (next as { dates?: { start?: string; end?: string; current?: boolean } }).dates;
    const change = makeChange(`${path}.dates`, `${where} · 起止时间`, formatRange(beforeDates), formatRange(afterDates));
    if (change) changes.push(change);
  }

  return changes;
}

function educationLabel(education: Education): string {
  return [education.school, education.major, education.degree].filter(Boolean).join(" · ");
}

function experienceLabel(experience: Experience): string {
  return [experience.company, experience.title].filter(Boolean).join(" · ");
}

function projectLabel(project: Project): string {
  return [project.name, project.role].filter(Boolean).join(" · ");
}

/** Every value that differs between the stored and the freshly parsed profile. */
export function diffProfiles(before: Profile, after: Profile): ProfileChange[] {
  const changes: ProfileChange[] = [];

  for (const field of SCALAR_FIELDS) {
    const change = makeChange(
      field.path,
      field.label,
      field.read(before),
      field.read(after),
      field.sensitive === true,
    );
    if (change) changes.push(change);
  }

  for (const [key, label] of [
    ["items", "专业技能"],
    ["certificates", "证书"],
    ["awards", "奖项荣誉"],
    ["interests", "兴趣爱好"],
  ] as Array<[keyof Skill, string]>) {
    const change = makeChange(
      `skills.${String(key)}`,
      label,
      before.skills[key].join("、"),
      after.skills[key].join("、"),
    );
    if (change) changes.push(change);
  }

  for (const [key, label] of [
    ["cities", "意向城市"],
    ["industries", "期望行业"],
  ] as Array<[keyof JobPreference, string]>) {
    const beforeValue = Array.isArray(before.preference[key]) ? (before.preference[key] as string[]).join("、") : "";
    const afterValue = Array.isArray(after.preference[key]) ? (after.preference[key] as string[]).join("、") : "";
    const change = makeChange(`preference.${String(key)}`, label, beforeValue, afterValue);
    if (change) changes.push(change);
  }

  for (const [key, label] of ESSAY_FIELDS) {
    const change = makeChange(`essays.${String(key)}`, label, before.essays[key], after.essays[key]);
    if (change) changes.push(change);
  }

  changes.push(
    ...scalarEntityChanges("education", "教育经历", before.education, after.education, EDUCATION_FIELDS, [["honors", "荣誉"]], educationLabel),
  );
  changes.push(
    ...scalarEntityChanges(
      "experience",
      "工作经历",
      before.experience,
      after.experience,
      EXPERIENCE_FIELDS,
      [["highlights", "工作内容"], ["stack", "技术栈"]],
      experienceLabel,
    ),
  );
  changes.push(
    ...scalarEntityChanges(
      "project",
      "项目经历",
      before.projects,
      after.projects,
      PROJECT_FIELDS,
      [["highlights", "项目内容"], ["stack", "技术栈"]],
      projectLabel,
    ),
  );

  /*
   * Removed values first: those are the ones the person can lose by choosing
   * “覆盖”. Within the same kind, scalar facts before long prose.
   */
  const order: Record<ProfileChangeKind, number> = { removed: 0, changed: 1, added: 2 };
  return changes.sort((a, b) => order[a.kind] - order[b.kind]);
}

export function previewReparse(before: Profile, after: Profile, sourceChars: number): ReparsePreview {
  const changes = diffProfiles(before, after);
  const parseWarnings = [...(after.parseWarnings ?? [])];
  const warningsChanged =
    JSON.stringify(before.parseWarnings ?? []) !== JSON.stringify(parseWarnings);
  const added = changes.filter((change) => change.kind === "added").length;
  const changed = changes.filter((change) => change.kind === "changed").length;
  const removed = changes.filter((change) => change.kind === "removed").length;
  return {
    changes,
    added,
    changed,
    removed,
    total: changes.length,
    overwrites: changed,
    losses: removed,
    parseWarnings,
    sourceChars,
    identical: changes.length === 0 && !warningsChanged,
  };
}

/* ------------------------------------------------------------------ merge */

function unionValues(current: string[], incoming: string[]): string[] {
  const seen = new Set(current.map((item) => item.trim()).filter(Boolean));
  const out = [...current];
  for (const item of incoming) {
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

interface MergeableEntity {
  id: string;
  dates?: { start?: string; end?: string; current?: boolean };
}

function mergeEntityList<T extends MergeableEntity>(
  before: T[],
  after: T[],
  scalarKeys: string[],
  arrayKeys: string[],
): T[] {
  const out = before.map((entry) => JSON.parse(JSON.stringify(entry)) as T);
  const usedIds = new Set(out.map((entry) => entry.id));

  after.forEach((incoming, index) => {
    const target = out[index];
    if (!target) {
      const copy = JSON.parse(JSON.stringify(incoming)) as T;
      if (usedIds.has(copy.id)) copy.id = `${copy.id}-${index + 1}`;
      usedIds.add(copy.id);
      out.push(copy);
      return;
    }

    const targetRecord = target as unknown as Record<string, unknown>;
    const incomingRecord = incoming as unknown as Record<string, unknown>;

    for (const key of scalarKeys) {
      if (blank(textOf(targetRecord[key])) && !blank(textOf(incomingRecord[key]))) {
        targetRecord[key] = incomingRecord[key];
      }
    }
    for (const key of arrayKeys) {
      const currentValue = Array.isArray(targetRecord[key]) ? (targetRecord[key] as string[]) : [];
      const incomingValue = Array.isArray(incomingRecord[key]) ? (incomingRecord[key] as string[]) : [];
      if (currentValue.length === 0 && incomingValue.length > 0) {
        targetRecord[key] = [...incomingValue];
      }
    }

    if (!target.dates && incoming.dates) {
      target.dates = { ...incoming.dates };
    } else if (target.dates && incoming.dates) {
      if (!target.dates.start && incoming.dates.start) target.dates.start = incoming.dates.start;
      if (!target.dates.end && incoming.dates.end) target.dates.end = incoming.dates.end;
      if (target.dates.current === undefined && incoming.dates.current !== undefined) {
        target.dates.current = incoming.dates.current;
      }
    }
  });

  return out;
}

/**
 * Fill blanks from the new parse without changing anything that already has a
 * value. This is the recommended option: a parser upgrade usually adds detail,
 * and losing a hand-corrected phone number or school name is never worth it.
 */
export function mergeReparsedProfile(before: Profile, after: Profile): Profile {
  const out = cloneProfile(before);

  for (const field of SCALAR_FIELDS) {
    if (blank(field.read(out)) && !blank(field.read(after))) {
      field.write(out, field.read(after));
    }
  }

  out.skills.items = unionValues(out.skills.items, after.skills.items);
  out.skills.certificates = unionValues(out.skills.certificates, after.skills.certificates);
  out.skills.awards = unionValues(out.skills.awards, after.skills.awards);
  out.skills.interests = unionValues(out.skills.interests, after.skills.interests);
  out.preference.cities = unionValues(out.preference.cities, after.preference.cities);
  out.preference.industries = unionValues(out.preference.industries, after.preference.industries);

  out.education = mergeEntityList(out.education, after.education, EDUCATION_FIELDS.map(([key]) => key), ["honors"]);
  out.experience = mergeEntityList(out.experience, after.experience, EXPERIENCE_FIELDS.map(([key]) => key), [
    "highlights",
    "stack",
  ]);
  out.projects = mergeEntityList(out.projects, after.projects, PROJECT_FIELDS.map(([key]) => key), [
    "highlights",
    "stack",
  ]);

  const essays: Essays = {
    ...after.essays,
    ...out.essays,
    unclassified: { ...after.essays.unclassified, ...out.essays.unclassified },
  };
  for (const [key] of ESSAY_FIELDS) {
    if (blank(textOf(essays[key])) && !blank(textOf(after.essays[key]))) {
      (essays as unknown as Record<string, unknown>)[key] = after.essays[key];
    }
  }
  out.essays = essays;

  if (!out.rawText) out.rawText = after.rawText;
  out.parseWarnings = after.parseWarnings;
  out.updatedAt = Date.now();
  return out;
}

export type ReparseMode = "merge" | "replace";

export function applyReparse(before: Profile, after: Profile, mode: ReparseMode): Profile {
  if (mode === "replace") {
    const next = cloneProfile(after, before.id);
    next.updatedAt = Date.now();
    return next;
  }
  return mergeReparsedProfile(before, after);
}
