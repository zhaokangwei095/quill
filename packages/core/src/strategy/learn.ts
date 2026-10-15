/**
 * Learning from what the person types by hand.
 *
 * When a field has no usable value, the extension stays quiet. If the person
 * then fills it themselves, that answer is the best possible evidence — it is
 * exactly what they want on this kind of form. We capture it, key it, and
 * offer it back next time.
 *
 * Two guard rails:
 *  - Nothing they typed into a field *we* filled is learned (that would train
 *    on our own output).
 *  - Sensitive values are learned by key but never surfaced as "we know your
 *    ID number" — the UI keeps them behind an explicit reveal.
 */

import type { FieldDescriptor, MemoryEntry, FieldValue } from "../types.js";
import { normalize, unique } from "../text.js";
import { classifyField, labelMatchesKey } from "../fields/classify.js";
import { NEVER_AUTOFILL_KEYS } from "../fields/taxonomy.js";

/** Keys whose values we store but never echo in logs, previews or summaries. */
export const SENSITIVE_KEYS = new Set([
  "identity.idNumber",
  "identity.birthDate",
  "contact.phone",
  "contact.address",
  "contact.postalCode",
  "contact.emergencyPhone",
  "work.salary",
  "work.refereePhone",
]);

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key);
}

/** Mask a value for display: keep the shape, hide the content. */
export function maskValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 4) return "••••";
  if (trimmed.includes("@")) {
    const [local, domain] = trimmed.split("@");
    const head = (local ?? "").slice(0, 2);
    return `${head}${"•".repeat(Math.max(2, (local ?? "").length - 2))}@${domain ?? ""}`;
  }
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length >= 7) {
    return `${trimmed.slice(0, 3)}${"•".repeat(Math.max(2, trimmed.length - 6))}${trimmed.slice(-3)}`;
  }
  return `${trimmed.slice(0, 1)}${"•".repeat(Math.max(2, trimmed.length - 2))}${trimmed.slice(-1)}`;
}

/* ------------------------------------------------------------- observation */

/**
 * A value we observed the person type, ready to be turned into memory.
 * Produced by the scanner on `change`/`blur` events.
 */
export interface Observation {
  field: FieldDescriptor;
  value: string;
  /** Values we already proposed for this ref — never learn our own output. */
  proposedValues: string[];
  siteKey: string;
  at: number;
}

export interface LearnDecision {
  /** `new` | `update` | `reinforce` | `skip` */
  action: "new" | "update" | "reinforce" | "skip";
  reason: string;
  entry?: MemoryEntry;
}

/**
 * Should we remember this observation, and how does it fold into what we know?
 *
 * The caller supplies the existing memory so this stays a pure function.
 */
export function considerObservation(
  observation: Observation,
  memory: MemoryEntry[],
  options: { confirmLearned?: boolean } = {},
): LearnDecision {
  const value = observation.value.trim();
  const key = resolveKeyForObservation(observation);

  if (!value) return { action: "skip", reason: "空值" };
  if (value.length > 4000) return { action: "skip", reason: "内容过长，可能是富文本粘贴" };
  if (NEVER_AUTOFILL_KEYS.has(key)) return { action: "skip", reason: "验证码 / 协议类字段不记忆" };

  // Never learn a value we ourselves put there.
  if (observation.proposedValues.some((proposed) => normalize(proposed) === normalize(value))) {
    return { action: "skip", reason: "该内容由扩展填写，不作为学习样本" };
  }

  // Guard against capturing a user's password or a duplicate of a neighbour.
  if (observation.field.inputType === "password") return { action: "skip", reason: "密码字段不记忆" };

  const label = observation.field.label || observation.field.placeholder || observation.field.name || "";
  if (!label && key === "unknown") return { action: "skip", reason: "无法识别字段含义" };

  const canonicalKey = key === "unknown" ? `custom.${normalize(label).slice(0, 40)}` : key;

  // Same site, same key, same label: reinforce.
  const sameExact = memory.find(
    (entry) =>
      entry.key === canonicalKey &&
      entry.siteKey === observation.siteKey &&
      normalize(entry.labelSnapshot) === normalize(label),
  );

  if (sameExact) {
    if (normalize(sameExact.value) === normalize(value)) {
      return {
        action: "reinforce",
        reason: `与已有记录一致，已累计 ${sameExact.hits + 1} 次`,
        entry: { ...sameExact, hits: sameExact.hits + 1, updatedAt: observation.at },
      };
    }
    // A different value on the same question means either a correction or a
    // genuinely different answer — either way the newest wins, but we keep the
    // record so the person can see the change.
    return {
      action: "update",
      reason: `该字段此前记录为「${sameExact.value}」，已更新`,
      entry: {
        ...sameExact,
        value,
        labelSnapshot: label || sameExact.labelSnapshot,
        origin: options.confirmLearned === false ? "learned" : "confirmed",
        hits: sameExact.hits + 1,
        updatedAt: observation.at,
      },
    };
  }

  // Same key, different site: a separate site-scoped record so a per-company
  // answer (e.g. "how did you hear about us") does not leak across sites.
  const sameKeyOtherSite = memory.find(
    (entry) => entry.key === canonicalKey && entry.siteKey !== observation.siteKey && !entry.siteKey,
  );
  if (sameKeyOtherSite && normalize(sameKeyOtherSite.value) === normalize(value)) {
    return {
      action: "reinforce",
      reason: "与其他站点的记录一致，提升该答案的可信度",
      entry: { ...sameKeyOtherSite, hits: sameKeyOtherSite.hits + 1, updatedAt: observation.at },
    };
  }

  const entry: MemoryEntry = {
    id: `mem-${observation.at.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    key: canonicalKey,
    labelSnapshot: label,
    value,
    origin: options.confirmLearned === false ? "learned" : "confirmed",
    // Site-scoped only for keys that are inherently site-specific.
    ...(isSiteScopedKey(canonicalKey) ? { siteKey: observation.siteKey } : {}),
    hits: 1,
    createdAt: observation.at,
    updatedAt: observation.at,
    reviewed: false,
  };

  return { action: "new", reason: `已记住「${label || canonicalKey}」`, entry };
}

/**
 * Which key does an observation belong to?
 *
 * Prefer the scanner's classification, but re-run the classifier against the
 * label when it failed — the person typing a value is proof the field matters,
 * so it is worth a second attempt with the value as a hint.
 */
function resolveKeyForObservation(observation: Observation): string {
  const field = observation.field;
  if (field.key && field.key !== "unknown") return field.key;

  const classification = classifyField(field);
  if (classification.key !== "unknown" && classification.score >= 0.55) return classification.key;

  // Label-to-key fuzzy match as a last resort.
  const label = field.label || field.placeholder || "";
  if (label) {
    const guess = bestKeyForLabel(label);
    if (guess) return guess;
  }
  return "unknown";
}

const CANDIDATE_KEYS = [
  "identity.fullName",
  "identity.gender",
  "identity.birthDate",
  "identity.nativePlace",
  "identity.politicalStatus",
  "identity.ethnicity",
  "identity.household",
  "identity.idNumber",
  "identity.height",
  "identity.weight",
  "identity.healthStatus",
  "contact.phone",
  "contact.email",
  "contact.wechat",
  "contact.currentCity",
  "contact.address",
  "contact.postalCode",
  "contact.emergencyName",
  "contact.emergencyPhone",
  "contact.emergencyRelation",
  "education.school",
  "education.major",
  "education.degree",
  "education.graduationStatus",
  "education.studyMode",
  "education.gpa",
  "education.rank",
  "work.company",
  "work.title",
  "work.city",
  "work.leaveReason",
  "work.teamSize",
  "work.reportsTo",
  "project.name",
  "project.role",
  "skill.language",
  "skill.certificates",
  "preference.position",
  "preference.city",
  "preference.salary",
  "preference.availableFrom",
  "preference.relocation",
  "preference.travel",
  "preference.industry",
  "preference.source",
  "essay.selfIntro",
  "essay.whyRole",
  "essay.whyCompany",
  "essay.strengths",
  "essay.careerPlan",
  "essay.achievement",
  "essay.weakness",
  "essay.additional",
] as const;

function bestKeyForLabel(label: string): string | undefined {
  let best: { key: string; score: number } | undefined;
  for (const key of CANDIDATE_KEYS) {
    const score = labelMatchesKey(label, key);
    if (score >= 0.72 && (!best || score > best.score)) best = { key, score };
  }
  return best?.key;
}

/**
 * Keys whose answers are only valid for one employer. Everything else is
 * person-level and follows the person across sites.
 */
const SITE_SCOPED_PREFIXES = ["preference.source", "custom."];

export function isSiteScopedKey(key: string): boolean {
  return SITE_SCOPED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/* ---------------------------------------------------------------- promote */

/**
 * Fold memory back into the profile. Called when the person opens the
 * workbench: answers they have typed repeatedly are worth keeping as profile
 * data, not just as per-site trivia.
 */
export interface Promotion {
  key: string;
  value: string;
  hits: number;
  reason: string;
}

export function suggestPromotions(
  memory: MemoryEntry[],
  profileKeysInUse: Set<string>,
  minimumHits = 3,
): Promotion[] {
  const out: Promotion[] = [];
  for (const entry of memory) {
    if (entry.hits < minimumHits) continue;
    if (profileKeysInUse.has(entry.key)) continue;
    if (entry.key.startsWith("custom.")) continue;
    if (isSensitiveKey(entry.key)) continue;
    out.push({
      key: entry.key,
      value: entry.value,
      hits: entry.hits,
      reason: `你在不同表单中已填写 ${entry.hits} 次`,
    });
  }
  return out.sort((a, b) => b.hits - a.hits).slice(0, 12);
}

/** Merge duplicate memory entries that map to the same key and value. */
export function compactMemory(memory: MemoryEntry[]): MemoryEntry[] {
  const byKeyValue = new Map<string, MemoryEntry>();
  for (const entry of memory) {
    const key = `${entry.key}|${normalize(entry.value)}|${entry.siteKey ?? ""}`;
    const existing = byKeyValue.get(key);
    if (!existing) {
      byKeyValue.set(key, entry);
      continue;
    }
    byKeyValue.set(key, {
      ...existing,
      hits: existing.hits + entry.hits,
      updatedAt: Math.max(existing.updatedAt, entry.updatedAt),
      createdAt: Math.min(existing.createdAt, entry.createdAt),
      reviewed: existing.reviewed || entry.reviewed,
      origin: existing.origin === "confirmed" || entry.origin === "confirmed" ? "confirmed" : existing.origin,
    });
  }
  return [...byKeyValue.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** A compact, non-sensitive preview of an entry for the library UI. */
export function previewMemory(entry: MemoryEntry): { label: string; value: string } {
  return {
    label: entry.labelSnapshot || entry.key,
    value: isSensitiveKey(entry.key) ? maskValue(entry.value) : entry.value,
  };
}

/**
 * Detect when two memory entries for the same key disagree, so the library can
 * ask which one to keep instead of silently preferring one.
 */
export function conflictingMemory(memory: MemoryEntry[]): Array<{ key: string; entries: MemoryEntry[] }> {
  const byKey = new Map<string, MemoryEntry[]>();
  for (const entry of memory) {
    const list = byKey.get(entry.key) ?? [];
    list.push(entry);
    byKey.set(entry.key, list);
  }
  const out: Array<{ key: string; entries: MemoryEntry[] }> = [];
  for (const [key, entries] of byKey) {
    const values = unique(entries.map((entry) => normalize(entry.value)));
    if (values.length > 1) out.push({ key, entries });
  }
  return out;
}
