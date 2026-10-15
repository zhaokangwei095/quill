/**
 * Mapping a messy label onto a canonical key.
 *
 * The hard part of form autofill is not typing into inputs — it is deciding
 * that "Numéro de téléphone portable（必填）*" and 手机号码 mean the same
 * thing. This classifier scores every definition against every scrap of text
 * we recovered from the widget, then applies context to break ties.
 */

import {
  DEFINITION_BY_KEY,
  type FieldDefinition,
  FIELD_DEFINITIONS,
  NEVER_AUTOFILL_KEYS,
  sectionOfKey,
} from "./taxonomy.js";
import { normalize, termScore, containsTerm, diceCoefficient } from "../text.js";
import type { FieldDescriptor, FieldSection } from "../types.js";

export interface Classification {
  key: string;
  score: number;
  /** Second-best candidate, for confidence estimation. */
  runnerUp?: { key: string; score: number };
  notes: string[];
}

/** How much each label source is trusted. Multiplies the raw match score. */
const SOURCE_WEIGHT: Record<string, number> = {
  "label-for": 1,
  "aria-labelledby": 1,
  "aria-label": 0.98,
  wrapper: 0.94,
  "table-header": 0.96,
  preceding: 0.9,
  placeholder: 0.62,
  "name-attribute": 0.7,
  "title-attribute": 0.66,
  "section-heading": 0.5,
  none: 0.3,
};

/**
 * Channels that hold *human-written* text, where an exclusion is a phrase the
 * author typed and contiguous containment is the right test.
 */
const HUMAN_CHANNELS = new Set(["label-for", "aria-label", "aria-labelledby", "wrapper", "table-header", "preceding", "hint", "placeholder", "title", "group", "section-heading"]);

/**
 * Split a mechanical attribute into words.
 *
 * `emergencyPhone` must yield `[emergency, phone]` and `userName` must yield
 * `[user, name]`, because exclusions are checked word-by-word on these channels
 * rather than as substrings. Substring matching here was a real bug: the
 * exclusion "username" matched the attribute `userName` — an entirely ordinary
 * name for a *full name* input — and disqualified the applicant's own name.
 */
export function mechanicalTokens(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.\[\](){}]+/g, " ")
    .split(/\s+/)
    .map((token) => normalize(token))
    .filter(Boolean);
}

/**
 * Does `exclusion` disqualify this channel?
 *
 * Two different tests, because the channels mean different things. A label is
 * prose, so "紧急联系人电话" contains the exclusion 紧急. An attribute is an
 * identifier, so only a whole word counts — which is what keeps `userName` from
 * being read as "a username field".
 */
function exclusionApplies(channel: Channel, exclusion: string): boolean {
  const normalized = normalize(exclusion);
  if (!normalized) return false;

  if (HUMAN_CHANNELS.has(channel.source)) {
    return containsTerm(channel.text, exclusion);
  }

  // Mechanical: match whole words, allowing a token to begin with the exclusion
  // so that "referenceName" still trips the exclusion "reference".
  return mechanicalTokens(channel.text).some((token) => {
    if (token === normalized) return true;
    // A CJK attribute value has no word separators to rely on, so containment
    // is the only usable test there.
    if (/[\u4E00-\u9FFF]/.test(token)) return token.includes(normalized);
    // Latin: a prefix match only when the exclusion is substantial enough to be
    // meaningful on its own.
    return normalized.length >= 4 && token.startsWith(normalized);
  });
}

/**
 * Weight per evidence channel. A label that came from a real `<label for>` and
 * matches an alias is worth more than the same word seen in a placeholder.
 */
interface Channel {
  text: string;
  weight: number;
  source: string;
}

function channelsOf(field: FieldDescriptor): Channel[] {
  const channels: Channel[] = [];
  const labelWeight = SOURCE_WEIGHT[field.labelSource] ?? 0.5;

  if (field.label) channels.push({ text: field.label, weight: 1 * labelWeight, source: field.labelSource });
  if (field.hint) channels.push({ text: field.hint, weight: 0.55, source: "hint" });
  if (field.placeholder) channels.push({ text: field.placeholder, weight: 0.5, source: "placeholder" });
  if (field.title) channels.push({ text: field.title, weight: 0.45, source: "title" });
  if (field.name) channels.push({ text: field.name, weight: 0.42, source: "name" });
  if (field.id) channels.push({ text: field.id, weight: 0.3, source: "id" });
  if (field.groupHeading) channels.push({ text: field.groupHeading, weight: 0.28, source: "group" });
  if (field.autocomplete) channels.push({ text: field.autocomplete, weight: 0.9, source: "autocomplete" });

  return channels;
}

/** `autocomplete` tokens map straight onto keys — the highest-signal source. */
const AUTOCOMPLETE_MAP: Record<string, string> = {
  name: "identity.fullName",
  "given-name": "identity.firstName",
  "family-name": "identity.lastName",
  "additional-name": "identity.firstName",
  email: "contact.email",
  tel: "contact.phone",
  "tel-national": "contact.phone",
  "street-address": "contact.address",
  "address-line1": "contact.address",
  "address-level1": "identity.nativePlace",
  "address-level2": "contact.currentCity",
  "postal-code": "contact.postalCode",
  country: "identity.nationality",
  bday: "identity.birthDate",
  "bday-day": "identity.birthDate",
  "bday-month": "identity.birthDate",
  "bday-year": "identity.birthDate",
  organization: "work.company",
  "organization-title": "work.title",
  url: "contact.homepage",
  photo: "identity.photo",
  sex: "identity.gender",
  language: "skill.language",
};

/**
 * Attribute names that betray the field's meaning when the visible label is
 * missing. Vendors are remarkably consistent here.
 */
const ATTRIBUTE_HINTS: Array<{ test: RegExp; key: string }> = [
  /*
   * Most specific first. The list is scanned in order and the first hint whose
   * exclusions do not veto it wins, so `emergencyPhone` must be tested before
   * the generic phone pattern, otherwise the generic one matches and is then
   * rejected by its own exclusion, leaving the field unclassified.
   */
  { test: /(emergency|urgent)[_-]?(contact|phone|tel|mobile|number)/i, key: "contact.emergencyPhone" },
  { test: /(referee|reference|referrer)[_-]?(phone|tel|mobile|contact|number)/i, key: "work.refereePhone" },
  { test: /(guardian|parent)[_-]?(phone|tel|mobile|contact)/i, key: "contact.emergencyPhone" },
  { test: /(^|[^a-z])(realname|username|name)([^a-z]|$)/i, key: "identity.fullName" },
  { test: /(last|family|sur)[_-]?name/i, key: "identity.lastName" },
  { test: /(first|given|fore)[_-]?name/i, key: "identity.firstName" },
  { test: /mobile|cell|phone|tel(ephone)?(no|num|number)?/i, key: "contact.phone" },
  { test: /e[_-]?mail/i, key: "contact.email" },
  { test: /(wechat|weixin)/i, key: "contact.wechat" },
  { test: /(gender|sex)/i, key: "identity.gender" },
  { test: /(birth|birthday|dob)/i, key: "identity.birthDate" },
  { test: /(idcard|id[_-]?no|identity[_-]?card|certno)/i, key: "identity.idNumber" },
  { test: /(school|university|college)/i, key: "education.school" },
  { test: /(major|specialty|speciality)/i, key: "education.major" },
  { test: /(degree|education[_-]?level|edulevel)/i, key: "education.degree" },
  { test: /(gpa|grade[_-]?point)/i, key: "education.gpa" },
  { test: /(company|employer|org(anization)?[_-]?name)/i, key: "work.company" },
  { test: /(position|jobtitle|job[_-]?title|post)/i, key: "work.title" },
  { test: /(project|proj)(name|title)/i, key: "project.name" },
  { test: /(hukou|household)/i, key: "identity.household" },
  { test: /(nation(ality)?|country)/i, key: "identity.nationality" },
  { test: /(city|location|address[_-]?city)/i, key: "contact.currentCity" },
  { test: /(address|addr|street)/i, key: "contact.address" },
  { test: /(postcode|zip|postal)/i, key: "contact.postalCode" },
  { test: /(resume|cv)[_-]?(file|upload|attach)?/i, key: "skill.resumeFile" },
  { test: /(captcha|verify[_-]?code|vcode|smscode)/i, key: "meta.captcha" },
];

/**
 * Words that appear in section headings. Used to disambiguate generic labels
 * like "名称" or "开始时间" by their surrounding context.
 */
const SECTION_SIGNALS: Array<{ test: RegExp; section: FieldSection }> = [
  { test: /教育|学历|学习|院校|school|education|academic|académ/i, section: "education" },
  { test: /工作|实习|任职|就职|经历|experience|employment|work history/i, section: "experience" },
  { test: /项目|课题|project/i, section: "project" },
  { test: /联系|联络|contact/i, section: "contact" },
  { test: /基本|个人信息|个人资料|身份|personal|identity|basic info/i, section: "identity" },
  { test: /技能|专长|证书|skill|certificat|competenc/i, section: "skill" },
  { test: /求职|意向|意愿|期望|preference|expectation/i, section: "preference" },
  { test: /自述|开放|问答|题|essay|question|additional/i, section: "essay" },
];

export function detectSection(text: string): FieldSection {
  for (const signal of SECTION_SIGNALS) {
    if (signal.test.test(text)) return signal.section;
  }
  return "unknown";
}

/**
 * Score one definition against one field.
 *
 * Strategy: take the best matching alias across all evidence channels, apply
 * the channel weight, then boost or penalise with structural signals.
 */
function scoreDefinition(definition: FieldDefinition, field: FieldDescriptor, channels: Channel[]): number {
  let best = 0;
  let matchedAlias = "";

  for (const channel of channels) {
    for (const alias of definition.aliases) {
      const raw = termScore(channel.text, alias);
      if (raw <= 0) continue;
      const weighted = raw * channel.weight;
      if (weighted > best) {
        best = weighted;
        matchedAlias = alias;
      }
    }
  }

  if (best === 0) return 0;

  /*
   * Explicit exclusions kill the match outright — "紧急联系人电话" must never be
   * read as the applicant's own mobile number.
   *
   * An exclusion is skipped when it is part of the alias that already matched:
   * `identity.fullName` excludes 姓名拼音 etc. by listing "姓", and without this
   * guard the exclusion would also reject the plain label 姓名, which is exactly
   * the field it is meant to capture.
   */
  if (definition.excludes) {
    const matchedAliasNormalized = normalize(matchedAlias);
    for (const channel of channels) {
      for (const exclusion of definition.excludes) {
        const exclusionNormalized = normalize(exclusion);
        if (!exclusionNormalized) continue;
        // Skip an exclusion that the matched alias already contains, e.g.
        // "姓名" legitimately contains 姓, which fullName also excludes.
        if (matchedAliasNormalized.includes(exclusionNormalized)) continue;
        if (exclusionApplies(channel, exclusion)) return 0;
      }
    }
  }

  // Exact equality with a short alias is a very strong signal.
  const labelNormalized = normalize(field.label);
  const aliasNormalized = normalize(matchedAlias);
  if (labelNormalized && labelNormalized === aliasNormalized) best += 0.12;

  // Widget kind agreement.
  if (definition.kinds && definition.kinds.length > 0) {
    if (definition.kinds.includes(field.kind)) best += 0.1;
    else best -= 0.45;
  }

  // Any field with a fixed option list is a choice, never free text.
  const choicey = field.kind === "select" || field.kind === "radio-group" || field.kind === "combobox";
  if (choicey && definition.kinds && !definition.kinds.includes(field.kind)) best -= 0.2;

  // Section agreement: reward when the definitions' section matches what the
  // surrounding markup suggests.
  const context = [field.groupHeading, field.label, field.hint, field.name, field.id]
    .filter(Boolean)
    .join(" ");
  const contextSection = field.section !== "unknown" ? field.section : detectSection(context);
  if (contextSection !== "unknown") {
    if (definition.section === contextSection) best += 0.18;
    else best -= 0.28;
  }

  // Multi-line widgets belong to long-form answers.
  if (field.kind === "textarea" || field.kind === "contenteditable") {
    if (definition.section === "essay") best += 0.12;
    if (["identity", "contact"].includes(definition.section)) best -= 0.12;
  }

  // A 60+ character alias cannot match a 3-character label meaningfully.
  if (aliasNormalized.length > labelNormalized.length * 2.4 && labelNormalized.length > 0) {
    best *= 0.6;
  }

  return Math.max(0, best);
}

/**
 * Short labels that only make sense inside a known section. Applied after the
 * general scorer, because they are context rewrites rather than matches.
 */
const SECTION_QUALIFIERS: Record<string, Record<string, string>> = {
  education: {
    name: "education.school",
    "名称": "education.school",
    "开始时间": "education.startDate",
    "结束时间": "education.endDate",
    "时间": "education.startDate",
    "专业": "education.major",
    "院校": "education.school",
    "学校": "education.school",
  },
  experience: {
    name: "work.company",
    "名称": "work.company",
    "开始时间": "work.startDate",
    "结束时间": "work.endDate",
    "岗位": "work.title",
    "职位": "work.title",
    "公司": "work.company",
  },
  project: {
    name: "project.name",
    "名称": "project.name",
    "开始时间": "project.startDate",
    "结束时间": "project.endDate",
    "描述": "project.description",
  },
};

export function classifyField(field: FieldDescriptor): Classification {
  const notes: string[] = [];

  // 1. `autocomplete` is authoritative when present.
  if (field.autocomplete) {
    const token = field.autocomplete.trim().toLowerCase().split(/\s+/)[0] ?? "";
    const mapped = AUTOCOMPLETE_MAP[token];
    if (mapped) {
      notes.push(`autocomplete=${token}`);
      return { key: mapped, score: 0.97, notes };
    }
  }

  // 2. Section-scoped rewrites for short, ambiguous labels.
  const contextText = [field.groupHeading, field.label, field.section, field.name].filter(Boolean).join(" ");
  const section = field.section !== "unknown" ? field.section : detectSection(contextText);
  if (section !== "unknown" && field.label) {
    const qualifiers = SECTION_QUALIFIERS[section];
    if (qualifiers) {
      const byNormalized = qualifiers[normalize(field.label)];
      if (byNormalized) {
        notes.push(`section:${section} rewrite of "${field.label}"`);
        return { key: byNormalized, score: 0.9, notes };
      }
    }
  }

  // 3. General scoring across all evidence channels.
  const channels = channelsOf(field);
  let best: { key: string; score: number } | null = null;
  let runnerUp: { key: string; score: number } | undefined;

  for (const definition of FIELD_DEFINITIONS) {
    const score = scoreDefinition(definition, field, channels);
    if (score <= 0.3) continue;
    if (!best || score > best.score) {
      if (best) runnerUp = best;
      best = { key: definition.key, score };
    } else if (!runnerUp || score > runnerUp.score) {
      runnerUp = { key: definition.key, score };
    }
  }

  // 4. Attribute-name fallback when no human-readable label matched.
  if (!best) {
    const attributeText = [field.name, field.id, field.placeholder, field.title].filter(Boolean).join(" ");
    if (attributeText) {
      /*
       * An earlier version returned the first matching hint without checking the
       * definition's exclusions. That made the fallback the *least* careful path
       * in the classifier: a label of "电话" on an input named `emergencyPhone`
       * scored zero through the normal route (correctly — contact.phone excludes
       * emergency), and was then handed to 手机号码 anyway by the fallback.
       * Exclusions are absolute and must be applied here too.
       */
      const attributeChannel: Channel = {
        text: attributeText,
        weight: 1,
        source: field.name ? "name" : "id",
      };
      for (const hint of ATTRIBUTE_HINTS) {
        if (!hint.test.test(attributeText)) continue;
        const definition = DEFINITION_BY_KEY.get(hint.key);
        if (definition?.excludes?.some((exclusion) => exclusionApplies(attributeChannel, exclusion))) {
          notes.push(`attribute match rejected by exclusion:${hint.key}`);
          continue;
        }
        notes.push(`attribute match:${hint.test.source}`);
        return { key: hint.key, score: 0.62, notes };
      }
    }
    return { key: "unknown", score: 0, notes };
  }

  // 5. Confidence shaping.
  let score = best.score;
  if (field.labelSource === "none" && field.label === "") score *= 0.7;

  const margin = runnerUp ? best.score - runnerUp.score : best.score;
  if (runnerUp && margin < 0.06) {
    notes.push(`ambiguous with ${runnerUp.key}`);
    score *= 0.82;
  }

  // A single generic word against a long alias is a weak signal.
  if (best.key !== "unknown" && normalize(field.label).length <= 2 && field.labelSource === "preceding") {
    score *= 0.75;
  }

  return {
    key: best.key,
    score: Math.min(1, score),
    runnerUp,
    notes,
  };
}

/**
 * Assign a canonical key to every field on the page.
 *
 * Classification is per-field, but two things are collective: repeated rows
 * (so the 2nd "学校名称" knows it is row 2) and the "one field per key" rule,
 * which is relaxed for repeatable sections.
 */
export function classifyFields(fields: FieldDescriptor[]): FieldDescriptor[] {
  const counts = new Map<string, number>();

  return fields.map((field) => {
    const classification = classifyField(field);

    // Keep the classifier's guess, but let an explicitly-scanned section win.
    const section = field.section !== "unknown" ? field.section : sectionOfKey(classification.key);

    let key = classification.key;
    let confidence = classification.score;

    if (NEVER_AUTOFILL_KEYS.has(key)) confidence = 0;

    /*
     * Number repeated occurrences. In a repeatable section the 2nd 学校名称
     * genuinely refers to the applicant's 2nd school, so it gets an index and
     * the resolver can read education[1]. Elsewhere a duplicate key is almost
     * always a hidden template node or a search filter, so we demote rather
     * than pretend there are two of them.
     */
    let repeatIndex = field.repeatIndex;
    if (key !== "unknown") {
      const seen = counts.get(key) ?? 0;
      counts.set(key, seen + 1);
      if (seen > 0) {
        if (isRepeatable(section)) {
          repeatIndex = seen + 1;
        } else {
          confidence *= 0.75;
        }
      }
    }

    return {
      ...field,
      section,
      key,
      keyConfidence: confidence,
      ...(repeatIndex !== undefined ? { repeatIndex } : {}),
    };
  });
}

function isRepeatable(section: FieldSection): boolean {
  return section === "education" || section === "experience" || section === "project";
}

/**
 * Detect the group heading for a field from a list of preceding text nodes.
 * Used by the scanner, exposed here so the logic lives next to the taxonomy.
 */
export function guessSectionFromHeading(heading: string | undefined): FieldSection {
  if (!heading) return "unknown";
  return detectSection(heading);
}

/** Similarity used to attach a site-level label to a known key. */
export function labelMatchesKey(label: string, key: string): number {
  const definition = FIELD_DEFINITIONS.find((item) => item.key === key);
  if (!definition) return 0;
  let best = 0;
  for (const alias of definition.aliases) {
    const score = Math.max(termScore(label, alias), diceCoefficient(label, alias));
    if (score > best) best = score;
  }
  return best;
}
