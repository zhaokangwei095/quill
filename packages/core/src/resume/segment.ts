/**
 * Splitting a resume into sections.
 *
 * Resumes are semi-structured at best. We look for known section headings,
 * accept the common variants, and fall back to date-anchored entry splitting
 * when a section has no usable heading.
 */

import { normalize, toLines, tidy, hasCjk } from "../text.js";
import type { FieldSection } from "../types.js";

export interface ResumeSection {
  section: FieldSection;
  /** Original heading text, for display. */
  heading: string;
  lines: string[];
}

/** Headings we accept, longest first so "项目经历" beats "经历". */
const SECTION_HEADINGS: Array<{ section: FieldSection; aliases: string[] }> = [
  {
    section: "identity",
    aliases: [
      "个人信息",
      "基本信息",
      "个人资料",
      "基本资料",
      "个人情况",
      "personal information",
      "personal details",
      "basic information",
      "profile",
      "información personal",
    ],
  },
  {
    section: "contact",
    aliases: [
      "联系方式",
      "联系信息",
      "联络方式",
      "contact information",
      "contact details",
      "contact",
      "datos de contacto",
      "coordonnées",
    ],
  },
  {
    section: "preference",
    aliases: [
      "求职意向",
      "求职意愿",
      "职业意向",
      "应聘意向",
      "job objective",
      "career objective",
      "job intention",
      "objective",
      "求职目标",
      "意向",
    ],
  },
  {
    section: "education",
    aliases: [
      "教育经历",
      "教育背景",
      "教育情况",
      "学习经历",
      "学习背景",
      "学历背景",
      "education",
      "education background",
      "academic background",
      "教育",
      "educación",
      "formation",
    ],
  },
  {
    section: "experience",
    aliases: [
      "工作经历",
      "工作经验",
      "实习经历",
      "实习经验",
      "职业经历",
      "任职经历",
      "工作履历",
      "work experience",
      "working experience",
      "professional experience",
      "employment history",
      "experience",
      "工作",
      "实习",
      "experiencia",
      "expérience professionnelle",
    ],
  },
  {
    section: "project",
    aliases: [
      "项目经历",
      "项目经验",
      "项目实践",
      "科研经历",
      "研究经历",
      "课题经历",
      "project experience",
      "projects",
      "project",
      "research experience",
      "项目",
      "proyectos",
      "projets",
    ],
  },
  {
    section: "skill",
    aliases: [
      "专业技能",
      "技能特长",
      "技能证书",
      "技能",
      "证书",
      "资格证书",
      "语言能力",
      "外语水平",
      "获奖情况",
      "荣誉奖项",
      "奖项荣誉",
      "荣誉",
      "skills",
      "technical skills",
      "certificates",
      "certifications",
      "awards",
      "honors",
      "languages",
      "语言",
      "获奖",
      "habilidades",
      "compétences",
    ],
  },
  {
    section: "essay",
    aliases: [
      "自我评价",
      "自我介绍",
      "个人总结",
      "个人简介",
      "自我描述",
      "summary",
      "self evaluation",
      "self introduction",
      "about me",
      "自我评价与职业规划",
      "个人优势",
      "自我",
      "resumen",
    ],
  },
];

const HEADING_INDEX: Array<{ section: FieldSection; alias: string; normalized: string }> = SECTION_HEADINGS.flatMap(
  (entry) => entry.aliases.map((alias) => ({ section: entry.section, alias, normalized: normalize(alias) })),
).sort((a, b) => b.normalized.length - a.normalized.length);

/**
 * A heading is short, has no sentence-ending punctuation, and normalises to
 * exactly one of our aliases (optionally with a trailing colon or wrapper).
 */
export function matchHeading(line: string): { section: FieldSection; heading: string } | undefined {
  const trimmed = line.trim().replace(/[:：\s|·—–\-]+$/g, "").replace(/^[#\s|·*]+/, "");
  if (!trimmed) return undefined;
  if (trimmed.length > 24) return undefined;
  // A "label: value" line is content, not a heading. Without this guard,
  // "证书：CET-6 (585)" is read as a 证书 heading and its value is lost.
  const colon = trimmed.search(/[:：]/);
  if (colon >= 0 && trimmed.slice(colon + 1).trim().length > 1) return undefined;
  // Headings do not carry numbers ("工作经历" yes, "3 年经验" no).
  if (/\d/.test(trimmed)) return undefined;
  const normalized = normalize(trimmed);
  if (!normalized) return undefined;

  // Prefer an exact alias hit.
  const exact = HEADING_INDEX.find((entry) => entry.normalized === normalized);
  if (exact) return { section: exact.section, heading: trimmed };

  // Then allow the alias as a prefix/suffix, which covers bilingual headings
  // like "教育背景 EDUCATION". The remainder must look like a translation —
  // latin letters only — so that "专业技能" does not swallow "技能：Java".
  for (const entry of HEADING_INDEX) {
    if (entry.normalized.length < 2) continue;
    const leadingRemainder = normalized.startsWith(entry.normalized)
      ? normalized.slice(entry.normalized.length)
      : undefined;
    const trailingRemainder = normalized.endsWith(entry.normalized)
      ? normalized.slice(0, -entry.normalized.length)
      : undefined;
    const remainder = leadingRemainder ?? trailingRemainder;
    if (remainder === undefined) continue;
    const isTranslation = /^[a-z]{2,20}$/.test(remainder);
    const isDecoration = remainder.length <= 2;
    if (isTranslation || isDecoration) {
      return { section: entry.section, heading: trimmed };
    }
  }
  return undefined;
}

/**
 * Segment a resume into sections. Anything before the first heading is
 * returned as a synthetic `identity` block, because that is almost always
 * where the name and contact line live.
 */
export function segmentResume(text: string): { sections: ResumeSection[]; header: string[] } {
  const lines = toLines(tidy(text));
  const sections: ResumeSection[] = [];
  const header: string[] = [];
  let current: ResumeSection | undefined;

  for (const line of lines) {
    const heading = matchHeading(line);
    if (heading) {
      current = { section: heading.section, heading: heading.heading, lines: [] };
      sections.push(current);
      continue;
    }
    if (current) current.lines.push(line);
    else header.push(line);
  }

  // Merge adjacent sections of the same type (e.g. 技能 split across a page
  // break) so downstream parsing sees one block.
  const merged: ResumeSection[] = [];
  for (const section of sections) {
    const previous = merged[merged.length - 1];
    if (previous && previous.section === section.section) {
      previous.lines.push(...section.lines);
    } else {
      merged.push({ ...section });
    }
  }

  return { sections: merged, header };
}

/* --------------------------------------------------------------- entries */

/** A date *range*, which is what entry headers carry and body bullets do not. */
const DATE_RANGE =
  /(?:19|20)\d{2}\s*(?:[年/\-.]\s*\d{1,2})?\s*[-~—–至到]+\s*(?:(?:19|20)\d{2}\s*(?:[年/\-.]\s*\d{1,2})?|至今|现在|present|current|now)/i;

const BULLET = /^[\u2022\u25CF\u25AA\u002A\u002D\u2013\u2014·•▪◦]/;

/** Words that mark a line as an organisation header rather than content. */
const ORG_MARKER =
  /(大学|学院|学校|中学|高中|university|college|institute|academy|school|公司|集团|科技|有限公司|股份|银行|研究院|事务所|studio|labs?|inc\.?|ltd\.?|corp)/i;

/**
 * Split a section body into entries.
 *
 * The reliable signal is a date range, because entry headers carry one and
 * body bullets almost never do. But the range is frequently on the *second*
 * line of an entry — English resumes write "Shanghai Jiao Tong University" and
 * then "MSc in Computer Science, 2021 - 2024". So for each range we walk back
 * over header-like lines to find where the entry really begins.
 *
 * When a section has no ranges at all, we fall back to bullet structure.
 */
export function splitEntries(lines: string[], _section: FieldSection): string[][] {
  if (lines.length === 0) return [];

  const rangeLines: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (BULLET.test(line.trim())) continue;
    if (DATE_RANGE.test(line)) rangeLines.push(i);
  }

  const starts = new Set<number>([0]);

  if (rangeLines.length > 0) {
    for (const at of rangeLines) {
      starts.add(entryStartFor(lines, at));
    }
  } else {
    for (const at of bulletAnchors(lines)) starts.add(at);
  }

  const offsets = [...starts].sort((a, b) => a - b);
  if (offsets.length <= 1) return [lines];

  const entries: string[][] = [];
  for (let i = 0; i < offsets.length; i += 1) {
    const from = offsets[i] ?? 0;
    const to = offsets[i + 1] ?? lines.length;
    const entry = lines.slice(from, to);
    if (entry.length > 0) entries.push(entry);
  }
  return entries;
}

/**
 * Walk back from a date-range line to the start of its entry. We only step
 * over a line that looks like an organisation name, which prevents an award or
 * course line from being absorbed into the next entry.
 */
function entryStartFor(lines: string[], rangeAt: number): number {
  let start = rangeAt;
  for (let i = rangeAt - 1; i >= 0 && i >= rangeAt - 2; i -= 1) {
    const line = (lines[i] ?? "").trim();
    if (!line) break;
    if (BULLET.test(line)) break;
    if (DATE_RANGE.test(line)) break;
    if (!ORG_MARKER.test(line)) break;
    start = i;
  }
  return start;
}

/**
 * Fallback for sections with no date ranges: a bullet that follows a non-bullet
 * line begins a new entry.
 */
function bulletAnchors(lines: string[]): number[] {
  const offsets = [0];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const previous = lines[i - 1] ?? "";
    if (!BULLET.test(line.trim())) continue;
    if (BULLET.test(previous.trim())) continue;
    offsets.push(i);
  }
  return offsets;
}

/**
 * Remove the date range from a line so the remaining text is just the header.
 * Used by the education/experience/project parsers.
 */
export function stripDateRange(line: string): string {
  return line
    .replace(
      /(?:19|20)\d{2}\s*(?:[年/\-.]\s*\d{1,2})?\s*[-~—–至到]+\s*(?:(?:19|20)\d{2}\s*(?:[年/\-.]\s*\d{1,2})?|至今|现在|present|current|now)/gi,
      " ",
    )
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * A resume header line like "张三 | 男 | 1999.03 | 13800138000".
 *
 * `aggressive` splits latin lines on every comma, which is correct for entry
 * headers ("ByteDance, Data Engineer Intern, Shanghai, 2023.06 - 2023.12") but
 * wrong for school names ("Shanghai Jiao Tong University, Shanghai"), so the
 * caller opts in.
 */
export function splitHeaderFields(line: string, aggressive = false): string[] {
  /*
   * Chinese resumes separate header fields with a single space
   * ("浙江大学 计算机科学与技术 本科"), while English ones use a pipe or a
   * double space ("Shanghai Jiao Tong University"). Splitting latin on single
   * spaces would shatter proper nouns, so the rule depends on the script.
   */
  const separator = hasCjk(line)
    ? /[|｜/·•\u3000]|\s+/
    : aggressive
      ? /[|｜/·•]{1,}|,\s*|\s{2,}/
      : /[|｜/·•]{1,}|\s{2,}/;
  return line
    .split(separator)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
