/**
 * Direction dossiers — the collection behind "一个人同时投几个方向".
 *
 * The storage layer owns persistence; this module owns the rules that must be
 * identical in the extension worker and in the standalone workbench:
 * how a legacy single profile becomes a dossier, how independent dossiers are
 * created, and which dossier is open for editing.
 */

import {
  emptyProfile,
  type Profile,
  type ProfileDossier,
  type ProfileSummary,
} from "./types.js";

/** Eight directions is already a lot of hand-maintained copies. */
export const MAX_PROFILE_DOSSIERS = 8;
export const DEFAULT_DOSSIER_NAME = "默认方向";

/** JSON clone is enough: `Profile` is plain data by design. */
export function cloneProfile(profile: Profile, id = profile.id): Profile {
  const copy = JSON.parse(JSON.stringify(profile)) as Profile;
  copy.id = id;
  return copy;
}

export function normalizeDossierName(name: string | undefined): string {
  const trimmed = (name ?? "").replace(/\s+/g, " ").trim().slice(0, 24);
  return trimmed || "新方向";
}

/** A name that tells the person what the dossier was for. */
function nameFromProfile(profile: Profile): string {
  const position = profile.preference.position?.trim();
  if (position) return normalizeDossierName(position);
  return DEFAULT_DOSSIER_NAME;
}

export function makeDossier(
  profile: Profile,
  name: string,
  id = `dir-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
): ProfileDossier {
  const now = Date.now();
  const next = cloneProfile(profile, id);
  next.updatedAt = now;
  return {
    id,
    name: normalizeDossierName(name),
    profile: next,
    createdAt: now,
    updatedAt: now,
  };
}

export function summarizeDossier(dossier: ProfileDossier): ProfileSummary {
  const position = dossier.profile.preference.position?.trim();
  return {
    id: dossier.id,
    name: dossier.name,
    updatedAt: dossier.updatedAt,
    ...(position ? { position } : {}),
    educationCount: dossier.profile.education.length,
    experienceCount: dossier.profile.experience.length,
    projectCount: dossier.profile.projects.length,
  };
}

export interface ResolvedDossiers {
  dossiers: ProfileDossier[];
  activeId?: string;
}

/**
 * Read a dossier collection, migrating a pre-direction single profile on the
 * fly. Migration does not write: loading state must stay side-effect free, and
 * the first real mutation persists the collection.
 */
export function resolveDossiers(
  stored: ProfileDossier[] | undefined,
  legacyProfile: Profile | undefined,
  storedActiveId: string | undefined,
): ResolvedDossiers {
  const dossiers = (Array.isArray(stored) ? stored : []).filter(
    (entry): entry is ProfileDossier =>
      typeof entry?.id === "string" &&
      typeof entry?.name === "string" &&
      typeof entry?.profile === "object" &&
      entry.profile !== null,
  );

  if (dossiers.length === 0) {
    if (!legacyProfile) return { dossiers: [] };
    const id = legacyProfile.id || "profile-1";
    const updatedAt = legacyProfile.updatedAt || Date.now();
    return {
      dossiers: [
        {
          id,
          name: nameFromProfile(legacyProfile),
          profile: { ...legacyProfile, id },
          createdAt: updatedAt,
          updatedAt,
        },
      ],
      activeId: id,
    };
  }

  const activeId = dossiers.some((dossier) => dossier.id === storedActiveId)
    ? storedActiveId
    : dossiers[0]?.id;
  return { dossiers, activeId };
}

/** A direction starts empty so each one can hold its own uploaded resume. */
export function newDossier(name: string): ProfileDossier {
  return makeDossier(emptyProfile(), name);
}

/** Used by "新建方向" in the standalone workbench, which has no active profile. */
export function firstDossier(name = DEFAULT_DOSSIER_NAME): ProfileDossier {
  const profile = emptyProfile("profile-1");
  profile.updatedAt = Date.now();
  return makeDossier(profile, name, "profile-1");
}
