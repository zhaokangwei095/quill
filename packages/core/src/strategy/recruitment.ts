import type { HiringTrack } from "../types.js";

function explicitTracks(text: string): HiringTrack[] {
  const matches: HiringTrack[] = [];
  if (/实习招聘|实习生招聘|实习生岗位|实习岗位|暑期实习|日常实习|实习生计划|实习生|intern(?:ship)?(?:\s+(?:program|role|opportunit(?:y|ies)|hiring))?/i.test(text)) {
    matches.push("internship");
  }
  if (/校园招聘|校招|应届生招聘|应届毕业生招聘|campus\s+(?:recruitment|hiring|jobs?)|graduate\s+(?:recruitment|program|jobs?)/i.test(text)) {
    matches.push("campus");
  }
  if (/社会招聘|社招|社会人才招聘|experienced\s+(?:hire|hiring|recruitment)|professional\s+(?:hire|hiring|recruitment)/i.test(text)) {
    matches.push("experienced");
  }
  return matches;
}

function chooseTrack(matches: HiringTrack[]): HiringTrack | undefined {
  if (matches.length === 1) return matches[0];
  // A campus campaign may contain a specific internship sub-campaign; the
  // explicit intern role is the more precise category. Conflicting experienced
  // hiring signals stay unknown instead of being guessed.
  if (matches.includes("internship") && !matches.includes("experienced")) return "internship";
  return undefined;
}

/**
 * Infer the role category from prominent page identity first, then page copy.
 * Generic experience section names are intentionally excluded from this API:
 * they identify a form section, not the recruitment campaign.
 */
export function inferHiringTrack(prominentText: string, pageText: string): HiringTrack {
  const prominent = explicitTracks(prominentText);
  if (prominent.length > 0) return chooseTrack(prominent) ?? "unknown";

  const secondary = explicitTracks(pageText);
  return chooseTrack(secondary) ?? "unknown";
}

/**
 * Read one explicit preference value, such as “求职类型：实习” or
 * “投递类型：社招”, into a track.
 *
 * This is intentionally stricter than the page detector: it is only called on
 * a label whose whole value is the track, so a bare “实习” can count here even
 * though it must not turn a page containing an “实习经历” section into an
 * internship campaign.
 */
export function hiringTrackFromLabel(label: string): Exclude<HiringTrack, "unknown"> | undefined {
  const text = label.trim();
  if (!text) return undefined;
  if (/社招|社会招聘|社会人才|experienced|professional/i.test(text)) return "experienced";
  if (/校招|校园招聘|应届毕业生|应届生|graduate|campus/i.test(text)) return "campus";
  if (/实习|intern(?:ship)?|trainee/i.test(text)) return "internship";
  return undefined;
}
