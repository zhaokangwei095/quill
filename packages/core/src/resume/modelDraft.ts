/**
 * Turning the recognition server's draft into a Profile.
 *
 * The server has already normalised dates, dropped business names out of
 * education, and deduplicated awards. This layer does not re-judge semantics —
 * it maps the wire shape onto the domain model, strips anything empty, and
 * keeps the server's warnings so the person can review them next to the facts.
 */

import {
  emptyProfile,
  normalizeProjectCategory,
  type DateRange,
  type Education,
  type Experience,
  type Profile,
  type Project,
} from "../types.js";
import { experienceKindFromText } from "../strategy/experience.js";
import { hiringTrackFromLabel } from "../strategy/recruitment.js";

export interface ModelDraftEducation {
  school?: string;
  major?: string;
  degree?: string;
  dates?: DateRange;
  gpa?: string;
  rank?: string;
  honors?: string[];
}

export interface ModelDraftExperience {
  company?: string;
  title?: string;
  /** 实习 / 全职 / 兼职，模型能读出时使用 */
  employmentType?: string;
  city?: string;
  dates?: DateRange;
  highlights?: string[];
}

export interface ModelDraftProject {
  name?: string;
  /** 科研项目 / 开源项目 / 个人作品 / 其他 */
  category?: string;
  role?: string;
  dates?: DateRange;
  highlights?: string[];
}

/** What `POST /api/resume/extract` returns under `draft`. */
export interface ModelResumeDraft {
  identity?: {
    fullName?: string;
    gender?: string;
    birthDate?: string;
    politicalStatus?: string;
    nativePlace?: string;
  };
  contact?: {
    phone?: string;
    email?: string;
    currentCity?: string;
    address?: string;
  };
  preference?: {
    position?: string;
    cities?: string[];
    availableFrom?: string;
    salary?: string;
    /** 求职类型，例如 “实习” */
    jobType?: string;
    /** 招聘类型，例如 “校招” */
    targetTrack?: string;
  };
  education?: ModelDraftEducation[];
  experience?: ModelDraftExperience[];
  projects?: ModelDraftProject[];
  skills?: {
    items?: string[];
    certificates?: string[];
    awards?: string[];
    interests?: string[];
  };
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function list(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => text(item)).filter((item): item is string => Boolean(item)))]
    : [];
}

function range(value: unknown): DateRange | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as DateRange;
  const start = text(source.start);
  const end = text(source.end);
  const current =
    source.current === true ||
    (end !== undefined && /至今|现在|目前|present|current|now/i.test(end));
  if (!start && !end) return undefined;
  return {
    ...(start ? { start } : {}),
    ...(!current && end ? { end } : {}),
    ...(current ? { current: true } : {}),
  };
}

export function profileFromModelDraft(
  draft: ModelResumeDraft,
  options: {
    profileId?: string;
    sourceDocumentId?: string;
    rawText?: string;
    warnings?: string[];
  } = {},
): Profile {
  const profile = emptyProfile(options.profileId ?? "profile-1");

  const identity = draft.identity ?? {};
  profile.identity = {
    ...(text(identity.fullName) ? { fullName: text(identity.fullName) } : {}),
    ...(text(identity.gender) ? { gender: text(identity.gender) } : {}),
    ...(text(identity.birthDate) ? { birthDate: text(identity.birthDate) } : {}),
    ...(text(identity.politicalStatus) ? { politicalStatus: text(identity.politicalStatus) } : {}),
    ...(text(identity.nativePlace) ? { nativePlace: text(identity.nativePlace) } : {}),
  };

  const contact = draft.contact ?? {};
  profile.contact = {
    ...(text(contact.phone) ? { phone: text(contact.phone) } : {}),
    ...(text(contact.email) ? { email: text(contact.email) } : {}),
    ...(text(contact.currentCity) ? { currentCity: text(contact.currentCity) } : {}),
    ...(text(contact.address) ? { address: text(contact.address) } : {}),
  };

  const preference = draft.preference ?? {};
  const declaredTrack =
    hiringTrackFromLabel(text(preference.targetTrack) ?? "") ??
    hiringTrackFromLabel(text(preference.jobType) ?? "");
  profile.preference = {
    ...(text(preference.position) ? { position: text(preference.position) } : {}),
    ...(text(preference.salary) ? { salary: text(preference.salary) } : {}),
    ...(text(preference.availableFrom) ? { availableFrom: text(preference.availableFrom) } : {}),
    ...(text(preference.jobType) ? { jobType: text(preference.jobType) } : {}),
    ...(declaredTrack ? { targetTrack: declaredTrack } : {}),
    cities: list(preference.cities),
    industries: [],
  };

  profile.education = (Array.isArray(draft.education) ? draft.education : [])
    .map((item, index): Education | undefined => {
      const school = text(item?.school);
      const major = text(item?.major);
      const degree = text(item?.degree);
      const dates = range(item?.dates);
      const gpa = text(item?.gpa);
      const rank = text(item?.rank);
      const honors = list(item?.honors);
      if (!school && !major && !degree) return undefined;
      return {
        id: `edu-${index + 1}`,
        ...(school ? { school } : {}),
        ...(major ? { major } : {}),
        ...(degree ? { degree } : {}),
        ...(dates ? { dates } : {}),
        ...(gpa ? { gpa } : {}),
        ...(rank ? { rank } : {}),
        ...(honors.length > 0 ? { honors } : {}),
      };
    })
    .filter((item): item is Education => item !== undefined);

  profile.experience = (Array.isArray(draft.experience) ? draft.experience : [])
    .map((item, index): Experience | undefined => {
      const company = text(item?.company);
      const title = text(item?.title);
      const city = text(item?.city);
      const dates = range(item?.dates);
      const highlights = list(item?.highlights);
      const explicitType = text(item?.employmentType);
      const inferredKind = experienceKindFromText([explicitType, title].filter(Boolean).join(" "));
      const employmentType =
        explicitType ?? (inferredKind === "internship" ? "实习" : inferredKind === "employment" ? "全职" : undefined);
      if (!company && !title && highlights.length === 0) return undefined;
      return {
        id: `exp-${index + 1}`,
        ...(company ? { company } : {}),
        ...(title ? { title } : {}),
        ...(employmentType ? { employmentType } : {}),
        ...(city ? { city } : {}),
        ...(dates ? { dates } : {}),
        highlights,
      };
    })
    .filter((item): item is Experience => item !== undefined);

  profile.projects = (Array.isArray(draft.projects) ? draft.projects : [])
    .map((item, index): Project | undefined => {
      const name = text(item?.name);
      if (!name) return undefined;
      const category = normalizeProjectCategory(item?.category);
      const role = text(item?.role);
      const dates = range(item?.dates);
      return {
        id: `proj-${index + 1}`,
        name,
        ...(category ? { category } : {}),
        ...(role ? { role } : {}),
        ...(dates ? { dates } : {}),
        highlights: list(item?.highlights),
      };
    })
    .filter((item): item is Project => item !== undefined);

  const skills = draft.skills ?? {};
  profile.skills = {
    items: list(skills.items),
    certificates: list(skills.certificates),
    awards: list(skills.awards),
    interests: list(skills.interests),
  };

  profile.essays = { unclassified: {} };
  if (options.sourceDocumentId) profile.sourceDocumentId = options.sourceDocumentId;
  if (options.rawText) profile.rawText = options.rawText;

  const warnings = [...new Set((options.warnings ?? []).filter((warning) => warning.trim().length > 0))];
  if (warnings.length > 0) profile.parseWarnings = warnings;

  return profile;
}
