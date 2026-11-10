/**
 * Matching a value against a closed option list.
 *
 * Selects, radio groups and checkbox groups only accept values they already
 * contain. Chinese recruitment systems add their own vocabulary: 男 / 男性 /
 * MALE / M; 本科 / 全日制本科 / 统招本科. This module decides which option a
 * value means, and refuses when the answer is not clear.
 */

import { diceCoefficient, normalize, termScore } from "../text.js";
import type { FieldOption, FieldValue } from "../types.js";

export interface OptionMatch {
  value: string;
  label: string;
  confidence: number;
}

/**
 * Synonym groups. Every member of a group is considered equivalent to the
 * first (canonical) member. Kept flat and explicit — a graph would be more
 * elegant and far harder to audit.
 */
const SYNONYM_GROUPS: string[][] = [
  /* gender */
  ["男", "男性", "male", "m", "man", "男士", "先生"],
  ["女", "女性", "female", "f", "woman", "女士"],
  /* yes / no */
  /*
   * "无" and "否" are the same answer to a yes/no question, and Chinese forms
   * mix them freely — the resume says 是否有亲属在本单位任职: 无 while the radio
   * options read 是 / 否. Without this they are two unrelated groups and the
   * field cannot be answered.
   */
  ["是", "yes", "y", "true", "有", "接受", "能", "可以", "同意", "愿意", "符合", "不介意"],
  ["否", "no", "n", "false", "无", "没有", "不接受", "不能", "否no", "不符合", "不愿意"],
  /* degree levels */
  [
    "博士",
    "博士研究生",
    "博士学历",
    "phd",
    "doctor",
    "doctorate",
    "doctoral",
    "博士学位",
  ],
  ["硕士", "硕士研究生", "研究生", "硕士学历", "master", "masters", "msc", "ma", "硕士学位", "硕士生"],
  ["本科", "大学本科", "本科生", "学士", "学士学位", "bachelor", "bachelors", "undergraduate", "ba", "bsc", "全日制本科", "统招本科"],
  ["大专", "专科", "专科生", "高职", "大专学历", "associate", "college diploma"],
  ["中专", "中等专业", "技校", "vocational"],
  ["高中", "普通高中", "高中毕业", "high school"],
  /* study mode */
  ["全日制", "统招", "普通全日制", "fulltime", "full time", "full-time"],
  ["非全日制", "在职", "parttime", "part time", "part-time", "non full-time"],
  /* fresh graduate */
  ["应届毕业生", "应届生", "应届", "fresh graduate", "new graduate", "graduate"],
  ["往届毕业生", "往届生", "往届", "非应届", "experienced hire"],
  /* political status */
  ["中共党员", "党员", "中国共产党党员", "共产党员", "cpc member", "party member"],
  ["中共预备党员", "预备党员"],
  ["共青团员", "团员", "共青团", "league member"],
  ["群众", "普通群众", "无党派", "masses"],
  ["民主党派", "民主党派成员", "democratic party"],
  /* marital status */
  ["未婚", "单身", "single", "unmarried"],
  ["已婚", "married"],
  ["离异", "离婚", "divorced"],
  /* id type */
  ["居民身份证", "身份证", "身份证号", "id card", "resident identity card"],
  ["护照", "passport"],
  ["港澳通行证", "港澳居民来往内地通行证"],
  ["台湾居民来往大陆通行证", "台胞证"],
  /* job type */
  ["全职", "全职工作", "fulltime", "full-time", "full time"],
  ["实习", "实习生", "intern", "internship", "trainee"],
  ["兼职", "parttime", "part-time", "part time"],
  ["校园招聘", "校招", "campus recruitment", "campus"],
  ["社会招聘", "社招", "experienced", "social recruitment"],
  /* health */
  ["健康", "良好", "正常", "健康良好", "good", "healthy", "normal", "无疾病"],
  /* ethnicity common */
  ["汉族", "汉", "han"],
  /* common availability */
  ["随时到岗", "立即到岗", "一周内", "immediately", "immediate", "asap"],
  ["一个月内", "1个月内", "30天内", "within one month", "one month"],
  ["三个月内", "3个月内", "within three months"],
];

const SYNONYM_INDEX: Map<string, number> = (() => {
  const index = new Map<string, number>();
  SYNONYM_GROUPS.forEach((group, groupIndex) => {
    for (const term of group) index.set(normalize(term), groupIndex);
  });
  return index;
})();

function synonymGroup(value: string): number | undefined {
  const normalized = normalize(value);
  if (!normalized) return undefined;
  const direct = SYNONYM_INDEX.get(normalized);
  if (direct !== undefined) return direct;
  // "男性（Male）" and similar wrappers: try the value with brackets removed.
  const inner = normalized.replace(/^[\[({\uFF08]+|[\])}\uFF09]+$/g, "");
  return inner === normalized ? undefined : SYNONYM_INDEX.get(inner);
}

/**
 * Numeric-ish comparison: "8k", "8000", "8000元" should all agree.
 *
 * Salary bands are ranges ("8000-12000元", "8千-1.2万"), so a value matches
 * when it falls inside the option's span rather than exactly on a number.
 * We read the numbers from the *raw* label, because normalisation strips the
 * separators that tell one number from the next.
 */
function numericTokens(input: string): number[] {
  const out: number[] = [];
  const re = /(\d+(?:\.\d+)?)\s*(万|w|k|千)?/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input)) !== null) {
    const base = Number.parseFloat(match[1] ?? "");
    if (!Number.isFinite(base)) continue;
    const unit = (match[2] ?? "").toLowerCase();
    out.push(unit === "万" || unit === "w" ? base * 10000 : unit === "k" || unit === "千" ? base * 1000 : base);
  }
  return out;
}

/** A single magnitude for a value, or undefined when it is not numeric. */
function numericValue(input: string): number | undefined {
  return numericTokens(input)[0];
}

/**
 * Turn a class rank into a percentile.
 *
 * Chinese forms often ask for a band (“前5% / 前10% / 前20% / 其他”) while the
 * resume stores a concrete rank (“6/140”, “第 6 名 / 共 140 人”). Comparing the
 * numbers directly found nothing, so a required 成绩排名 select stayed empty
 * even though the answer was derivable from the profile.
 */
function percentileOf(input: string): number | undefined {
  const fraction = input.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
  if (fraction) {
    const numerator = Number(fraction[1]);
    const denominator = Number(fraction[2]);
    if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0) {
      return (numerator / denominator) * 100;
    }
  }

  const percent = input.match(/(\d+(?:\.\d+)?)\s*%/);
  if (percent) {
    const value = Number(percent[1]);
    if (Number.isFinite(value)) return value;
  }

  const rank = input.match(/第\s*(\d+)\s*名/);
  if (rank) {
    const total = input.match(/(?:共|总人数|总计|of)\s*(\d+)/);
    if (total && Number(total[1]) > 0) {
      return (Number(rank[1]) / Number(total[1])) * 100;
    }
  }
  return undefined;
}

/** The upper edge of a “前 10% / top 10%” option, or undefined. */
function percentileBand(label: string): number | undefined {
  const match = label.match(/(?:前|top)\s*(\d+(?:\.\d+)?)\s*%/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

function isOtherOption(label: string): boolean {
  return /^(其他|其它|other)$/i.test(normalize(label));
}

/** 0-1 score for how well `value` means `option`. */
export function scoreOption(value: FieldValue, option: FieldOption): number {
  const optionLabel = option.label || option.value;
  const candidates = [value.text, value.raw].filter((item): item is string => Boolean(item));

  let best = 0;
  for (const candidate of candidates) {
    const candidateNorm = normalize(candidate);
    const optionNorm = normalize(optionLabel);
    const optionValueNorm = normalize(option.value);
    if (!candidateNorm) continue;

    // Exact match on either the label or the underlying value.
    if (candidateNorm === optionNorm || candidateNorm === optionValueNorm) {
      best = Math.max(best, 1);
      continue;
    }

    // Shared synonym group.
    const candidateGroup = synonymGroup(candidate);
    const optionGroup = synonymGroup(optionLabel) ?? synonymGroup(option.value);
    if (candidateGroup !== undefined && candidateGroup === optionGroup) {
      best = Math.max(best, 0.96);
      continue;
    }

    /*
     * Numeric agreement for salary bands and similar scales.
     *
     * The tiers are ordered deliberately. "8000" against the options
     * "8000元以下" and "8000-12000元" is genuinely on a boundary, and the right
     * answer is the range whose floor it is: a person saying "8000" is stating
     * a target, and "below 8000" would mean they are asking for less than they
     * said. So floor-equality is the strongest signal, plain containment next,
     * and an open-ended bound only a weak fallback.
     */
    const candidateNumber = numericValue(candidate);
    if (candidateNumber !== undefined) {
      const optionNumbers = numericTokens(optionLabel);
      if (optionNumbers.length === 1) {
        const only = optionNumbers[0]!;
        const lowered = optionLabel.toLowerCase();
        const isUpperBound = /(以下|以内|below|under|less than|max|最多)/.test(lowered);
        const isLowerBound = /(以上|起|over|above|more than|min|至少)/.test(lowered);
        if (isUpperBound) {
          if (candidateNumber <= only) best = Math.max(best, 0.86);
        } else if (isLowerBound) {
          if (candidateNumber >= only) best = Math.max(best, 0.86);
        } else if (Math.abs(candidateNumber - only) < 1) {
          best = Math.max(best, 0.9);
        }
      } else if (optionNumbers.length >= 2) {
        const low = Math.min(...optionNumbers);
        const high = Math.max(...optionNumbers);
        if (Math.abs(candidateNumber - low) < 1) best = Math.max(best, 0.93);
        else if (candidateNumber > low && candidateNumber <= high) best = Math.max(best, 0.9);
      }
      if (best >= 0.86) continue;
    }

    // Containment, guarded by length so "男" does not match "男女不限"
    // (which it should — but "女" must not match "男").
    if (optionNorm.includes(candidateNorm) && candidateNorm.length >= 2) {
      best = Math.max(best, 0.82);
      continue;
    }
    if (candidateNorm.includes(optionNorm) && optionNorm.length >= 2) {
      best = Math.max(best, 0.8);
      continue;
    }

    // Fuzzy fallback for typos and inflections.
    const score = Math.max(termScore(optionLabel, candidate), diceCoefficient(candidate, optionLabel));
    if (score > 0.85) best = Math.max(best, score * 0.9);
  }

  return best;
}

const MIN_OPTION_CONFIDENCE = 0.8;

/**
 * Pick the option a value refers to. Returns `undefined` when no option clears
 * the confidence bar, or when two options are equally plausible.
 */
export function matchOption(
  value: FieldValue,
  options: FieldOption[],
): OptionMatch | undefined {
  if (options.length === 0) return undefined;

  const searchable = options.filter((option) => !option.disabled);
  if (searchable.length === 0) return undefined;

  /*
   * Percentile bands first: they are a closed vocabulary (“前5% / 前10% /
   * 前20%”), and the profile's “6/140” has to be converted before ordinary
   * string scoring can see it. Only engage when the option list really contains
   * bands, so a stray percentage never turns an unrelated “其他” into a match.
   */
  const percentile = [value.text, value.raw]
    .filter((item): item is string => Boolean(item))
    .map(percentileOf)
    .find((item): item is number => item !== undefined);
  if (percentile !== undefined) {
    const bands: Array<{ option: FieldOption; band: number }> = [];
    for (const option of searchable) {
      const band = percentileBand(option.label || option.value);
      if (band !== undefined) bands.push({ option, band });
    }
    if (bands.length > 0) {
      const containing = bands
        .filter((entry) => percentile <= entry.band + 1e-9)
        .sort((a, b) => a.band - b.band)[0];
      if (containing) {
        return {
          value: containing.option.value,
          label: containing.option.label,
          confidence: 0.94,
        };
      }
      const other = searchable.find((option) => isOtherOption(option.label));
      if (other) return { value: other.value, label: other.label, confidence: 0.88 };
    }
  }

  const scored = searchable
    .map((option) => ({
      option,
      score: scoreOption(value, option),
    }))
    .filter((entry) => entry.score >= MIN_OPTION_CONFIDENCE)
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
  if (!top) return undefined;

  // A tie between different options means we cannot decide.
  const runnerUp = scored[1];
  if (runnerUp && Math.abs(runnerUp.score - top.score) < 0.02 && normalize(runnerUp.option.label) !== normalize(top.option.label)) {
    return undefined;
  }

  return { value: top.option.value, label: top.option.label, confidence: top.score };
}

/**
 * Match several values at once (checkbox groups, multi-selects). Returns the
 * options that matched, plus the ones that did not so the UI can disclose
 * what it dropped.
 */
export function matchOptions(
  values: string[],
  options: FieldOption[],
): { matched: OptionMatch[]; unmatched: string[] } {
  const matched: OptionMatch[] = [];
  const unmatched: string[] = [];
  const taken = new Set<string>();

  for (const raw of values) {
    const value: FieldValue = { text: raw };
    const available = options.filter((option) => !taken.has(option.value) && !option.disabled);
    const match = matchOption(value, available);
    if (match) {
      taken.add(match.value);
      matched.push(match);
    } else {
      unmatched.push(raw);
    }
  }
  return { matched, unmatched };
}

/** All canned groups, exposed so the UI can explain a match. */
export function synonymsOf(value: string): string[] {
  const group = synonymGroup(value);
  if (group === undefined) return [];
  return SYNONYM_GROUPS[group] ?? [];
}
