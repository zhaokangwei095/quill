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
      "个人基本信息",
      "基本信息",
      "个人资料",
      "基本资料",
      "个人情况",
      "个人档案",
      "个人概况",
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
      "通讯方式",
      "通讯信息",
      "联系地址",
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
      "求职目标",
      "应聘信息",
      "期望工作",
      "意向岗位",
      "求职方向",
      "岗位意向",
      "应聘岗位",
      "期望职位",
      "职业目标",
      "求职意向及岗位",
      "求职意向与岗位",
      "job objective",
      "career objective",
      "job intention",
      "objective",
      "意向",
    ],
  },
  {
    section: "education",
    aliases: [
      "教育经历",
      "教育背景",
      "教育情况",
      "教育信息",
      "学历信息",
      "学历情况",
      "学历背景",
      "学习经历",
      "学习背景",
      "教育及培训",
      "教育与培训",
      "教育及培训经历",
      "教育经历及背景",
      "教育背景及经历",
      "教育培训",
      "学历教育",
      "学术背景",
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
      "工作履历",
      "工作与实习经历",
      "工作及实习经历",
      "实习与工作经历",
      "实习及工作经历",
      "工作/实习经历",
      "实习经历",
      "实习经验",
      "实习实践",
      "实习实践经历",
      "实践与实习经历",
      "实践经历",
      "社会实践",
      "校园经历",
      "校园实践经历",
      "学生工作",
      "学生工作经历",
      "学生干部经历",
      "社团经历",
      "社团工作",
      "兼职经历",
      "兼职实习",
      "职业经历",
      "任职经历",
      "职业履历",
      "work experience",
      "working experience",
      "professional experience",
      "employment history",
      "internship experience",
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
      "科研项目",
      "研究经历",
      "课题经历",
      "课题研究",
      "学术研究",
      "竞赛经历",
      "比赛经历",
      "作品经历",
      "项目与科研经历",
      "项目及科研经历",
      "科研实践经历",
      "科研项目经历",
      "项目经历及成果",
      "项目实践经历",
      "项目开发经历",
      "竞赛与项目经历",
      "项目作品",
      "个人项目",
      "课程项目",
      "研究项目",
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
      "职业技能",
      "技能特长",
      "技能证书",
      "技能与证书",
      "技能及证书",
      "证书与荣誉",
      "专业技能及荣誉",
      "专业技能与获奖",
      "专业技能、证书与荣誉",
      "技能、证书与荣誉",
      "技能证书与荣誉",
      "技能与荣誉",
      "技能证书及荣誉",
      "专业能力",
      "个人技能",
      "技能水平",
      "计算机水平",
      "计算机技能",
      "语言能力及证书",
      "证书及荣誉",
      "荣誉与奖项",
      "获奖与荣誉",
      "奖励荣誉",
      "所获奖项",
      "荣誉奖励",
      "专业证书",
      "it技能",
      "技能",
      "证书",
      "资格证书",
      "荣誉证书",
      "获奖证书",
      "语言能力",
      "外语水平",
      "语言水平",
      "获奖情况",
      "获奖经历",
      "荣誉奖项",
      "奖项荣誉",
      "所获荣誉",
      "奖励情况",
      "荣誉与奖励",
      "奖项",
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
      "自我评价与职业规划",
      "个人优势",
      "职业规划",
      "兴趣爱好",
      "特长爱好",
      "个人特质",
      "summary",
      "self evaluation",
      "self introduction",
      "about me",
      "自我",
      "resumen",
    ],
  },
];

const HEADING_INDEX: Array<{ section: FieldSection; alias: string; normalized: string }> = SECTION_HEADINGS.flatMap(
  (entry) => entry.aliases.map((alias) => ({ section: entry.section, alias, normalized: normalize(alias) })),
).sort((a, b) => b.normalized.length - a.normalized.length);

/**
 * Qualifiers that may sit beside an alias ("教育经历（本科）", "项目经历-选填").
 * Anything else next to an alias makes the line content, not a heading.
 */
const HEADING_QUALIFIERS = new Set([
  "必填",
  "选填",
  "可选",
  "本科",
  "硕士",
  "博士",
  "研究生",
  "专科",
  "高中",
  "全职",
  "实习",
  "校园",
  "社会",
  "科研",
  "学术",
  "技术",
  "专业",
  "获奖",
  "荣誉",
  "证书",
  "技能",
  "一",
  "二",
  "三",
  "四",
  "五",
]);

/**
 * Resumes decorate headings: “一、教育经历”, “1. 教育经历”, “【教育经历】”,
 * “教育经历（选填）”. Strip the decoration before matching; leaving it on was
 * why numbered headings were rejected as content and whole sections vanished.
 */
function cleanHeading(line: string): string {
  return line
    .trim()
    .replace(/^[#\s|·*•◆◇■□●○【\[（(]+/, "")
    .replace(/^[一二三四五六七八九十百]+[、.．)）]\s*/, "")
    .replace(/^\d{1,2}[、.．)）]\s*/, "")
    .replace(/[】\]）)]+\s*$/, "")
    .replace(/[（(][^（）()]{1,12}[）)]\s*$/, "")
    .replace(/[:：\s|·—–\-]+$/g, "")
    .trim();
}

/**
 * A heading is short, has no sentence-ending punctuation, and normalises to
 * exactly one of our aliases (optionally with a trailing colon or wrapper).
 */
export function matchHeading(line: string): { section: FieldSection; heading: string } | undefined {
  const trimmed = cleanHeading(line);
  if (!trimmed) return undefined;
  if (trimmed.length > 24) return undefined;
  // A "label: value" line is content, not a heading. Without this guard,
  // "证书：CET-6 (585)" is read as a 证书 heading and its value is lost.
  // (`matchInlineHeading` handles that case without discarding the value.)
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
  // like "教育背景 EDUCATION" and qualified ones like "项目经历（选填）".
  // The remainder must be a translation, a known qualifier, or at most two
  // characters; otherwise "项目名称" would become a project heading.
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
    const isQualifier = HEADING_QUALIFIERS.has(remainder);
    if (isTranslation || isQualifier) {
      return { section: entry.section, heading: trimmed };
    }
  }
  return undefined;
}

/**
 * A heading and its first value on one line: “技能：Java、Python”,
 * “联系方式：13800138000”. The section starts and the value is kept, instead of
 * the whole line being treated as an unplaceable body line.
 */
export function matchInlineHeading(
  line: string,
): { section: FieldSection; heading: string; rest: string } | undefined {
  const trimmed = line.trim();
  const at = trimmed.search(/[:：]/);
  if (at <= 0 || at > 24) return undefined;
  const head = trimmed.slice(0, at).trim();
  const rest = trimmed.slice(at + 1).trim();
  if (!head || !rest) return undefined;

  /*
   * Only a pure heading may carry a value. “姓名：张三” must not start an
   * identity section because “姓名” is a label, not a section title — but that
   * is already true: it is not in the alias table.
   */
  const heading = matchHeading(head);
  if (!heading) return undefined;
  return { ...heading, rest };
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

    const inline = matchInlineHeading(line);
    if (inline) {
      /*
       * “兴趣爱好：长跑、摄影” inside 专业技能 is a field label, not a new
       * section. Starting an essay section here used to merge with the later
       * 自我评价 section and hide both the interests and the self-intro.
       * Same-section labels (证书：CET-6, 技能：Java) are content for the same
       * reason; the section parser already knows how to classify them.
       */
      const essayLabelInsideSkill =
        current?.section === "skill" &&
        inline.section === "essay" &&
        /^(兴趣爱好|特长爱好|兴趣|爱好)$/.test(normalize(inline.heading));
      if (current && (current.section === inline.section || essayLabelInsideSkill)) {
        current.lines.push(line);
        continue;
      }
      current = { section: inline.section, heading: inline.heading, lines: [inline.rest] };
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
    /*
     * Education/skill sections split by a page break should join. Essay
     * sections should not: “兴趣爱好” and “自我评价” are different questions,
     * and merging them kept only the first heading, so the self-intro was
     * filed as an unclassified hobby.
     */
    const mergeable =
      previous !== undefined &&
      previous.section === section.section &&
      (section.section !== "essay" || normalize(previous.heading) === normalize(section.heading));
    if (mergeable) {
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
export const ORG_MARKER =
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
export function splitEntries(lines: string[], section: FieldSection): string[][] {
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
      starts.add(entryStartFor(lines, at, section));
    }
  } else {
    const structural = structuralAnchors(lines, section);
    const anchors = structural.length >= 2 ? structural : bulletAnchors(lines);
    for (const at of anchors) starts.add(at);
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
 * Walk back from a date-range line to the start of its entry.
 *
 * A Chinese education entry is often three lines:
 *
 *     浙江大学
 *     计算机科学与技术（本科）
 *     2018.09 - 2022.06
 *
 * The date is on the last line, and the school two lines above it. Stepping
 * back only over organisation markers lost the school line of every entry after
 * the first. Header-like short lines are safe to absorb; a bullet, long
 * sentence, or another date range is where the previous entry's body begins.
 */
function entryStartFor(lines: string[], rangeAt: number, section: FieldSection): number {
  let start = rangeAt;
  const maxBack = section === "education" ? 3 : 2;

  for (let i = rangeAt - 1; i >= 0 && i >= rangeAt - maxBack; i -= 1) {
    const line = (lines[i] ?? "").trim();
    if (!line) break;
    if (BULLET.test(line)) break;
    if (DATE_RANGE.test(line)) break;
    if (line.length > 60) break;
    if (/[。；;]$/.test(line)) break;
    if (section === "education") {
      /*
       * These lines belong to the previous entry even though they are short:
       * “GPA 3.9/4.0” and “2023年 校级优秀研究生” sit at the top of the next
       * entry only because a date line follows them. Walking over them made
       * the next entry start at a GPA line, which then became the school name.
       */
      if (/(gpa|绩点|排名|成绩|rank|主修课程|课程|奖学金|奖|荣誉|优秀|证书)/i.test(line)) break;
    }
    if ((section === "experience" || section === "project") && !ORG_MARKER.test(line) && line.length > 32) {
      break;
    }
    start = i;
  }

  return start;
}

/**
 * Structure-only entry boundaries, used when a section has no date ranges at
 * all (common in project lists and in resumes that write only years in a
 * separate column). Education splits on school names; projects split on short
 * name-like lines that sit immediately above bullets.
 */
function structuralAnchors(lines: string[], section: FieldSection): number[] {
  const offsets: number[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] ?? "").trim();
    if (!line || BULLET.test(line)) continue;

    if (section === "education") {
      if (/(大学|学院|学校|university|college|institute|academy)/i.test(line) && line.length <= 80) {
        offsets.push(i);
      }
      continue;
    }

    if (section === "project") {
      const next = (lines[i + 1] ?? "").trim();
      const nameLike = line.length <= 40 && !/[。；;]/.test(line);
      if (nameLike && (BULLET.test(next) || /(项目|系统|平台|小程序|app|网站|算法|模型|研究|设计|开发)/i.test(line))) {
        offsets.push(i);
      }
      continue;
    }

    if (ORG_MARKER.test(line) && line.length <= 60 && !/[。；;]/.test(line)) {
      offsets.push(i);
    }
  }

  return [...new Set(offsets)].sort((a, b) => a - b);
}

/**
 * Fallback for sections with no structure at all: a bullet that follows a
 * non-bullet line begins a new entry.
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
