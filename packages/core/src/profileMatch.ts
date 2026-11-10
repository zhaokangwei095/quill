import type { HiringTrack, JdAnalysis, ProfileDossier } from "./types.js";
import { extractKeywords } from "./tailor/jd.js";
import { diceCoefficient, normalize } from "./text.js";

export interface DossierMatchContext {
  jobRole?: string;
  jobText?: string;
  hiringTrack?: HiringTrack;
}

export interface DossierMatch {
  dossier?: ProfileDossier;
  /** 0–1 heuristic relevance score. */
  score?: number;
  matchedByJob: boolean;
}

/** Enrich a short application page with a previously analyzed matching posting. */
export function enrichJobTextFromAnalyses(
  jobRole: string | undefined,
  company: string | undefined,
  pageText: string | undefined,
  analyses: JdAnalysis[],
): string {
  const text = pageText?.trim() ?? "";
  if (text.length >= 280 || !jobRole?.trim() || analyses.length === 0) return text;

  const normalizedCompany = normalize(company);
  const best = analyses
    .map((analysis, index) => {
      const roleScore = roleSimilarity(jobRole, analysis.role);
      const sameCompany = Boolean(
        normalizedCompany &&
          analysis.company &&
          normalize(analysis.company) === normalizedCompany,
      );
      return { analysis, index, roleScore, score: roleScore + (sameCompany ? 0.12 : 0) };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)[0];

  if (!best || best.roleScore < 0.42) return text;
  const analysisText = [
    best.analysis.role,
    ...best.analysis.requirements.map((item) => item.text),
    ...best.analysis.keywords,
    ...best.analysis.sections.map((section) => section.body),
  ]
    .filter(Boolean)
    .join("\n");
  return [text, analysisText].filter(Boolean).join("\n").slice(0, 6_000);
}

/**
 * Choose the separate resume dossier whose role and evidence best match a job.
 * The active dossier is only a tie-breaker and a fallback when the page exposes
 * no usable job information.
 */
export function matchDossierForJob(
  dossiers: ProfileDossier[],
  activeId: string | undefined,
  context: DossierMatchContext,
): DossierMatch {
  const active = dossiers.find((item) => item.id === activeId) ?? dossiers[0];
  if (dossiers.length === 0) return { matchedByJob: false };

  const jobRole = context.jobRole?.trim() ?? "";
  const jobText = [jobRole, context.jobText?.trim() ?? ""].filter(Boolean).join("\n");
  const hasTrack = isKnownTrack(context.hiringTrack);
  if (!jobText && !hasTrack) return { dossier: active, matchedByJob: false };

  const keywords = jobText ? extractKeywords(jobText).keywords : [];
  const scored = dossiers.map((dossier, index) => {
    const profile = dossier.profile;
    const roleSignals = [
      dossier.name,
      profile.preference.position,
      ...profile.experience.map((item) => item.title),
      ...profile.projects.flatMap((item) => [item.name, item.role]),
    ].filter((value): value is string => Boolean(value?.trim()));
    const roleScore = jobRole
      ? Math.max(0, ...roleSignals.map((signal) => roleSimilarity(jobRole, signal)))
      : 0;

    const profileText = [
      dossier.name,
      profile.preference.position,
      ...profile.education.flatMap((item) => [item.major, item.courses]),
      ...profile.experience.flatMap((item) => [
        item.title,
        item.department,
        ...item.highlights,
      ]),
      ...profile.projects.flatMap((item) => [
        item.name,
        item.role,
        item.summary,
        ...(item.stack ?? []),
        ...item.highlights,
      ]),
      ...profile.skills.items,
      ...profile.skills.certificates,
      ...profile.skills.awards,
      profile.essays.selfIntro,
    ]
      .filter((value): value is string => Boolean(value?.trim()))
      .join("\n");
    const keywordScore = keywords.length
      ? keywords.filter((keyword) => hasKeyword(profileText, keyword)).length / keywords.length
      : 0;

    const trackScore = hasTrack && profile.preference.targetTrack === context.hiringTrack ? 1 : 0;
    const score = combineScores({
      hasRole: Boolean(jobRole),
      hasKeywords: keywords.length > 0,
      roleScore,
      keywordScore,
      trackScore,
    });
    return { dossier, score, active: dossier.id === active?.id, index };
  });

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      Number(b.active) - Number(a.active) ||
      a.index - b.index,
  );
  const best = scored[0];
  return best ? { dossier: best.dossier, score: best.score, matchedByJob: true } : { matchedByJob: false };
}

function combineScores(input: {
  hasRole: boolean;
  hasKeywords: boolean;
  roleScore: number;
  keywordScore: number;
  trackScore: number;
}): number {
  const contentWeight = input.hasRole && input.hasKeywords ? 0.65 : input.hasRole ? 0.95 : input.hasKeywords ? 0.95 : 0;
  const roleWeight = input.hasRole && input.hasKeywords ? 0.65 : input.hasRole ? 0.95 : 0;
  const keywordWeight = input.hasRole && input.hasKeywords ? 0.30 : input.hasKeywords ? 0.95 : 0;
  const trackWeight = contentWeight > 0 ? 0.05 : 1;
  return roleWeight * input.roleScore + keywordWeight * input.keywordScore + trackWeight * input.trackScore;
}

function roleSimilarity(jobRole: string, candidate: string): number {
  const job = normalize(jobRole);
  const role = normalize(candidate);
  if (!job || !role) return 0;
  if (job === role) return 1;

  const jobCore = coreRole(job);
  const candidateCore = coreRole(role);
  if (jobCore && candidateCore && jobCore === candidateCore) return 0.95;
  if ((job.includes(role) || role.includes(job)) && Math.min(job.length, role.length) >= 3) {
    return 0.75 + 0.25 * (Math.min(job.length, role.length) / Math.max(job.length, role.length));
  }
  return diceCoefficient(job, role);
}

/** Remove common seniority prefixes so “高级后端工程师” still matches “后端开发工程师”. */
function coreRole(value: string): string {
  return value
    .replace(/^(高级|资深|初级|高级|junior|senior|lead|principal|staff)/i, "")
    .replace(/(开发工程师|研发工程师|工程师)$/, "工程师")
    .replace(/(开发|研发)$/, "")
    .trim();
}

function hasKeyword(text: string, keyword: string): boolean {
  const normalizedText = normalize(text);
  const normalizedKeyword = normalize(keyword);
  if (!normalizedKeyword) return false;

  if (/^[a-z0-9+#.\-]+$/i.test(keyword)) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^a-z0-9+#])${escaped}($|[^a-z0-9+#])`, "i").test(text)) return true;
  } else if (normalizedText.includes(normalizedKeyword)) {
    return true;
  }

  return normalizedKeyword.length >= 4 && diceCoefficient(text, keyword) >= 0.72;
}

function isKnownTrack(track: HiringTrack | undefined): track is Exclude<HiringTrack, "unknown"> {
  return track === "internship" || track === "campus" || track === "experienced";
}
