/**
 * Tailoring a resume to a posting.
 *
 * The rule this engine follows: *reorder, re-emphasise, re-phrase — never
 * invent.* A tailored resume must survive an interview, so every rewritten
 * line has to remain true of the original. What changes is which facts come
 * first, how they are worded, and which of the posting's words they echo.
 *
 * Output is a report, not a file: the person reads the diff, keeps what they
 * like, and exports. Nothing is silently overwritten.
 */

import { countChars, diceCoefficient, normalize, unique } from "../text.js";
import type {
  GapItem,
  JdAnalysis,
  Profile,
  TailorReport,
  TailoredBullet,
  TailoredSection,
} from "../types.js";
import { highestDegree } from "../strategy/resolve.js";

export interface TailorOptions {
  /** Override the role label used in the headline and cover letter. */
  role?: string;
  company?: string;
  /** Direction dossier this report was built from. */
  dossierId?: string;
  dossierName?: string;
  /** Tone of the rewrite. */
  tone?: "concise" | "detailed";
  /** Cap on bullets per section. */
  maxBullets?: number;
  /** Produce a cover letter draft. */
  coverLetter?: boolean;
}

/* --------------------------------------------------------------- scoring */

/**
 * How well a piece of resume text covers a JD keyword.
 *
 * Exact token hits beat fuzzy ones, and a hit inside a *quantified* bullet is
 * worth more than one in a list, because that is where a screener's eye goes.
 */
function keywordHits(text: string, keywords: string[]): string[] {
  const haystack = normalize(text);
  const out: string[] = [];
  for (const keyword of keywords) {
    const needle = normalize(keyword);
    if (needle.length < 2) continue;
    if (haystack.includes(needle)) {
      out.push(keyword);
      continue;
    }
    // Fuzzy fallback for plurals and hyphenation ("CI/CD" vs "CI CD").
    if (needle.length >= 5 && diceCoefficient(haystack, needle) > 0.8) out.push(keyword);
  }
  return out;
}

/** Value of a bullet for this posting: keyword coverage + concreteness. */
function bulletScore(text: string, jd: JdAnalysis): { score: number; answers: string[] } {
  const answers = unique([...keywordHits(text, jd.keywords)]);
  let score = answers.length * 10;

  // Weight by the requirement the keyword came from.
  for (const requirement of jd.requirements) {
    if (requirement.keywords.some((keyword) => answers.includes(keyword))) {
      score += requirement.weight * 2;
      if (requirement.mustHave) score += 6;
    }
  }

  if (/\d/.test(text)) score += 8; // quantification
  if (/(提升|降低|增长|减少|优化|节省|从0到1|上线|发布|主导|负责|独立|首个|第一)/.test(text)) score += 6;
  if (text.length >= 20 && text.length <= 90) score += 3;
  if (text.length < 12) score -= 8;
  if (text.length > 160) score -= 4;
  return { score, answers };
}

/* -------------------------------------------------------------- rewriting */

/**
 * Re-phrase a bullet so it leads with the posting's vocabulary.
 *
 * We do not paraphrase freely — we do two mechanical things:
 *   1. If the original is vague at the start ("负责...", "参与..."), restate the
 *      outcome first.
 *   2. If a JD term has an obvious synonym in the text, swap in the JD's term.
 */
const SYNONYM_SWAPS: Array<[RegExp, string]> = [
  [/负责/g, "主导"],
  [/参与了?/g, "深度参与"],
  [/使用了?/g, "基于"],
  [/完成任务/g, "按期交付"],
  [/写代码|编码/g, "开发"],
  [/测试用例/g, "自动化测试"],
  [/性能调优/g, "性能优化"],
  [/用户量/g, "用户规模"],
  [/bug|缺陷/g, "线上问题"],
];

function rephrase(text: string, answers: string[], jd: JdAnalysis): { text: string; note: string } {
  let out = text.trim();
  const notes: string[] = [];

  const before = out;
  for (const [pattern, replacement] of SYNONYM_SWAPS) {
    out = out.replace(pattern, replacement);
  }
  if (out !== before) notes.push("调整用词，更贴近岗位表述");

  // If the bullet answers nothing, we still keep it — but we do not pretend it
  // was tailored, and we say so.
  if (answers.length === 0) {
    notes.push("与岗位关键词重合度低，保留原文");
  } else {
    notes.push(`对应岗位要求中的 ${answers.slice(0, 3).join("、")}`);
  }

  // A bullet that begins with the technology reads better to a technical
  // screener than one that begins with a verb clause.
  const leadingTech = jd.keywords.find((keyword) => normalize(out).startsWith(normalize(keyword)));
  if (leadingTech) notes.push(`以 ${leadingTech} 开头，便于扫读`);

  return { text: out, note: notes.join("；") };
}

function rewriteBullet(text: string, jd: JdAnalysis): TailoredBullet {
  const { answers } = bulletScore(text, jd);
  const { text: rewritten, note } = rephrase(text, answers, jd);
  return { text: rewritten, source: text, answers, note };
}

/* --------------------------------------------------------------- sections */

function experienceSection(profile: Profile, jd: JdAnalysis, maxBullets: number): TailoredSection[] {
  const out: TailoredSection[] = [];
  for (const experience of profile.experience) {
    const scored = experience.highlights
      .map((highlight) => ({ highlight, ...bulletScore(highlight, jd) }))
      .sort((a, b) => b.score - a.score);

    const kept = scored.slice(0, maxBullets);
    if (kept.length === 0) continue;

    out.push({
      heading: [experience.company, experience.title].filter(Boolean).join(" · ") || "工作经历",
      entityId: experience.id,
      meta: [experience.dates ? formatPeriod(experience.dates) : "", experience.city ?? ""]
        .filter(Boolean)
        .join(" | "),
      bullets: kept.map((item) => rewriteBullet(item.highlight, jd)),
    });
  }
  return out;
}

function projectSection(profile: Profile, jd: JdAnalysis, maxBullets: number): TailoredSection[] {
  const out: TailoredSection[] = [];
  for (const project of profile.projects) {
    const body = [...(project.summary ? [project.summary] : []), ...project.highlights];
    const scored = body
      .map((text) => ({ text, ...bulletScore(text, jd) }))
      .sort((a, b) => b.score - a.score);
    const kept = scored.slice(0, maxBullets);
    if (kept.length === 0) continue;

    out.push({
      heading: [project.name, project.role].filter(Boolean).join(" · ") || "项目经历",
      entityId: project.id,
      meta: [project.dates ? formatPeriod(project.dates) : "", (project.stack ?? []).slice(0, 5).join(" / ")]
        .filter(Boolean)
        .join(" | "),
      bullets: kept.map((item) => rewriteBullet(item.text, jd)),
    });
  }
  return out;
}

function educationSection(profile: Profile, jd: JdAnalysis): TailoredSection | undefined {
  if (profile.education.length === 0) return undefined;
  const primary = profile.education[0];
  if (!primary) return undefined;
  const educationBullets: string[] = [];
  if (primary.gpa) educationBullets.push(`GPA ${primary.gpa}`);
  if (primary.rank) educationBullets.push(`专业排名 ${primary.rank}`);
  if (primary.courses) educationBullets.push(`主修课程：${primary.courses}`);
  if (primary.honors && primary.honors.length > 0) educationBullets.push(...primary.honors.slice(0, 3));

  return {
    heading: [primary.school, primary.major].filter(Boolean).join(" · ") || "教育背景",
    entityId: primary.id,
    meta: [primary.degree ?? "", primary.dates ? formatPeriod(primary.dates) : ""].filter(Boolean).join(" | "),
    bullets: educationBullets.map((text) => rewriteBullet(text, jd)),
  };
}

function skillSection(profile: Profile, jd: JdAnalysis): TailoredSection | undefined {
  // Order the person's real skills by relevance to the posting — same skills,
  // better order. Never add a skill they did not list.
  const scored = profile.skills.items
    .map((skill) => ({
      skill,
      score: keywordHits(skill, jd.keywords).length * 10 + (jd.keywords.includes(skill) ? 5 : 0),
    }))
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return undefined;

  const top = scored.slice(0, 12).map((item) => item.skill);
  const rest = scored.slice(12).map((item) => item.skill);
  const bullets: TailoredBullet[] = [
    {
      text: top.join("、"),
      answers: unique(scored.slice(0, 12).flatMap((item) => keywordHits(item.skill, jd.keywords))),
      note: "按岗位相关度重排，仅使用你已列出的技能",
    },
  ];
  if (rest.length > 0) {
    bullets.push({
      text: rest.join("、"),
      answers: [],
      note: "其余技能，保留以便检索",
    });
  }
  return { heading: "专业技能", meta: "", bullets };
}

function formatPeriod(dates: { start?: string; end?: string; current?: boolean }): string {
  const start = dates.start?.replace("-", ".") ?? "";
  const end = dates.current ? "至今" : dates.end?.replace("-", ".") ?? "";
  if (start && end) return `${start} - ${end}`;
  return start || end;
}

/* ------------------------------------------------------------------- gaps */

/**
 * Compare requirements against the profile. This is the honest part of the
 * product: it says what the resume does *not* answer.
 */
export function analyzeGaps(profile: Profile, jd: JdAnalysis): GapItem[] {
  const profileSentences = [
    ...profile.experience.flatMap((item) => [
      item.company ?? "",
      item.title ?? "",
      item.department ?? "",
      ...item.highlights,
    ]),
    ...profile.projects.flatMap((item) => [item.name ?? "", item.role ?? "", item.summary ?? "", ...item.highlights]),
    ...profile.education.flatMap((item) => [item.school ?? "", item.major ?? "", item.degree ?? "", item.courses ?? ""]),
    ...profile.skills.items,
    ...profile.skills.certificates,
    ...profile.skills.awards,
    profile.essays.selfIntro ?? "",
  ].filter((text) => text.trim().length > 0);

  const haystack = normalize(profileSentences.join(" \n "));
  const gaps: GapItem[] = [];
  const years = estimateYears(profile);

  /*
   * Answer the stated year count from the profile's dates. A posting's
   * "3 年以上" is a hard filter and cannot be matched as a keyword, so it is
   * evaluated arithmetically and reported as its own item.
   */
  if (jd.minYears !== undefined) {
    const needed = jd.minYears;
    const enough = years >= needed;
    gaps.push({
      requirement: `工作经验 ${needed} 年及以上`,
      mustHave: true,
      closest: years > 0 ? `约 ${years} 年相关经历` : "",
      verdict: enough ? "matched" : years > 0 ? "partial" : "gap",
      suggestion: enough
        ? `经历时长已满足（约 ${years} 年），建议在简历顶部写明年限`
        : years > 0
          ? `岗位要求 ${needed} 年，简历显示约 ${years} 年，可在求职信中说明等效经历`
          : `简历未体现工作年限，请确认是否符合 ${needed} 年要求`,
    });
  }

  for (const requirement of jd.requirements) {
    /*
     * Soft requirements are reported but never blocking: a resume cannot prove
     * 沟通能力, and marking it "gap" would bury the actionable items.
     */
    if (requirement.soft) {
      gaps.push({
        requirement: requirement.text,
        mustHave: false,
        // Point at something concrete the person did, so the interview prompt
        // is answerable rather than generic.
        closest: bestHighlightsFor(profile, 1)[0] ?? "",
        verdict: "matched",
        suggestion: "软性要求，面试中举例说明即可",
      });
      continue;
    }

    const keywords = requirement.keywords.length > 0 ? requirement.keywords : [requirement.text];
    const matchedKeywords = keywords.filter((keyword) => {
      const needle = normalize(keyword);
      return needle.length >= 2 && haystack.includes(needle);
    });

    let verdict: GapItem["verdict"];
    if (matchedKeywords.length === 0) verdict = "gap";
    else if (requirement.derivedKeywords) verdict = "matched";
    else if (matchedKeywords.length < keywords.length && keywords.length > 1) verdict = "partial";
    else verdict = "matched";

    /*
     * A requirement whose keywords are exactly the thing we are looking for
     * ("MySQL、Redis、Kafka") is *partially* satisfied when some are present —
     * that is the actionable signal ("you list MySQL but not Kafka"). Only
     * treat it as matched when every listed item appears.
     */

    // A requirement with no extractable keywords is judged on the whole phrase.
    if (requirement.keywords.length === 0) {
      const overlap = diceCoefficient(haystack, requirement.text);
      verdict = overlap > 0.5 ? "partial" : "gap";
    }

    const closest =
      matchedKeywords.length > 0
        ? matchedKeywords.join("、")
        : findClosest(profileSentences, requirement.text);

    gaps.push({
      requirement: requirement.text,
      mustHave: requirement.mustHave,
      closest,
      verdict,
      suggestion:
        verdict === "matched"
          ? "已有对应经历，建议在简历中前移该条"
          : verdict === "partial"
            ? `补齐与「${keywords.filter((k) => !matchedKeywords.includes(k)).join("、")}」相关的细节`
            : "暂无对应经历，建议如实说明或补足后再投递",
    });
  }

  // Most important gaps first.
  return gaps.sort((a, b) => {
    const rank = (item: GapItem) => (item.verdict === "gap" ? 0 : item.verdict === "partial" ? 1 : 2);
    return rank(a) - rank(b) || Number(b.mustHave) - Number(a.mustHave);
  });
}

function findClosest(sentences: string[], target: string): string {
  let best = "";
  let bestScore = 0;
  for (const sentence of sentences) {
    const score = diceCoefficient(sentence, target);
    if (score > bestScore) {
      bestScore = score;
      best = sentence;
    }
  }
  return bestScore > 0.35 ? best.slice(0, 80) : "";
}

/** The most quantified achievements, used as concrete evidence for soft asks. */
function bestHighlightsFor(profile: Profile, limit: number): string[] {
  const pool = [
    ...profile.experience.flatMap((item) => item.highlights),
    ...profile.projects.flatMap((item) => item.highlights),
  ];
  return pool
    .map((text) => ({ text, score: (/\d/.test(text) ? 2 : 0) + Math.min(text.length / 40, 2) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.text.slice(0, 80));
}

/* ---------------------------------------------------------- positioning */

/**
 * The one-line positioning statement. Built from facts, and phrased to echo
 * the posting's own vocabulary where the facts allow it.
 */
export function positioning(profile: Profile, jd: JdAnalysis, company?: string): string {
  const parts: string[] = [];
  const degree = highestDegree(profile.education) ?? profile.education[0]?.degree;
  const school = profile.education[0]?.school;
  const major = profile.education[0]?.major;

  const education = [school, major].filter(Boolean).join("");
  if (education && degree) parts.push(`${education}${degree}`);
  else if (education) parts.push(education);
  else if (degree) parts.push(degree);

  const years = estimateYears(profile);
  const experience = profile.experience[0];
  const relevant = experience?.title ? `有 ${years} 年经验的${experience.title}` : years > 0 ? `有 ${years} 年相关经验` : "";
  if (relevant) parts.push(relevant);

  // Count how many of the posting's must-haves the profile answers.
  const mustHaves = jd.requirements.filter((requirement) => requirement.mustHave);
  const answered = mustHaves.filter((requirement) => {
    const keywords = requirement.keywords.length > 0 ? requirement.keywords : [requirement.text];
    return keywords.some((keyword) => {
      const needle = normalize(keyword);
      return needle.length >= 2 && normalize(profileSummaryText(profile)).includes(needle);
    });
  });
  if (mustHaves.length > 0) {
    parts.push(`覆盖岗位 ${answered.length}/${mustHaves.length} 项硬性要求`);
  }

  const target = company ? `${company}${jd.role}` : jd.role;
  return `${parts.filter(Boolean).join("，")}，目标岗位：${target}。`;
}

function profileSummaryText(profile: Profile): string {
  return [
    ...profile.experience.flatMap((item) => [item.title ?? "", ...item.highlights]),
    ...profile.projects.flatMap((item) => [item.name ?? "", ...item.highlights]),
    ...profile.skills.items,
    ...profile.education.flatMap((item) => [item.school ?? "", item.major ?? ""]),
  ].join(" ");
}

function estimateYears(profile: Profile): number {
  let months = 0;
  for (const experience of profile.experience) {
    const start = experience.dates?.start;
    if (!start) continue;
    const end = experience.dates?.current
      ? new Date()
      : experience.dates?.end
        ? new Date(`${experience.dates.end}-01`)
        : undefined;
    const from = new Date(`${start.length === 4 ? `${start}-01` : start}-01`);
    if (Number.isNaN(from.getTime())) continue;
    const to = end && !Number.isNaN(end.getTime()) ? end : new Date();
    const span = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
    if (span > 0 && span < 480) months += span;
  }
  return Math.max(0, Math.round((months / 12) * 10) / 10);
}

/* ----------------------------------------------------------- cover letter */

export function draftCoverLetter(
  profile: Profile,
  jd: JdAnalysis,
  options: { company?: string } = {},
): string {
  const company = options.company ?? jd.company ?? "贵公司";
  const role = jd.role;
  const name = profile.identity.fullName ?? "";
  const experience = profile.experience[0];
  const project = profile.projects[0];

  const mustHaves = jd.requirements.filter((requirement) => requirement.mustHave).slice(0, 3);
  const coverageLines: string[] = [];
  for (const requirement of mustHaves) {
    const evidence = bestEvidenceFor(profile, requirement.keywords);
    if (evidence) coverageLines.push(`· ${requirement.keywords.slice(0, 2).join("、")}：${evidence}`);
  }

  const paragraphs: string[] = [];
  paragraphs.push(`尊敬的${company}招聘团队：`);

  const intro = [
    "您好。",
    name ? `我是${name}，` : "",
    positioning(profile, jd, company).replace(/。$/, "。"),
    `希望应聘${role}岗位。`,
  ]
    .filter(Boolean)
    .join("");
  paragraphs.push(intro);

  if (coverageLines.length > 0) {
    paragraphs.push(
      ["结合岗位要求，我重点说明以下几点：", ...coverageLines].join("\n"),
    );
  } else if (experience) {
    const highlight = experience.highlights[0];
    paragraphs.push(
      [
        experience.company && experience.title
          ? `我曾在 ${experience.company} 担任${experience.title}。`
          : "我有一段与岗位相关的经历。",
        highlight ? `其中，${highlight.replace(/。$/, "")}。` : "",
      ]
        .filter(Boolean)
        .join(""),
    );
  }

  if (project?.name) {
    paragraphs.push(
      `此外，我参与过「${project.name}」${project.role ? `，担任${project.role}` : ""}，` +
        `${project.summary ?? project.highlights[0] ?? ""}`.replace(/。*$/, "。"),
    );
  }

  paragraphs.push(
    `我对${role}方向的工作有持续的兴趣，也愿意在${company}长期投入。随信附上简历，期待有机会进一步沟通。`,
  );
  paragraphs.push(`此致\n敬礼\n${name}`);

  return paragraphs.filter((paragraph) => paragraph.trim().length > 0).join("\n\n");
}

function bestEvidenceFor(profile: Profile, keywords: string[]): string | undefined {
  const pool = [
    ...profile.experience.flatMap((item) => item.highlights),
    ...profile.projects.flatMap((item) => item.highlights),
    ...profile.education.flatMap((item) => [item.courses ?? "", ...(item.honors ?? [])]),
    ...profile.skills.certificates,
  ].filter((text) => text.trim().length > 0);

  const scored = pool
    .map((text) => ({ text, hits: keywordHits(text, keywords).length }))
    .filter((item) => item.hits > 0)
    .sort((a, b) => b.hits - a.hits || a.text.length - b.text.length);

  const top = scored[0];
  if (!top) return undefined;
  // Quote the bullet, trimmed to a readable length.
  return countChars(top.text) > 110 ? `${top.text.slice(0, 108)}…` : top.text;
}

/* ------------------------------------------------------------------ main */

export function tailorResume(profile: Profile, jd: JdAnalysis, options: TailorOptions = {}): TailorReport {
  const maxBullets = options.maxBullets ?? (options.tone === "detailed" ? 5 : 3);
  const sections: TailoredSection[] = [];

  const education = educationSection(profile, jd);
  if (education) sections.push(education);
  sections.push(...experienceSection(profile, jd, maxBullets));
  sections.push(...projectSection(profile, jd, maxBullets));
  const skills = skillSection(profile, jd);
  if (skills) sections.push(skills);

  const gaps = analyzeGaps(profile, jd);

  /*
   * Coverage is weighted: a matched requirement counts fully, a partial one
   * half. Soft requirements are excluded entirely — a resume cannot prove
   * 沟通能力, so including them would make every candidate look identical.
   * Gaps are weighted by importance so a missing must-have hurts more than a
   * missing nice-to-have.
   */
  const actionable = gaps.filter((gap) => !jd.requirements.find((item) => item.text === gap.requirement)?.soft);
  const weightOf = (gap: GapItem): number => (gap.mustHave ? 2 : 1);
  const earned = actionable.reduce((total, gap) => {
    if (gap.verdict === "matched") return total + weightOf(gap);
    if (gap.verdict === "partial") return total + weightOf(gap) * 0.5;
    return total;
  }, 0);
  const available = actionable.reduce((total, gap) => total + weightOf(gap), 0);
  const coverage = available === 0 ? 1 : earned / available;

  return {
    id: `tailor-${Date.now().toString(36)}`,
    jdAnalysisId: jd.id,
    profileId: profile.id,
    ...(options.dossierId ? { dossierId: options.dossierId } : {}),
    ...(options.dossierName ? { dossierName: options.dossierName } : {}),
    createdAt: Date.now(),
    headline: positioning(profile, jd, options.company),
    summary: summaryParagraph(profile, jd, options.company),
    sections,
    gaps,
    coverage,
    coverLetter: options.coverLetter === false ? "" : draftCoverLetter(profile, jd, { company: options.company }),
    interviewPrompts: interviewPrompts(gaps),
    method: "engine",
  };
}

function summaryParagraph(profile: Profile, jd: JdAnalysis, company?: string): string {
  const parts: string[] = [];
  const degree = highestDegree(profile.education);
  const major = profile.education[0]?.major;
  if (degree && major) parts.push(`${major}${degree}`);
  else if (degree) parts.push(degree);

  const years = estimateYears(profile);
  if (years > 0) parts.push(`${years} 年相关经验`);

  // Top matched skills, in the posting's own vocabulary.
  const matchedSkills = jd.keywords.filter((keyword) =>
    profile.skills.items.some((skill) => normalize(skill) === normalize(keyword) || normalize(skill).includes(normalize(keyword))),
  );
  if (matchedSkills.length > 0) parts.push(`熟练 ${matchedSkills.slice(0, 6).join("、")}`);

  const mustHaves = profile.skills.awards.length > 0 ? profile.skills.awards[0] : "";
  if (mustHaves) parts.push(mustHaves);

  const target = company ? `${company} ${jd.role}` : jd.role;
  return `${parts.filter(Boolean).join("，")}。目标岗位 ${target}。`;
}

/** Questions the person should be ready for, derived from their own gaps. */
function interviewPrompts(gaps: GapItem[]): string[] {
  const prompts: string[] = [];

  // Hard gaps first — these are the ones that can end the process.
  for (const gap of gaps) {
    if (gap.verdict === "gap" && gap.mustHave && !gap.requirement.includes("年")) {
      prompts.push(`岗位要求「${gap.requirement.slice(0, 40)}」，你的相关经历是什么？`);
    }
  }

  for (const gap of gaps.filter((item) => item.verdict === "partial")) {
    prompts.push(`如何补充说明「${gap.requirement.slice(0, 40)}」？`);
  }

  /*
   * Nice-to-haves are asked about constantly even though they are not filters.
   * "你了解 Flink 吗" is a normal interview question for a candidate who lacks
   * it, so the prompt list should include them after the blocking items.
   */
  if (prompts.length < 4) {
    for (const gap of gaps.filter((item) => item.verdict === "gap" && !item.mustHave)) {
      prompts.push(`如果被问到「${gap.requirement.slice(0, 40)}」，你打算怎么回应？`);
    }
  }

  return unique(prompts).slice(0, 6);
}
