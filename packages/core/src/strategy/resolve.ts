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

import {
  PROJECT_CATEGORY_LABELS,
  isEssayKey,
  type DateRange,
  type Decision,
  type DecisionStatus,
  type Education,
  type Evidence,
  type FieldDescriptor,
  type ExperienceKind,
  type FieldValue,
  type HiringTrack,
  type MemoryEntry,
  type Profile,
} from "../types.js";
import { DEFINITION_BY_KEY, NEVER_AUTOFILL_KEYS } from "../fields/taxonomy.js";
import { clampToLength, normalize, unique } from "../text.js";
import { composeAnswer, isComposableKey } from "./compose.js";
import { matchOption, matchOptions } from "./options.js";
import { effectiveHiringTrack, experienceKindOf, experiencesForTrack } from "./experience.js";

export interface ResolveContext {
  profile: Profile;
  memory: MemoryEntry[];
  siteKey: string;
  /** Job title from the page, used for preference answers. */
  pageRole?: string;
  company?: string;
  /** Page recruitment category, used to keep internship and employment records distinct. */
  hiringTrack?: HiringTrack;
  /** Compose long-form answers when the profile lacks them. */
  composeEssays: boolean;
  /**
   * The page asks for GPA and its scale in two separate fields.
   *
   * When true, `education.gpa` returns only the numerator ("3.7") because the
   * denominator has its own `education.gpaBase` field. When false, a single GPA
   * field keeps the whole "3.7/4.0" string, which is what people expect to see.
   */
  hasGpaBase?: boolean;
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
  context: {
    pageRole?: string;
    company?: string;
    hiringTrack?: HiringTrack;
    experienceKind?: ExperienceKind;
    index?: number;
    hasGpaBase?: boolean;
    /** Present when the page rendered this question more than once. */
    repeatIndex?: number;
  } = {},
): { value: FieldValue; quote?: string } | undefined {
  const index = context.index ?? 0;
  const hiringTrack = effectiveHiringTrack(context.hiringTrack, profile.preference.targetTrack);
  const experienceEntries = experiencesForTrack(profile.experience, hiringTrack, context.experienceKind);

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
      return text(educationAt(profile.education, index)?.school);
    case "education.highSchool":
      return text(profile.education.find((item) => item.degree === "高中")?.school);
    case "education.college":
      return text(educationAt(profile.education, index)?.college);
    case "education.major":
      return text(educationAt(profile.education, index)?.major);
    case "education.degree":
      /*
       * Education is ordered by qualification, highest first, before any key
       * reads it. A one-row "current education" block therefore receives the
       * master's record, not whichever record happened to be first in the
       * résumé, and the degree can never disagree with the school beside it.
       */
      return text(educationAt(profile.education, index)?.degree);
    case "education.academicDegree":
      return text(educationAt(profile.education, index)?.academicDegree);
    case "education.startDate":
      return date(educationAt(profile.education, index)?.dates?.start);
    case "education.endDate": {
      const education = educationAt(profile.education, index);
      if (education?.dates?.current) return { value: { text: "至今" } };
      return date(education?.dates?.end);
    }
    case "education.current": {
      const education = educationAt(profile.education, index);
      return education?.dates ? { value: { text: education.dates.current ? "是" : "否" } } : undefined;
    }
    case "education.graduationStatus": {
      const education = educationAt(profile.education, index);
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
      return text(educationAt(profile.education, index)?.studyMode);
    case "education.gpa": {
      const education = educationAt(profile.education, index);
      /*
       * "4.0/5.0" is one fact, but Tencent asks for it in two boxes. Only split
       * it when this page actually has a separate scale field; a lone GPA
       * question should receive the whole string.
       */
      const gpa = education?.gpa;
      return text(context.hasGpaBase ? splitGpa(gpa).value : gpa);
    }
    case "education.gpaBase": {
      const education = educationAt(profile.education, index);
      return text(education?.gpaBase ?? splitGpa(education?.gpa).base);
    }
    case "education.rank":
      return text(educationAt(profile.education, index)?.rank);
    case "education.duration":
      return text(educationAt(profile.education, index)?.duration);
    case "education.city":
      return text(educationAt(profile.education, index)?.city);
    case "education.courses":
      return text(educationAt(profile.education, index)?.courses);
    case "education.honors": {
      const honors = educationAt(profile.education, index)?.honors;
      return honors && honors.length > 0 ? list(honors) : undefined;
    }
    case "education.overseas": {
      const education = educationAt(profile.education, index);
      if (education?.overseas === undefined) return undefined;
      return { value: { text: education.overseas ? "是" : "否" } };
    }

    /* ---------------------------------------------------------- experience */
    case "work.company":
      return text(entryAt(experienceEntries, index)?.company);
    case "work.department":
      return text(entryAt(experienceEntries, index)?.department);
    case "work.title": {
      const experience = entryAt(experienceEntries, index);
      // The page's role is a sensible answer for the applicant's first row, but
      // not for a third row that has no profile record behind it.
      return text(
        experience?.title ??
          (index === 0 && !hiringTrack && !context.experienceKind ? context.pageRole : undefined),
      );
    }
    case "work.employmentType":
      return text(entryAt(experienceEntries, index)?.employmentType);
    case "work.city":
      return text(entryAt(experienceEntries, index)?.city);
    case "work.startDate":
      return date(entryAt(experienceEntries, index)?.dates?.start);
    case "work.endDate": {
      const experience = entryAt(experienceEntries, index);
      if (experience?.dates?.current) return { value: { text: "至今" } };
      return date(experience?.dates?.end);
    }
    case "work.current": {
      const experience = entryAt(experienceEntries, index);
      return experience?.dates ? { value: { text: experience.dates.current ? "是" : "否" } } : undefined;
    }
    case "work.description": {
      const experience = entryAt(experienceEntries, index);
      if (!experience || experience.highlights.length === 0) return undefined;
      return list(experience.highlights);
    }
    case "work.salary":
      return text(entryAt(experienceEntries, index)?.salary);
    case "work.leaveReason":
      return text(entryAt(experienceEntries, index)?.leaveReason);
    case "work.teamSize":
      return text(entryAt(experienceEntries, index)?.teamSize);
    case "work.reportsTo":
      return text(entryAt(experienceEntries, index)?.reportsTo);
    case "work.refereeName":
      return text(entryAt(experienceEntries, index)?.refereeName);
    case "work.refereeTitle":
      return text(entryAt(experienceEntries, index)?.refereeTitle);
    case "work.refereePhone":
      return text(entryAt(experienceEntries, index)?.refereePhone);
    case "work.refereeRelation":
      return text(entryAt(experienceEntries, index)?.refereeRelation);

    /* ------------------------------------------------------------- project */
    case "project.name":
      return text(entryAt(profile.projects, index)?.name);
    case "project.category": {
      const category = entryAt(profile.projects, index)?.category;
      return category ? text(PROJECT_CATEGORY_LABELS[category]) : undefined;
    }
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
    case "project.current": {
      const project = entryAt(profile.projects, index);
      return project?.dates ? { value: { text: project.dates.current ? "是" : "否" } } : undefined;
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
    case "skill.awards": {
      const awards = awardsOf(profile);
      if (awards.length === 0) return undefined;
      /*
       * A structured 获奖信息 row asks for one award. When the page repeats the
       * row, each row reads its own award; a single award field still receives
       * the whole list, which is what a 奖项 textarea expects.
       */
      if (context.repeatIndex !== undefined) return text(entryAt(awards, index));
      return list(awards);
    }
    case "skill.awardDate": {
      const awards = awardsOf(profile);
      const award = context.repeatIndex !== undefined
        ? entryAt(awards, index)
        : awards.length === 1
          ? awards[0]
          : undefined;
      return text(awardDateFrom(award));
    }
    case "skill.awardLevel": {
      const awards = awardsOf(profile);
      const award = context.repeatIndex !== undefined
        ? entryAt(awards, index)
        : awards.length === 1
          ? awards[0]
          : undefined;
      return text(awardLevelFrom(award));
    }
    case "skill.interests":
      return profile.skills.interests.length > 0 ? list(profile.skills.interests) : undefined;
    case "skill.language": {
      const exams = languageExamsOf(profile);
      if (exams.length > 0) return list(exams.map((entry) => entry.exam));
      const languages = unique([
        ...profile.education.flatMap((item) => item.languages ?? []),
        ...profile.skills.certificates.filter((item) => /(英语|日语|韩语|雅思|托福|CET|IELTS|TOEFL)/i.test(item)),
        ...profile.skills.items.filter((item) => /(英语|日语|CET|雅思|托福)/i.test(item)),
      ]);
      return languages.length > 0 ? list(languages) : undefined;
    }
    case "skill.languageScore": {
      const scored = languageExamsOf(profile).filter((entry) => entry.score);
      return text(scored[0]?.score);
    }
    case "skill.computer": {
      const items = profile.skills.items.filter((item) => /(计算机|办公|office|excel|word|ppt)/i.test(item));
      return items.length > 0 ? list(items) : undefined;
    }
    case "skill.programming": {
      const items = programmingLanguagesOf(profile);
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

/**
 * Zero-based read from a repeatable list.
 *
 * Out-of-range is deliberately `undefined`, not "the last entry again". A page
 * with four project rows and a résumé with three projects must leave the fourth
 * row alone; copying project #3 into it creates a duplicate the applicant has
 * to notice and delete before submitting.
 */
export function entryAt<T>(entries: T[], index: number): T | undefined {
  if (index < 0 || index >= entries.length) return undefined;
  return entries[index];
}

/**
 * Education ordering used by every education key.
 *
 * Forms number education rows newest/highest first, and "current education"
 * blocks mean the highest in-progress degree. Résumé order is not reliable:
 * some people list the bachelor's first. Sorting once, here, makes `school`,
 * `degree`, dates, GPA and every other education field agree with each other.
 *
 * Rank first, then end date (current > later > earlier), then start date.
 * Ties keep their original order so a stable, unsurprising list remains.
 */
const DEGREE_LEVELS: Array<{ rank: number; test: RegExp }> = [
  { rank: 0, test: /博士|ph\.?d|doctor/i },
  { rank: 1, test: /硕士|研究生|mba|master|msc|m\.s\./i },
  { rank: 2, test: /本科|学士|bachelor|bsc|b\.s\.|b\.a\./i },
  { rank: 3, test: /大专|专科|associate/i },
  { rank: 4, test: /中专|技校|vocational/i },
  { rank: 5, test: /高中|high school/i },
];

export function degreeRank(degree: string | undefined): number {
  if (!degree) return Number.POSITIVE_INFINITY;
  for (const level of DEGREE_LEVELS) {
    if (level.test.test(degree)) return level.rank;
  }
  return Number.POSITIVE_INFINITY;
}

function monthKey(value: string | undefined, current = false): string {
  if (current) return "9999-12";
  if (!value) return "0000-00";
  const match = value.match(/^(\d{4})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}` : "0000-00";
}

export function sortEducation<T extends Pick<Education, "degree" | "dates">>(education: T[]): T[] {
  return education
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const rankA = degreeRank(a.entry.degree);
      const rankB = degreeRank(b.entry.degree);
      if (rankA !== rankB) return rankA - rankB;

      const endA = monthKey(a.entry.dates?.end, a.entry.dates?.current);
      const endB = monthKey(b.entry.dates?.end, b.entry.dates?.current);
      if (endA !== endB) return endB.localeCompare(endA);

      const startA = monthKey(a.entry.dates?.start);
      const startB = monthKey(b.entry.dates?.start);
      if (startA !== startB) return startB.localeCompare(startA);

      return a.index - b.index;
    })
    .map(({ entry }) => entry);
}

function educationAt(education: Education[], index: number): Education | undefined {
  return entryAt(sortEducation(education), index);
}

/**
 * Every award we can honestly attribute to the person.
 *
 * Resumes often put a competition prize in the education block rather than in a
 * separate 获奖 section. The parser keeps those lines as `education[].honors`;
 * a form with a 获奖信息 row should see them too. Duplicates are removed because
 * the same line can legitimately appear in both places.
 */
function awardsOf(profile: Profile): string[] {
  return unique([
    ...profile.skills.awards,
    ...profile.education.flatMap((entry) => entry.honors ?? []),
  ]);
}

/**
 * Language exams named anywhere the profile can see them.
 *
 * Tencent asks for “外语考试/等级” in a dropdown whose options are CET-4, CET-6,
 * TOEFL, IELTS, TEM and so on, with a separate score box beside it. A resume
 * usually mentions the exam in prose (“CET-6 (562)”), so returning the whole
 * sentence would fail the dropdown match. Extract the exam name, and keep the
 * score for the adjacent box.
 */
const LANGUAGE_EXAM_PATTERN =
  /(?:\b(CET[\s-]?[46]|TEM[\s-]?[48]|IELTS|TOEFL|GRE|GMAT|SAT|ACT)\b|(JLPT\s*N?[1-5]|日语\s*N?[1-5]|英语专业[四八]级|专业[四八]级))(?:\s*[（(:：]?\s*(\d{2,4}(?:\.\d)?)\s*[)）]?)?/gi;

function languageExamsOf(profile: Profile): Array<{ exam: string; score?: string }> {
  const sources = [
    ...(profile.rawText ? [profile.rawText] : []),
    ...profile.skills.certificates,
    ...profile.skills.items,
    ...profile.education.flatMap((entry) => entry.languages ?? []),
  ];
  const found = new Map<string, { exam: string; score?: string }>();
  for (const source of sources) {
    for (const match of source.matchAll(LANGUAGE_EXAM_PATTERN)) {
      const exam = normalizeExamName(match[1] ?? match[2] ?? "");
      if (!exam) continue;
      const score = match[3] && !/^(19|20)\d{2}$/.test(match[3]) ? match[3] : undefined;
      const current = found.get(exam);
      if (!current || (!current.score && score)) {
        found.set(exam, { exam, ...(score ? { score } : {}) });
      }
    }
  }
  return [...found.values()];
}

function normalizeExamName(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  const cet = compact.match(/^cet[\s-]?([46])$/i);
  if (cet) return `CET-${cet[1]}`;
  const tem = compact.match(/^tem[\s-]?([48])$/i);
  if (tem) return `TEM-${tem[1]}`;
  if (/^ielts$/i.test(compact)) return "IELTS";
  if (/^toefl$/i.test(compact)) return "TOEFL";
  if (/^gre$/i.test(compact)) return "GRE";
  if (/^gmat$/i.test(compact)) return "GMAT";
  if (/^sat$/i.test(compact)) return "SAT";
  if (/^act$/i.test(compact)) return "ACT";
  const jlpt = compact.match(/^jlpt\s*n?([1-5])$/i);
  if (jlpt) return `JLPT N${jlpt[1]}`;
  if (/^日语\s*n?[1-5]$/i.test(compact)) return compact.replace(/\s+/g, " ").replace(/^日语\s*/i, "日语 ");
  if (/^专业[四八]级$/.test(compact)) return `英语${compact}`;
  return compact;
}

/**
 * Programming languages, in the forms a form's multi-select can match.
 *
 * The resume parser keeps frameworks and databases in the same flat skill list
 * as languages, and project rows keep a technology stack. A field labelled
 * 开发语言 wants languages, so a failed option match should not be caused by
 * offering React or Kafka there. Project and experience stacks are included
 * because a resume may name its stack only inside the project description.
 */
const PROGRAMMING_LANGUAGE =
  /(?:^|[^a-z0-9+#.])(java|python|javascript|typescript|golang|go|c\+\+|c#|c|sql|rust|kotlin|swift|php|ruby|scala|matlab|shell|bash|perl|lua|dart|objective-c|r)(?![a-z0-9+#])/i;

function programmingLanguagesOf(profile: Profile): string[] {
  const candidates = unique([
    ...profile.skills.items,
    ...profile.projects.flatMap((entry) => entry.stack ?? []),
    ...profile.experience.flatMap((entry) => entry.stack ?? []),
  ]);
  const tokens = candidates.flatMap((item) =>
    /[、,，;；/|]/.test(item) ? item.split(/[、,，;；/|]/).map((part) => part.trim()) : [item],
  );
  const languages = unique(
    tokens
      .map((item) => item.replace(/^(?:编程语言|开发语言|语言|programming languages?)[:：]\s*/i, "").trim())
      .filter((item) => item.length > 0 && item.length <= 30 && PROGRAMMING_LANGUAGE.test(item)),
  );
  if (languages.length > 0) return languages;

  /*
   * Older profiles may predate the parser's stack extraction, and some resumes
   * name the stack only in a project bullet. Fall back to the prose we already
   * parsed, including raw text when it exists, but only for tokens that are
   * unambiguously language names: one-letter languages (C, R) are excluded
   * because a stray letter in prose is far more likely to be noise than a skill
   * the person wants on a form.
   */
  const prose = [
    profile.rawText ?? "",
    ...profile.projects.flatMap((entry) => [entry.summary ?? "", ...entry.highlights]),
    ...profile.experience.flatMap((entry) => entry.highlights),
    profile.essays.selfIntro ?? "",
  ].join(" ");
  return unique(
    prose
      .split(/[^A-Za-z+#.]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2 && token.length <= 30 && PROGRAMMING_LANGUAGE.test(token)),
  );
}

/**
 * Pull a month from an award line, but only when the line names one.
 *
 * “2024.06 蓝桥杯省一等奖” gives a usable 2024-06. “2024 年校一等奖” gives only
 * a year; a month picker would then default to January, which is a date the
 * person never stated. Returning nothing is more honest than inventing it.
 */
function awardDateFrom(award: string | undefined): string | undefined {
  if (!award) return undefined;
  const match = award.match(/(20\d{2})\s*[年./-]\s*(\d{1,2})/);
  if (!match) return undefined;
  const month = Number(match[2]);
  if (!Number.isFinite(month) || month < 1 || month > 12) return undefined;
  return `${match[1]}-${String(month).padStart(2, "0")}`;
}

/** A coarse award category, only when the wording supports it. */
function awardLevelFrom(award: string | undefined): string | undefined {
  if (!award) return undefined;
  if (/奖学金|scholarship/i.test(award)) return "奖学金";
  if (/大赛|竞赛|比赛|冠军|亚军|季军|一等奖|二等奖|三等奖|金奖|银奖|铜奖|contest|competition/i.test(award)) {
    return "竞赛";
  }
  if (/优秀|标兵|三好|称号|荣誉|honor/i.test(award)) return "荣誉称号";
  return undefined;
}

/** "4.0/5.0" → { value: "4.0", base: "5.0" }; anything else stays whole. */
export function splitGpa(gpa: string | undefined): { value?: string; base?: string } {
  const trimmed = gpa?.trim();
  if (!trimmed) return {};
  const match = trimmed.match(/^([0-9]+(?:\.[0-9]+)?)\s*\/\s*([0-9]+(?:\.[0-9]+)?)$/);
  if (!match) return { value: trimmed };
  return { value: match[1], base: match[2] };
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

/**
 * Highest qualification, normalised to the *level* wording Chinese forms use.
 * A resume says 学士学位; the dropdown says 本科.
 */
export function highestDegree(education: Array<{ degree?: string }>): string | undefined {
  let bestRank = Number.POSITIVE_INFINITY;
  for (const item of education) {
    if (!item.degree) continue;
    bestRank = Math.min(bestRank, degreeRank(item.degree));
  }
  switch (bestRank) {
    case 0:
      return "博士研究生";
    case 1:
      return "硕士研究生";
    case 2:
      return "本科";
    case 3:
      return "大专";
    case 4:
      return "中专";
    case 5:
      return "高中";
    default:
      return undefined;
  }
}

/* ------------------------------------------------------------- main entry */

/** Build the ordered candidate list for one field. */
export function resolveField(field: FieldDescriptor, context: ResolveContext): Candidate[] {
  const key = field.key;
  const { byKey, byLabel } = indexMemory(context.memory);
  const hiringTrack = effectiveHiringTrack(context.hiringTrack, context.profile.preference.targetTrack);

  /*
   * A field the taxonomy does not know is still a question the person answers.
   * The learning engine stores those under `custom.<label>` (site-scoped), so
   * recall has to look under the same key. Returning early here — as an earlier
   * version did — meant answers to unclassified ATS fields were remembered but
   * could never be offered back.
   */
  if (!key || key === "unknown") {
    const label = field.label || field.placeholder || field.name || "";
    if (!label.trim()) return [];
    const customKey = `custom.${normalize(label).slice(0, 40)}`;
    const entries = byKey.get(customKey) ?? [];
    // Prefer this site's own record when the person has answered elsewhere too.
    const entry = entries.find((item) => item.siteKey === context.siteKey) ?? entries[0];
    if (!entry) return [];
    const sameSite = entry.siteKey === context.siteKey;
    return [
      {
        value: coerceMemoryValue(entry, field),
        evidence: {
          source: sameSite ? "site-memory" : "memory",
          detail: `沿用你此前在「${entry.labelSnapshot}」填写的答案`,
        },
        confidence: sameSite ? 0.9 : 0.78,
        tier: sameSite ? TIER.siteMemory : TIER.learnedMemory,
      },
    ];
  }
  if (NEVER_AUTOFILL_KEYS.has(key)) return [];

  const candidates: Candidate[] = [];

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
  const experience = key.startsWith("work.")
    ? experiencesForTrack(context.profile.experience, hiringTrack, field.experienceKind)[index]
    : undefined;
  const experienceTypeUnclear =
    experience !== undefined &&
    (field.experienceKind !== undefined || hiringTrack !== undefined) &&
    experienceKindOf(experience) === undefined;
  const fromProfile = readProfile(context.profile, key, {
    pageRole: context.pageRole,
    company: context.company,
    index,
    hasGpaBase: context.hasGpaBase,
    repeatIndex: field.repeatIndex,
    hiringTrack,
    experienceKind: field.experienceKind,
  });
  if (fromProfile) {
    // An essay value with no verbatim quote was composed, not copied.
    const composed = key.startsWith("essay.") && fromProfile.quote === undefined;
    candidates.push({
      value: fromProfile.value,
      evidence: {
        source: composed ? "composed" : "profile",
        detail: composed
          ? "由简历内容整理生成"
          : experienceTypeUnclear
            ? "来自简历 / 工作台资料；经历类型未标注，请核对"
            : "来自简历 / 工作台资料",
        ...(fromProfile.quote ? { quote: fromProfile.quote } : {}),
      },
      confidence: composed ? 0.66 : experienceTypeUnclear ? 0.55 : 0.9,
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

  /*
   * A multi-select asks for several values at once ("开发语言" on Tencent offers
   * a fixed list of languages). Scoring the joined text against one option at a
   * time makes every language contained in the joined string look equally
   * likely, so `matchOption` sees a tie and drops the candidate entirely. Match
   * each requested value on its own and keep the ones the widget can express.
   */
  const values = candidate.value.multiple?.filter(Boolean) ?? [];
  if (field.multiple && values.length > 0) {
    const { matched } = matchOptions(values, field.options);
    if (matched.length === 0) return undefined;
    const labels = matched.map((entry) => entry.label);
    return {
      ...candidate,
      value: {
        text: labels.join("、"),
        multiple: labels,
        raw: matched.map((entry) => entry.value).join(","),
      },
      // Answering only part of the list is a weaker claim than answering all of
      // it, and the panel should say so rather than presenting it as settled.
      confidence:
        candidate.confidence *
        Math.min(...matched.map((entry) => entry.confidence)) *
        (matched.length / values.length),
    };
  }

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

const URL_KEYS = new Set([
  "contact.homepage",
  "contact.github",
  "contact.linkedin",
  "project.link",
]);

/**
 * Domains without a scheme are common on resumes ("github.com/foo") and are
 * accepted by every ATS we have seen. Bare prose is not: a two-character note
 * such as “连接” has no dot and cannot be a URL.
 */
const URLISH =
  /^(?:https?:\/\/)?(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+[\p{L}]{2,}(?::\d{2,5})?(?:[/?#]\S*)?$/u;

function expectsUrl(field: FieldDescriptor): boolean {
  return field.kind === "url" || Boolean(field.key && URL_KEYS.has(field.key));
}

function isUsableUrl(value: string): boolean {
  const raw = value.trim();
  if (!raw || raw.length > 500 || /\s/.test(raw)) return false;
  if (/^(无|暂无|没有|n\/a|none|-)$/i.test(raw)) return false;
  return URLISH.test(raw);
}

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
  const resolved = resolveField(field, options);
  /*
   * A URL control must receive a URL. A remembered value can be a note the
   * person typed elsewhere (“连接” was learned for 个人主页链接 on Tencent), and
   * proposing it as ready writes a value the page's validator will reject.
   * Format rejections become `missing`, which is honest: the memory is still
   * kept and shown again if the person edits the field themselves.
   */
  const candidates = expectsUrl(field)
    ? resolved.filter((candidate) => isUsableUrl(candidate.value.text))
    : resolved;

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
  else if (best.evidence.detail.includes("经历类型未标注")) {
    caution = "简历没有标明这段经历属于实习还是全职，填写前请确认";
  } else if (best.evidence.source === "default") caution = "常见默认值，请确认后使用";

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
