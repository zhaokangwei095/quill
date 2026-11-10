/**
 * Keep past internship and employment records aligned with the kind of role a
 * form is asking about. An unlabelled record stays available for review; a
 * clearly mismatched record is never substituted into the other category.
 */

import type { Experience, ExperienceKind, HiringTrack } from "../types.js";

export function experienceKindFromLabel(label: string): ExperienceKind | undefined {
  const internship = /实习经历|实习经验|实习岗位/.test(label);
  const employment = /工作经历|工作经验|工作履历|职业经历|任职经历|employment history/i.test(label);
  if (internship === employment) return undefined;
  return internship ? "internship" : "employment";
}

/**
 * Read an experience's own wording, not a whole section heading.
 *
 * A title such as “前端开发实习生” is the most direct evidence a resume gives;
 * “工作经历” is a section name and is handled separately by callers.
 */
export function experienceKindFromText(text: string): ExperienceKind | undefined {
  if (/实习生|实习|internship|\bintern\b|trainee/i.test(text)) return "internship";
  if (/全职|兼职|正式员工|正式|工作|雇佣|full[\s-]?time|part[\s-]?time|employment|employee/i.test(text)) {
    return "employment";
  }
  return undefined;
}

export function experienceKindOf(
  entry: Pick<Experience, "employmentType" | "title">,
): ExperienceKind | undefined {
  const value = entry.employmentType?.trim();
  /*
   * An explicit “全职 / 兼职 / 实习” is the person's own statement and wins over
   * a title. “工作” alone is the generic default the parser applies to a whole
   * “工作经历” section, so a title such as “后端开发实习生” may still correct it.
   */
  if (value) {
    if (/实习|intern|trainee/i.test(value)) return "internship";
    if (/全职|兼职|正式|雇佣|full[\s-]?time|part[\s-]?time|employment|employee/i.test(value)) {
      return "employment";
    }
  }
  const title = entry.title?.trim();
  const fromTitle = title ? experienceKindFromText(title) : undefined;
  if (fromTitle) return fromTitle;
  if (value && /工作/.test(value)) return "employment";
  return undefined;
}

/**
 * The page's own track wins; when the page says nothing, use the track the
 * person declared for this resume. `unknown` is deliberately treated as
 * “nothing said”, not as a real category.
 */
export function effectiveHiringTrack(
  pageTrack: HiringTrack | undefined,
  declaredTrack: HiringTrack | undefined,
): Exclude<HiringTrack, "unknown"> | undefined {
  const known = (track: HiringTrack | undefined): track is Exclude<HiringTrack, "unknown"> =>
    track === "internship" || track === "campus" || track === "experienced";
  if (known(pageTrack)) return pageTrack;
  return known(declaredTrack) ? declaredTrack : undefined;
}

/**
 * Return records that fit the page's hiring track, with matching tagged entries
 * first and unlabelled entries after them. A tagged record from the other track
 * is excluded; callers can therefore leave that row empty instead of presenting
 * a full-time job as an internship (or vice versa).
 */
export function experiencesForTrack(
  entries: Experience[],
  hiringTrack: HiringTrack | undefined,
  sectionKind?: ExperienceKind,
): Experience[] {
  const preferred: ExperienceKind | undefined =
    sectionKind === "internship"
      ? "internship"
      : hiringTrack === "internship" || hiringTrack === "campus"
        ? "internship"
        : hiringTrack === "experienced"
          ? "employment"
          : sectionKind;
  if (!preferred) return entries;

  return entries
    .map((entry, index) => ({ entry, index, kind: experienceKindOf(entry) }))
    .filter(({ kind }) => kind === undefined || kind === preferred)
    .sort((a, b) => {
      const rank = (kind: ExperienceKind | undefined) => (kind === preferred ? 0 : 1);
      return rank(a.kind) - rank(b.kind) || a.index - b.index;
    })
    .map(({ entry }) => entry);
}
