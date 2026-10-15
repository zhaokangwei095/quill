/**
 * Reading a job posting.
 *
 * We do not try to "understand" the posting the way a person would. We extract
 * the structure that matters for tailoring — requirements, their weight, and
 * the keywords inside them — and keep the original sentences so every claim we
 * make downstream can be traced back to a quote.
 */

import { containsTerm, normalize, tidy, toHalfWidth, toLines, unique } from "../text.js";
import type { JdAnalysis } from "../types.js";

/** Section headings common in Chinese and English postings. */
const JD_SECTIONS: Array<{ kind: string; patterns: RegExp[] }> = [
  {
    kind: "about",
    patterns: [/岗位(介绍|描述|概述)/, /职位描述/, /工作内容/, /about the (role|team|job)/i, /job description/i, /the role/i],
  },
  {
    kind: "responsibilities",
    patterns: [/岗位职责/, /工作职责/, /主要职责/, /职责描述/, /responsibilities/i, /what you.?ll do/i, /your role/i],
  },
  {
    kind: "requirements",
    patterns: [
      /任职(要求|资格)/,
      /岗位要求/,
      /任职条件/,
      /应聘要求/,
      /招聘要求/,
      /职位要求/,
      /requirements/i,
      /qualifications/i,
      /what we.?re looking for/i,
      /who you are/i,
      /你需要具备/,
    ],
  },
  {
    kind: "preferred",
    patterns: [/加分项/, /优先(条件|考虑)/, /nice to have/i, /preferred qualifications/i, /bonus points/i],
  },
  {
    kind: "benefits",
    patterns: [/我们提供/, /福利待遇/, /薪酬福利/, /what we offer/i, /benefits/i, /perks/i],
  },
  {
    kind: "about-company",
    patterns: [/公司(介绍|简介)/, /关于我们/, /about (us|the company)/i, /company overview/i],
  },
  { kind: "location", patterns: [/工作地点/, /办公地点/, /location/i, /work location/i] },
];

/** Words that mark a requirement as mandatory. */
const MUST_HAVE = [
  "必须",
  "要求",
  "需具备",
  "熟练掌握",
  "精通",
  "熟悉",
  "具备",
  "至少",
  "以上学历",
  "must have",
  "required",
  "requirement",
  "essential",
  "minimum",
  "proficient",
  "strong",
];

/** Words that soften a requirement. */
const NICE_TO_HAVE = [
  "优先",
  "加分",
  "更佳",
  "最好",
  "有…者优先",
  "preferred",
  "nice to have",
  "a plus",
  "bonus",
  "desirable",
  "ideally",
];

/** Skill-ish nouns we recognise, used to attach keywords to requirements. */
const SKILL_VOCABULARY: string[] = [
  // engineering
  "JavaScript", "TypeScript", "React", "Vue", "Angular", "Svelte", "Next.js", "Nuxt", "Node.js", "Express",
  "NestJS", "Python", "Django", "Flask", "FastAPI", "Java", "Spring", "Spring Boot", "Go", "Golang", "Rust",
  "C++", "C#", ".NET", "PHP", "Ruby", "Rails", "Swift", "Kotlin", "Objective-C", "Flutter", "Dart",
  "MySQL", "PostgreSQL", "MongoDB", "Redis", "Elasticsearch", "ClickHouse", "Kafka", "RabbitMQ", "gRPC",
  "Docker", "Kubernetes", "K8s", "Jenkins", "CI/CD", "Git", "Linux", "Nginx", "AWS", "Azure", "GCP",
  "微服务", "分布式", "高并发", "高可用", "中间件", "数据结构", "算法", "计算机网络", "操作系统", "数据库",
  "前端", "后端", "全栈", "客户端", "服务端", "架构设计", "性能优化", "单元测试", "代码评审",
  // data / ai
  "机器学习", "深度学习", "PyTorch", "TensorFlow", "LLM", "大模型", "NLP", "CV", "推荐系统", "数据挖掘",
  "Spark", "Hadoop", "Hive", "Flink", "SQL", "Pandas", "NumPy", "数据分析", "数据仓库", "ETL", "Tableau",
  "Power BI", "A/B 测试", "统计分析",
  // product / design / ops
  "产品设计", "需求分析", "用户研究", "竞品分析", "原型", "Axure", "Figma", "Sketch", "交互设计", "视觉设计",
  "UI", "UX", "品牌", "运营", "增长", "内容运营", "用户运营", "活动策划", "项目管理", "敏捷", "Scrum",
  // business
  "市场营销", "销售", "客户关系", "商务谈判", "财务分析", "会计", "审计", "风险管理", "供应链", "人力资源",
  "招聘", "培训", "薪酬绩效", "法务", "合规",
  // general
  "英语", "雅思", "托福", "CET-6", "CET-4", "普通话", "沟通能力", "团队协作", "抗压能力", "学习能力",
  "逻辑思维", "ownership", "leadership", "communication", "stakeholder",
];

const SKILL_INDEX = SKILL_VOCABULARY.map((term) => ({ term, normalized: normalize(term) })).sort(
  (a, b) => b.normalized.length - a.normalized.length,
);

export function extractKeywords(text: string): { keywords: string[]; derived: boolean } {
  const found: string[] = [];
  const haystack = normalize(text);
  for (const { term, normalized } of SKILL_INDEX) {
    if (normalized.length < 2) continue;
    if (!containsLoose(text, haystack, normalized, term)) continue;
    found.push(term);
  }
  /*
   * The curated vocabulary cannot cover every industry. When it finds nothing
   * for a requirement, fall back to the requirement's own significant terms so
   * gap analysis still has something to look for ("支付与金融相关业务" →
   * 支付, 金融, 业务).
   */
  if (found.length > 0) return { keywords: unique(found), derived: false };
  return { keywords: deriveTerms(text), derived: true };
}

/**
 * Substring containment with a word-boundary guard for latin terms.
 *
 * Without the guard, `.NET` matches inside "kuberNETes" and "R" matches inside
 * "Redis", which silently corrupts every downstream relevance score. CJK terms
 * have no boundaries to check.
 */
function containsLoose(raw: string, haystack: string, needle: string, original: string): boolean {
  const at = haystack.indexOf(needle);
  if (at < 0) return false;
  if (!/^[a-z]/.test(needle)) return true;
  // Check the original, un-normalised text for real boundaries.
  const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const boundary = new RegExp(`(^|[^A-Za-z0-9+#.])${escaped}($|[^A-Za-z0-9+#])`, "i");
  return boundary.test(raw) || boundary.test(haystack);
}

/**
 * Multi-character words that carry no discriminative value in a requirement
 * sentence. Removing these before segmenting is what turns
 * "有支付或金融相关业务经验" into 支付 / 金融 / 业务 instead of a smear of
 * overlapping n-grams.
 */
const STOP_WORDS = new Set([
  "熟悉", "精通", "掌握", "了解", "具备", "具有", "要求", "相关", "经验", "经历", "能力", "良好",
  "优先", "加分", "以上", "以下", "以及", "工作", "负责", "参与", "能够", "可以", "学历", "专业",
  "至少", "行业", "公司", "岗位", "职责", "任职", "条件", "必须", "需要", "擅长", "善于", "较强",
  "the", "and", "with", "for", "have", "must", "able", "strong", "good", "plus", "preferred",
  "required", "experience", "skills", "skill", "ability", "knowledge", "familiar", "proficient",
  "years", "year", "work", "working", "team", "teams", "nice", "has", "you", "your", "our", "will",
  "degree", "bachelor", "master", "related", "background",
]);

/** Single characters that only join phrases. */
const CJK_CONNECTORS = /[的有或与及和等也并以为对在将把从被让使很更最上下中内外]/g;

/**
 * Significant terms from a sentence without a domain dictionary.
 *
 * Strategy: delete connector characters and stop words, then cut the remaining
 * CJK runs into 4-character chunks (with a 2-3 character tail preserved).
 * Four characters is the dominant length of Chinese domain compounds
 * (临床数据, 数据管理, 医药行业), so chunking at 4 mostly lands on real words
 * rather than arbitrary fragments. This is a fallback for industries we have
 * not enumerated; the curated vocabulary handles the technical ones.
 */
export function deriveTerms(text: string): string[] {
  const out: string[] = [];
  const cleaned = toHalfWidth(text);

  // Remove multi-character stop words by replacing them with a separator, so
  // the text either side stays intact.
  let scrubbed = cleaned;
  for (const stop of [...STOP_WORDS].sort((a, b) => b.length - a.length)) {
    if (!/[\u4E00-\u9FFF]/.test(stop)) continue;
    scrubbed = scrubbed.split(stop).join("|");
  }
  scrubbed = scrubbed.replace(CJK_CONNECTORS, "|");

  for (const segment of scrubbed.split(/[^A-Za-z0-9+#.\u4E00-\u9FFF]+/)) {
    if (!segment) continue;
    const isCjk = /[\u4E00-\u9FFF]/.test(segment);
    if (!isCjk) {
      if (segment.length >= 2 && !STOP_WORDS.has(segment.toLowerCase())) out.push(segment);
      continue;
    }
    if (segment.length < 2) continue;
    if (segment.length <= 4) {
      out.push(segment);
      continue;
    }
    // Cut into 4-character chunks; keep a 2- or 3-character tail, drop a
    // meaningless single character.
    for (let i = 0; i < segment.length; i += 4) {
      const chunk = segment.slice(i, i + 4);
      if (chunk.length >= 2) out.push(chunk);
    }
  }

  // Drop terms that are contained in a longer accepted term.
  const sorted = unique(out).sort((a, b) => b.length - a.length);
  const kept: string[] = [];
  for (const term of sorted) {
    if (kept.some((existing) => existing.length > term.length && existing.includes(term))) continue;
    kept.push(term);
  }
  return kept.slice(0, 24);
}

/**
 * Degree / year requirements, which most postings state numerically and which
 * are the ones a candidate is most often filtered on.
 */
export interface HardRequirements {
  degrees: string[];
  minYears?: number;
  majors: string[];
  cities: string[];
  graduationYear?: { from?: number; to?: number };
}

export function extractHardRequirements(text: string): HardRequirements {
  const out: HardRequirements = { degrees: [], majors: [], cities: [] };
  const plain = tidy(text);

  for (const degree of ["博士", "硕士", "研究生", "本科", "学士", "大专", "专科"]) {
    if (containsTerm(plain, degree)) out.degrees.push(degree);
  }

  /*
   * "3 年以上后端开发经验" puts words between the unit and the noun, so the
   * match must allow a short gap. Requiring 经验 immediately after 以上 (the
   * obvious way to write this) silently misses most real postings.
   */
  const years = plain.match(/(\d+)\s*年(?:以上)?[^\n。；;，,]{0,12}?(?:经验|经历)/);
  if (years?.[1]) {
    const value = Number.parseInt(years[1], 10);
    if (Number.isFinite(value) && value < 40) out.minYears = value;
  }

  const majors = plain.match(/(?:专业|学科)[:：]?\s*([^\n。；;]{2,60})/);
  if (majors?.[1]) {
    out.majors = majors[1]
      .split(/[、,，/和及]/)
      .map((item) => item.trim())
      .filter((item) => item.length >= 2 && item.length <= 20);
  }

  for (const city of [
    "北京", "上海", "深圳", "广州", "杭州", "成都", "南京", "武汉", "西安", "苏州", "天津", "重庆",
    "长沙", "青岛", "合肥", "厦门", "郑州", "济南", "福州", "宁波", "无锡", "东莞", "佛山", "珠海",
    "大连", "沈阳", "哈尔滨", "长春", "昆明", "贵阳", "南昌", "太原", "石家庄", "兰州", "乌鲁木齐",
  ]) {
    if (plain.includes(city)) out.cities.push(city);
  }

  const gradYear = plain.match(/(20\d{2})\s*届?\s*(?:[-—~至到]\s*(20\d{2})\s*届?)?/);
  if (gradYear?.[1]) {
    const from = Number.parseInt(gradYear[1], 10);
    const to = gradYear[2] ? Number.parseInt(gradYear[2], 10) : from;
    if (Number.isFinite(from)) out.graduationYear = { from, to };
  }

  out.degrees = unique(out.degrees);
  out.cities = unique(out.cities);
  return out;
}

/** Split a posting into headed sections. */
function splitSections(text: string): Array<{ heading: string; body: string; kind?: string }> {
  const lines = toLines(text);
  const sections: Array<{ heading: string; body: string; kind?: string }> = [];
  let current: { heading: string; lines: string[]; kind?: string } | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    const isHeading =
      trimmed.length <= 24 &&
      JD_SECTIONS.some((section) => section.patterns.some((pattern) => pattern.test(trimmed)));

    if (isHeading) {
      if (current) sections.push({ heading: current.heading, body: current.lines.join("\n"), ...(current.kind ? { kind: current.kind } : {}) });
      const kind = JD_SECTIONS.find((section) => section.patterns.some((pattern) => pattern.test(trimmed)))?.kind;
      current = { heading: trimmed, lines: [], ...(kind ? { kind } : {}) };
      continue;
    }
    if (current) current.lines.push(trimmed);
    else {
      current = { heading: "", lines: [trimmed] };
    }
  }
  if (current) sections.push({ heading: current.heading, body: current.lines.join("\n"), ...(current.kind ? { kind: current.kind } : {}) });
  return sections.filter((section) => section.body.trim().length > 0);
}

/**
 * Break a requirements block into individual requirements. Chinese postings
 * mix bullets, numbered items, and plain line breaks.
 */
export function splitRequirements(body: string): string[] {
  /*
   * Requirements arrive as standalone lines, as bullets, or as one run-on
   * line ("1. 本科及以上学历；2. 精通 Go；• 熟悉 Redis"). Splitting on a
   * separator that is followed by *either* a CJK character or a list marker
   * covers all three; requiring a CJK character misses every numbered item.
   */
  const normalized = body
    .replace(/[；;]\s*(?=[\p{L}\u4E00-\u9FFF\d\u2022\u25CF\u25AA·•▪◦-])/gu, "\n")
    .replace(/\s+(?=\d+[.、)）]\s)/g, "\n")
    .replace(/\s+(?=[\u2022\u25CF\u25AA·•▪◦-]\s)/g, "\n");
  const lines = toLines(normalized);
  const out: string[] = [];
  for (const line of lines) {
    const cleaned = line
      .replace(/^[\d]+[.、)）]\s*/, "")
      .replace(/^[\u2022\u25CF\u25AA·•▪◦-]\s*/, "")
      .trim();
    if (cleaned.length < 4) continue;
    // Extremely long paragraphs get split on sentence boundaries.
    if (cleaned.length > 120) {
      out.push(
        ...cleaned
          .split(/(?<=[。；;])\s*/)
          .map((part) => part.trim())
          .filter((part) => part.length >= 4),
      );
    } else {
      out.push(cleaned);
    }
  }
  return unique(out);
}

export function analyzeJd(
  text: string,
  meta: { company?: string; role?: string; city?: string; jdDocumentId?: string; id?: string } = {},
): JdAnalysis {
  const sections = splitSections(text);
  const requirementSections = sections.filter(
    (section) => section.kind === "requirements" || section.kind === "preferred",
  );
  const responsibilities = sections.filter((section) => section.kind === "responsibilities");

  /*
   * Track which kind of block each requirement came from. A line under 加分项
   * is a nice-to-have *because of where it sits*, even when its wording ("熟悉
   * Flink") looks mandatory. Relying on phrasing alone marked every bonus item
   * as a hard requirement.
   */
  const sourced: Array<{ text: string; kind: string | undefined }> = requirementSections.flatMap((section) =>
    splitRequirements(section.body).map((item) => ({ text: item, kind: section.kind })),
  );
  if (sourced.length === 0) {
    // No headings at all: responsibility lines carry the keywords either way.
    sourced.push(
      ...responsibilities.flatMap((section) =>
        splitRequirements(section.body).map((item) => ({ text: item, kind: undefined })),
      ),
    );
  }
  const requirementTexts = unique(sourced.map((item) => item.text));
  const kindByText = new Map(sourced.map((item) => [item.text, item.kind]));

  const hard = extractHardRequirements(text);
  const requirements = requirementTexts.map((requirement) => {
    const { keywords, derived: derivedKeywords } = extractKeywords(requirement);
    const kind = kindByText.get(requirement);
    const fromPreferred = kind === "preferred";
    const soft = isSoftRequirement(requirement);
    const softened =
      fromPreferred ||
      NICE_TO_HAVE.some((marker) => requirement.toLowerCase().includes(marker.toLowerCase()));

    /*
     * A line's *position* is the primary signal for whether it is mandatory:
     * everything under 任职要求 is required unless it says otherwise, and
     * everything under 加分项 is optional regardless of how it is worded.
     * Phrasing is only consulted when the posting has no headings at all —
     * otherwise "熟悉 Kubernetes" (mandatory) and "熟悉 Flink" (a bonus) are
     * indistinguishable, which is exactly the mistake this replaces.
     */
    const mustHave = !soft && !softened && isMandatoryByPosition(kind, requirement);

    let weight = 2;
    if (mustHave) weight = 3;
    if (softened) weight = 1;
    // Requirements mentioning a hard constraint (degree, years, city) matter
    // more than generic soft-skill lines.
    if (/\d+\s*年|学历|本科|硕士|博士|专业|证书/.test(requirement)) weight = Math.min(3, weight + 1);
    if (keywords.length >= 3) weight = Math.min(3, weight + 1);

    return {
      text: requirement,
      keywords,
      weight,
      mustHave: mustHave && !softened,
      soft,
      derivedKeywords,
    };
  });

  // Ensure the hard requirements appear as requirement entries even when the
  // posting buried them in prose.
  if (hard.degrees.length > 0 && !requirements.some((item) => item.text.includes("学历"))) {
    requirements.push({
      text: `学历要求：${hard.degrees.join(" / ")}`,
      keywords: hard.degrees,
      weight: 3,
      mustHave: true,
      soft: false,
      derivedKeywords: false,
    });
  }
  /*
   * A stated year count is deliberately *not* added as a synthesized
   * requirement. `analyzeGaps` evaluates it against the dates in the profile,
   * which is the only honest way to answer it; leaving a fake "3 年及以上"
   * entry here would double-count it as an unmatched keyword.
   */

  const role = meta.role ?? guessRole(text) ?? "未标注岗位";

  return {
    id: meta.id ?? `jd-${Date.now().toString(36)}`,
    ...(meta.jdDocumentId ? { jdDocumentId: meta.jdDocumentId } : {}),
    ...(meta.company ? { company: meta.company } : {}),
    role,
    ...(meta.city ?? hard.cities[0] ? { city: meta.city ?? hard.cities[0] } : {}),
    requirements,
    ...(hard.minYears !== undefined ? { minYears: hard.minYears } : {}),
    degrees: hard.degrees,
    keywords: unique(requirements.flatMap((item) => item.keywords)),
    sections: sections.map((section) => ({ heading: section.heading, body: section.body })),
    createdAt: Date.now(),
  };
}

function isMustHave(requirement: string): boolean {
  const lower = requirement.toLowerCase();
  if (NICE_TO_HAVE.some((marker) => lower.includes(marker.toLowerCase()))) return false;
  return MUST_HAVE.some((marker) => lower.includes(marker.toLowerCase())) || /^\s*\d/.test(requirement);
}

/**
 * Behavioural expectations that a resume cannot prove.
 *
 * "具备良好的沟通能力与团队协作精神" is on virtually every posting and is
 * verified in an interview, not by a bullet point. Treating it as a blocking
 * gap would drown the real, actionable gaps in noise.
 */
const SOFT_MARKERS = [
  "沟通能力", "沟通表达", "团队协作", "团队合作", "协作精神", "协作能力", "抗压能力", "责任心",
  "学习能力", "逻辑思维", "表达能力强", "积极主动", "自我驱动", "ownership", "leadership",
  "communication", "team player", "interpersonal", "collaboration", "self-motivated", "proactive",
  "problem solving", "critical thinking", "detail-oriented", "passionate",
];

function isSoftRequirement(requirement: string): boolean {
  const lower = requirement.toLowerCase();
  return SOFT_MARKERS.some((marker) => lower.includes(marker.toLowerCase()));
}

/**
 * Does this line belong in the "must have" set?
 *
 * Position within the posting is the primary signal:
 *  - under 任职要求  → required
 *  - under 加分项    → optional, however it is worded
 *  - no headings     → fall back to phrasing
 */
function isMandatoryByPosition(kind: string | undefined, requirement: string): boolean {
  if (kind === "requirements") return true;
  if (kind === "preferred") return false;
  return isMustHave(requirement);
}

/** Best-effort job title from the posting's first lines or a labelled field. */
function guessRole(text: string): string | undefined {
  const lines = toLines(text).slice(0, 8);
  for (const line of lines) {
    const labelled = line.match(/(?:岗位|职位|招聘职位|position|job title)[:：]\s*(.{2,30})/i);
    if (labelled?.[1]) return labelled[1].trim();
  }
  const first = lines[0];
  if (first && /(工程师|经理|专员|主管|设计师|开发|运营|分析|顾问|助理|实习生|研究员|招聘|产品|测试|teacher|engineer|manager|analyst|designer|developer|intern|specialist)/i.test(first)) {
    return first.replace(/[（(].*?[)）]/g, "").trim().slice(0, 40);
  }
  return undefined;
}

/** Extract city from a raw posting when it is stated as a field. */
export function guessCompanyAndCity(text: string): { company?: string; city?: string } {
  const out: { company?: string; city?: string } = {};
  const company = text.match(/(?:公司|企业|雇主|company|employer)[:：]\s*([^\n|｜]{2,40})/i);
  if (company?.[1]) out.company = company[1].trim();
  const city = text.match(/(?:工作地点|办公地点|所在地|location|city)[:：]\s*([^\n|｜]{2,20})/i);
  if (city?.[1]) out.city = city[1].trim();
  return out;
}
