/**
 * Composing long-form answers from resume material.
 *
 * This is *assembly*, not generation. Every sentence is built from a fact that
 * already exists in the profile, and the UI labels the result as 整理生成 so
 * the person knows to read it before submitting. If there is not enough
 * material, we return nothing rather than padding with generic filler — an
 * empty field the person fills honestly beats a plausible-sounding invention.
 */

import { formatRange, unique, countChars } from "../text.js";
import type { Education, Experience, Profile, Project } from "../types.js";

export interface ComposeContext {
  pageRole?: string;
  company?: string;
}

const COMPOSABLE = new Set([
  "essay.selfIntro",
  "essay.whyCompany",
  "essay.whyRole",
  "essay.strengths",
  "essay.careerPlan",
  "essay.achievement",
  "essay.challenge",
  "essay.hobby",
  "essay.aiTools",
  "essay.aiProjects",
  "essay.additional",
]);

export function isComposableKey(key: string): boolean {
  return COMPOSABLE.has(key);
}

/** Highest education entry by recency of end date, then by degree level. */
function primaryEducation(profile: Profile): Education | undefined {
  if (profile.education.length === 0) return undefined;
  const order = ["博士", "硕士", "MBA", "本科", "学士", "大专", "专科", "中专", "高中"];
  return [...profile.education].sort((a, b) => {
    const rankA = order.findIndex((level) => a.degree?.includes(level));
    const rankB = order.findIndex((level) => b.degree?.includes(level));
    const safeA = rankA === -1 ? 99 : rankA;
    const safeB = rankB === -1 ? 99 : rankB;
    if (safeA !== safeB) return safeA - safeB;
    return (b.dates?.end ?? "").localeCompare(a.dates?.end ?? "");
  })[0];
}

/** The most recent experience, preferring ones with a title. */
function primaryExperience(profile: Profile): Experience | undefined {
  return profile.experience[0];
}

function degreePhrase(education: Education | undefined): string {
  if (!education) return "";
  const degree = education.degree?.replace(/研究生$/, "") ?? "";
  const school = education.school ?? "";
  const major = education.major ?? "";
  if (school && major && degree) return `${school}${major}${degree}`;
  if (school && degree) return `${school}${degree}`;
  if (major && degree) return `${major}${degree}`;
  return school || major || degree;
}

/** Pick concise, concrete highlights: numbers first, then longest. */
function bestHighlights(highlights: string[], limit: number): string[] {
  const scored = highlights
    .map((text) => {
      const cleaned = text.replace(/^[\s\u2022\u25CF\u25AA·•▪◦]+/, "").trim();
      let score = cleaned.length;
      if (/\d/.test(cleaned)) score += 40; // quantification is what recruiters read
      if (/(提升|降低|增长|优化|主导|独立|从0到1|发布|上线|第一|首个)/.test(cleaned)) score += 25;
      if (cleaned.length < 8) score -= 30;
      if (cleaned.length > 120) score -= 20;
      return { cleaned, score };
    })
    .filter((item) => item.cleaned.length >= 6);

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.cleaned);
}

function joinSentences(parts: string[]): string {
  return parts.filter((part) => part.trim().length > 0).join(" ");
}

/** Ensure a sentence ends with punctuation, without double-punctuating. */
function terminate(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return /[。！？.!?；;]$/.test(trimmed) ? trimmed : `${trimmed}。`;
}

/**
 * AI tools and models we can recognise by name.
 *
 * Employers now ask “请列出你常用的 AI 工具&模型” as its own required question
 * (Tencent's AI应用技能 section does). The answer has to come from the person's
 * own material, so this only ever reports names that literally appear in the
 * resume or a project — never a generic “ChatGPT 等”.
 */
const AI_TOOL_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "GitHub Copilot", pattern: /github\s*copilot/i },
  { name: "Claude Code", pattern: /claude\s*code/i },
  { name: "Claude", pattern: /claude/i },
  { name: "Cursor", pattern: /cursor/i },
  { name: "ChatGPT", pattern: /chatgpt/i },
  { name: "GPT", pattern: /\bgpt(?:[-\s]?\d+(?:\.\d+)?)?\b/i },
  { name: "Gemini", pattern: /gemini/i },
  { name: "DeepSeek", pattern: /deepseek/i },
  { name: "Coze", pattern: /coze/i },
  { name: "Dify", pattern: /dify/i },
  { name: "Midjourney", pattern: /midjourney/i },
  { name: "Stable Diffusion", pattern: /stable\s*diffusion/i },
  { name: "Windsurf", pattern: /windsurf/i },
  { name: "Cline", pattern: /cline/i },
  { name: "Trae", pattern: /trae/i },
  { name: "通义千问", pattern: /通义千问|通义/i },
  { name: "文心一言", pattern: /文心一言|文心/i },
  { name: "豆包", pattern: /豆包/i },
  { name: "Kimi", pattern: /\bkimi\b/i },
  { name: "智谱清言", pattern: /智谱|chatglm/i },
  { name: "腾讯混元", pattern: /混元/i },
  { name: "讯飞星火", pattern: /讯飞星火|星火/i },
  { name: "Perplexity", pattern: /perplexity/i },
  { name: "Codex", pattern: /\bcodex\b/i },
];

function aiToolsIn(texts: string[]): string[] {
  const found: string[] = [];
  for (const text of texts) {
    if (!text) continue;
    for (const tool of AI_TOOL_PATTERNS) {
      // “ChatGPT” already names the model; adding “GPT” beside it is noise.
      if (tool.name === "GPT" && /chatgpt/i.test(text)) continue;
      if (tool.pattern.test(text) && !found.includes(tool.name)) found.push(tool.name);
    }
  }
  return found;
}

function projectText(project: Project): string {
  return [project.name, project.summary, ...(project.stack ?? []), ...project.highlights]
    .filter((part): part is string => Boolean(part))
    .join(" ");
}

/** Does this project actually involve AI, or just contain the letters “ai”? */
const AI_PROJECT_PATTERN =
  /(人工智能|\bai\b|\bllm\b|大模型|语言模型|机器学习|深度学习|chatgpt|claude|copilot|deepseek|cursor|coze|dify|rag|prompt|模型微调|智能体)/i;

function collectProfileAiTools(profile: Profile): string[] {
  return aiToolsIn([
    ...profile.skills.items,
    ...profile.projects.flatMap((item) => [
      item.name ?? "",
      item.summary ?? "",
      ...(item.stack ?? []),
      ...item.highlights,
    ]),
    ...profile.experience.flatMap((item) => [
      item.company ?? "",
      item.title ?? "",
      ...item.highlights,
    ]),
  ]);
}

/**
 * Compose one answer. Returns `undefined` when there is not enough material.
 */
export function composeAnswer(
  key: string,
  profile: Profile,
  context: ComposeContext = {},
): string | undefined {
  const education = primaryEducation(profile);
  const experience = primaryExperience(profile);
  const project: Project | undefined = profile.projects[0];
  const role = context.pageRole ?? profile.preference.position;
  const skills = profile.skills.items.slice(0, 6);

  switch (key) {
    case "essay.selfIntro": {
      const parts: string[] = [];
      if (education) {
        const phrase = degreePhrase(education);
        if (phrase) parts.push(`我是${profile.identity.fullName ?? "一名"}，${phrase}。`);
      } else if (profile.identity.fullName) {
        parts.push(`我是${profile.identity.fullName}。`);
      }

      const experienceLine = experience
        ? [
            experience.company,
            experience.title,
            experience.dates ? `（${formatRange(experience.dates)}）` : "",
          ]
            .filter(Boolean)
            .join(" ")
        : "";
      if (experienceLine) parts.push(`曾在 ${experienceLine} 工作。`);

      const highlights = bestHighlights(experience?.highlights ?? project?.highlights ?? [], 2);
      if (highlights.length > 0) parts.push(`主要负责${highlights.join("；")}。`);
      else if (project?.summary) parts.push(`主要项目：${project.summary}。`);

      if (skills.length > 0) parts.push(`熟悉 ${skills.join("、")}。`);

      if (role) parts.push(`希望应聘${role}岗位，期待在${context.company ?? "贵公司"}继续深耕。`);

      const answer = parts.join("");
      return countChars(answer) >= 40 ? answer : undefined;
    }

    case "essay.whyRole": {
      const parts: string[] = [];
      const target = role ?? "该岗位";
      const matching = skills.slice(0, 4);
      const educationLine = education ? degreePhrase(education) : "";

      if (educationLine) parts.push(`我的专业背景是${educationLine}，与${target}的岗位要求较为契合。`);
      else if (matching.length > 0) parts.push(`我的技术背景与${target}的岗位要求较为契合。`);

      const highlights = bestHighlights(experience?.highlights ?? project?.highlights ?? [], 2);
      if (highlights.length > 0) {
        parts.push(`在以往的经历中，${highlights.join("；")}，这些经验可以直接迁移到${target}的日常工作中。`);
      }
      if (matching.length > 0) parts.push(`我熟悉 ${matching.join("、")}，能够较快进入工作状态。`);
      if (profile.preference.cities.length > 0) {
        parts.push(`我的意向工作城市是${profile.preference.cities.slice(0, 2).join("、")}。`);
      }

      const answer = joinSentences(parts);
      return countChars(answer) >= 50 ? answer : undefined;
    }

    case "essay.whyCompany": {
      const parts: string[] = [];
      const company = context.company ?? "贵公司";
      // We deliberately do not assert facts about the company — only about fit.
      if (role) parts.push(`我关注${company}的${role}岗位已有一定时间。`);
      else parts.push(`我一直关注${company}的招聘信息。`);

      const highlights = bestHighlights(experience?.highlights ?? project?.highlights ?? [], 2);
      if (highlights.length > 0) {
        parts.push(`我在过往经历中${highlights.join("；")}，希望把这类经验用在${company}的业务场景中。`);
      }
      if (skills.length > 0) parts.push(`我掌握 ${skills.slice(0, 4).join("、")}，相信能快速上手团队的工作。`);
      if (profile.preference.cities.length > 0) {
        parts.push(`我愿意在${profile.preference.cities[0]}长期发展。`);
      }

      const answer = joinSentences(parts);
      return countChars(answer) >= 50 ? answer : undefined;
    }

    case "essay.strengths": {
      const parts: string[] = [];
      const highlights = bestHighlights(experience?.highlights ?? [], 3);
      if (skills.length > 0) parts.push(`专业技能方面，我熟悉 ${skills.slice(0, 5).join("、")}。`);
      if (highlights.length > 0) {
        parts.push(`在实际项目中，我${highlights.join("；")}。`);
      }
      if (education?.honors && education.honors.length > 0) {
        parts.push(`在校期间获得${education.honors.slice(0, 2).join("、")}。`);
      }
      if (profile.skills.certificates.length > 0) {
        parts.push(`已取得${profile.skills.certificates.slice(0, 2).join("、")}。`);
      }
      const answer = joinSentences(parts);
      return countChars(answer) >= 40 ? answer : undefined;
    }

    case "essay.careerPlan": {
      const parts: string[] = [];
      const target = role ?? "该岗位";
      if (skills.length > 0) {
        parts.push(`短期（1 年）内，我希望在${target}岗位上把 ${skills.slice(0, 3).join("、")} 用到实际业务中，独立承担模块开发。`);
      } else {
        parts.push(`短期（1 年）内，我希望尽快熟悉${target}的业务与流程，独立完成分配的任务。`);
      }
      parts.push("中期（3 年）内，希望在某一技术或业务方向上形成自己的专长，能够主导小型项目。");
      parts.push("长期来看，希望成为团队中可靠的一员，并把自己的经验沉淀下来分享给新人。");
      const answer = joinSentences(parts);
      return countChars(answer) >= 60 ? answer : undefined;
    }

    case "essay.achievement": {
      const highlights = bestHighlights(
        [...(experience?.highlights ?? []), ...(project?.highlights ?? [])],
        1,
      );
      const top = highlights[0];
      if (!top) return undefined;
      const where = experience?.company ?? project?.name;
      const parts = [
        where ? `在 ${where} 期间，${terminate(top)}` : terminate(top),
        "这件事让我体会到把复杂问题拆解、验证并落地的完整过程，也让我更确信自己的方向。",
      ];
      const answer = joinSentences(parts);
      return countChars(answer) >= 50 ? answer : undefined;
    }

    case "essay.challenge": {
      const highlights = bestHighlights(
        [...(experience?.highlights ?? []), ...(project?.highlights ?? [])].filter((text) =>
          /(困难|挑战|问题|瓶颈|故障|冲突|风险|延期|阻塞|重构|优化)/.test(text),
        ),
        1,
      );
      const top = highlights[0];
      if (!top) return undefined;
      const parts = [
        terminate(top),
        "面对这个问题，我先定位根因，再拆成可以验证的小步骤，逐步排除假设，最终完成修复并补充了预防措施。",
      ];
      return joinSentences(parts);
    }

    case "essay.hobby": {
      if (profile.skills.interests.length === 0) return undefined;
      return `${profile.skills.interests.join("、")}。`;
    }

    case "essay.aiTools": {
      const tools = collectProfileAiTools(profile);
      if (tools.length === 0) return undefined;
      return `我常用的 AI 工具与模型：${tools.join("、")}。`;
    }

    case "essay.aiProjects": {
      const candidate = profile.projects.find((item) => AI_PROJECT_PATTERN.test(projectText(item)));
      if (!candidate) return undefined;

      const tools = aiToolsIn([
        candidate.name ?? "",
        candidate.summary ?? "",
        ...(candidate.stack ?? []),
        ...candidate.highlights,
      ]);
      const goal = candidate.summary?.trim() || bestHighlights(candidate.highlights, 1)[0] || candidate.name;
      const highlights = bestHighlights(candidate.highlights, 3).filter((text) => text !== goal);
      if (!goal) return undefined;

      const parts: string[] = [`项目目标：${terminate(goal)}`];
      if (tools.length > 0) parts.push(`使用的 AI 工具与模型：${tools.join("、")}。`);
      if (candidate.role) parts.push(`我的角色：${terminate(candidate.role)}`);
      if (highlights.length > 0) parts.push(`我负责的工作：${highlights.map(terminate).join("")}`);
      return parts.length > 1 ? joinSentences(parts) : undefined;
    }

    case "essay.additional": {
      const parts: string[] = [];
      if (profile.skills.certificates.length > 0) {
        parts.push(`补充证书：${unique(profile.skills.certificates).join("、")}。`);
      }
      if (profile.skills.awards.length > 0) {
        parts.push(`获奖情况：${unique(profile.skills.awards).slice(0, 4).join("；")}。`);
      }
      if (profile.preference.availableFrom) {
        parts.push(`可到岗时间：${profile.preference.availableFrom}。`);
      }
      const answer = joinSentences(parts);
      return countChars(answer) >= 20 ? answer : undefined;
    }

    default:
      return undefined;
  }
}

/**
 * Which keys we can attempt for a given profile, so the UI can show what is
 * ready before the person opens an application form.
 */
export function composableKeys(profile: Profile): Array<{ key: string; preview: string }> {
  const out: Array<{ key: string; preview: string }> = [];
  for (const key of COMPOSABLE) {
    const value = composeAnswer(key, profile);
    if (value) out.push({ key, preview: `${value.slice(0, 42)}${value.length > 42 ? "…" : ""}` });
  }
  return out;
}
