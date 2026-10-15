/**
 * Text normalisation and matching.
 *
 * Job-application forms are bilingual, inconsistent about punctuation, and
 * fond of full-width characters. Everything downstream compares normalised
 * strings, so this module is the single definition of "normalised".
 */

/** Full-width punctuation and digits that appear constantly on zh-CN forms. */
const FULLWIDTH_MAP: Record<string, string> = {
  "\uFF08": "(",
  "\uFF09": ")",
  "\uFF1A": ":",
  "\uFF0C": ",",
  "\u3002": ".",
  "\uFF0F": "/",
  "\u3001": ",",
  "\uFF1B": ";",
  "\u2018": "'",
  "\u2019": "'",
  "\u201C": '"',
  "\u201D": '"',
  "\u3010": "[",
  "\u3011": "]",
  "\uFF0A": "*",
  "\uFF01": "!",
  "\uFF1F": "?",
  "\uFF0D": "-",
  "\u2010": "-",
  "\u2011": "-",
  "\u2013": "-",
  "\u2014": "-",
  "\u2212": "-",
  "\u00A0": " ",
  "\u2000": " ",
  "\u2001": " ",
  "\u3000": " ",
};

export function toHalfWidth(input: string): string {
  let out = "";
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    // Full-width ASCII block (U+FF01–U+FF5E) maps down by 0xFEE0.
    if (code >= 0xff01 && code <= 0xff5e) {
      out += String.fromCodePoint(code - 0xfee0);
      continue;
    }
    out += FULLWIDTH_MAP[ch] ?? ch;
  }
  return out;
}

/**
 * Canonical form for comparison: half-width, lower-cased, no punctuation, no
 * whitespace. Keeps CJK characters intact (they carry meaning, not noise).
 */
export function normalize(input: string | null | undefined): string {
  if (!input) return "";
  return toHalfWidth(input)
    .toLowerCase()
    .replace(/[\s\u3000]+/g, "")
    .replace(/[*\uFF0A]+/g, "")
    .replace(/[\u3001\u3002,.;:!?/\\|()[\]{}<>《》「」【】"'+~`^$%&@#=_\-]+/g, "");
}

/** Normalised but with single spaces preserved — for display-grade matching. */
export function normalizeWords(input: string | null | undefined): string {
  if (!input) return "";
  return toHalfWidth(input)
    .toLowerCase()
    .replace(/[\u3001\u3002,.;:!?/\\|()[\]{}<>《》「」【】"'+~`^$%&@#=_\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Strip an HTML-ish string down to readable text. */
export function stripHtml(input: string): string {
  return input
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Collapse whitespace without destroying line structure. */
export function tidy(input: string): string {
  return input
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Does the string contain any CJK ideograph? */
export function hasCjk(input: string): boolean {
  return /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/.test(input);
}

/** Count characters the way a human counts them: CJK = 1, latin run = 1 word. */
export function countChars(input: string): number {
  return [...input.replace(/\s/g, "")].length;
}

export function countWords(input: string): number {
  const cjk = hasCjk(input);
  if (cjk) return countChars(input);
  const words = input.trim().match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu);
  return words ? words.length : 0;
}

/* ------------------------------------------------------------ similarity */

/**
 * Character bigram Dice coefficient. Works for both scripts and is far more
 * forgiving than Levenshtein for short, partly-truncated labels such as
 * "Numéro de téléphone" vs "Telephone".
 */
export function diceCoefficient(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.length < 2 || nb.length < 2) return na === nb ? 1 : 0;

  const bigrams = (s: string): Map<string, number> => {
    const map = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i += 1) {
      const gram = s.slice(i, i + 2);
      map.set(gram, (map.get(gram) ?? 0) + 1);
    }
    return map;
  };

  const ga = bigrams(na);
  const gb = bigrams(nb);
  let overlap = 0;
  for (const [gram, count] of ga) {
    const other = gb.get(gram);
    if (other) overlap += Math.min(count, other);
  }
  return (2 * overlap) / (na.length - 1 + nb.length - 1);
}

/** True when `term` appears in `haystack` respecting CJK (no word breaks). */
export function containsTerm(haystack: string, term: string): boolean {
  const h = normalize(haystack);
  const t = normalize(term);
  if (!t) return false;
  return h.includes(t);
}

/**
 * Scores how well a term matches a label.
 *
 * The governing idea is *coverage*: how much of the label the term accounts
 * for. CJK has no word boundaries, so a regex boundary test is useless there —
 * what distinguishes "手机号码" inside "请填写手机号码" (a real match) from "姓"
 * inside "姓名" (a weaker one) is what fraction of the label is explained.
 *
 * Two guards matter as much as the score itself:
 *  - An exact match always returns 1 and is therefore never beaten by a
 *    shorter alias that happens to be contained in it.
 *  - Very short aliases ("姓", "to", "名") are only trusted when they account
 *    for a large share of a short label. Without this, the alias "to" matches
 *    "Why do you want to work here" and the field is classified as a date.
 */
export function termScore(haystack: string, term: string): number {
  const h = normalize(haystack);
  const t = normalize(term);
  if (!t || !h) return 0;
  if (h === t) return 1;
  if (!h.includes(t)) {
    // Fall back to fuzzy matching for typos and inflection.
    const dice = diceCoefficient(h, t);
    return dice > 0.72 ? dice * 0.8 : 0;
  }

  const coverage = t.length / h.length;

  // Guard: a 1-2 character alias cannot meaningfully match a long label.
  if (t.length <= 2 && (coverage < 0.4 || h.length > 8)) return 0;

  // Guard: a very short latin token must sit on a word boundary. Normalisation
  // removes punctuation, so we re-check against the raw label rather than the
  // normalised one.
  if (/^[a-z]+$/.test(t) && t.length <= 3 && h.length > t.length) {
    const boundary = new RegExp(`(^|[^a-z])${escapeRegExp(t)}([^a-z]|$)`, "i");
    if (!boundary.test(haystack) && !boundary.test(haystack.replace(/([a-z])([A-Z])/g, "$1 $2"))) {
      return 0;
    }
  }

  const startsAtZero = h.startsWith(t);
  const score = 0.8 + coverage * 0.2 + (startsAtZero ? 0.03 : 0);
  // Clamped below 1 so an exact match is always strictly the best candidate.
  return Math.min(0.99, score);
}

export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ---------------------------------------------------------------- parsing */

/** Pull a date range out of free text, respecting Chinese conventions. */
export function parseDateRange(input: string): import("./types.js").DateRange | undefined {
  const text = toHalfWidth(input);
  const current = /至今|现在|今天|present|current|now/i.test(text) || /今\s*$/.test(text.trim());

  /*
   * Split on range separators before parsing, so "2018.09 - 2022.06" gives two
   * independent segments. Parsing ranges with a single regex is what causes
   * "- 2022" to be misread as a day; splitting removes the ambiguity entirely.
   * Note that a hyphen inside "2020-03-01" is a *date* separator, so we only
   * split on separators that are surrounded by whitespace or that sit between
   * two complete dates.
   */
  const segments = text
    .split(/\s*[~至到]\s*|\s+-\s+|(?<=\d{4})\s*[—–]\s*|(?<=\d{2})\s*-\s*(?=\d{4})/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  const found: string[] = [];
  for (const segment of segments) {
    const parts = parseSingleDate(segment);
    if (parts) found.push(parts);
  }

  if (found.length === 0 && !current) return undefined;
  if (found.length === 0) return { current: true };
  if (found.length === 1) {
    return current ? { start: found[0], current: true } : { start: found[0] };
  }
  return { start: found[0], end: found[found.length - 1], current: false };
}

/**
 * Parse a single date. A 4-digit leading year is required; month and day are
 * optional and must be 1-2 digits each, so a trailing year can never be read as
 * a day.
 */
function parseSingleDate(segment: string): string | undefined {
  const match = segment.match(/^(?:.*?)((?:19|20)\d{2})(?:\s*[年/\-.]\s*(\d{1,2}))?(?:\s*[月/\-.]\s*(\d{1,2}))?/);
  if (!match) return undefined;
  const [, year, month, day] = match;
  if (!year) return undefined;
  if (!month) return year;
  const mm = pad2(month);
  if (!day) return `${year}-${mm}`;
  return `${year}-${mm}-${pad2(day)}`;
}

function pad2(value: string): string {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? String(n).padStart(2, "0") : value;
}

/** Split a blob of resume text into logical lines, keeping list structure. */
export function toLines(input: string): string[] {
  return tidy(input)
    .split("\n")
    .map((line) => line.replace(/^[\s\u2022\u25CF\u25AA\u002A\u002D\u2013\u2014·•▪◦]+/, "").trim())
    .filter((line) => line.length > 0);
}

/** Group lines into paragraphs, merging wrapped lines of the same sentence. */
export function toParagraphs(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const previous = out[out.length - 1];
    const continues = previous !== undefined && /[\p{L}\p{N},、，;；:：]$/u.test(previous);
    const isShort = line.length < 14 && !/[。.!?;；]$/.test(line);
    if (previous !== undefined && continues && isShort) {
      out[out.length - 1] = `${previous} ${line}`;
    } else {
      out.push(line);
    }
  }
  return out;
}

/** Truncate at a sentence boundary when possible, for field max-length limits. */
export function clampToLength(input: string, limit: number): string {
  if (limit <= 0 || countChars(input) <= limit) return input;
  const slice = [...input].slice(0, limit).join("");
  const breakpoints = ["。", "！", "？", ".", "!", "?", "；", ";", "，", ",", "、"];
  for (const mark of breakpoints) {
    const at = slice.lastIndexOf(mark);
    if (at > limit * 0.55) return slice.slice(0, at + 1);
  }
  return slice;
}

export function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export function uniqueBy<T>(items: T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = keyOf(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function titleCase(input: string): string {
  return input.replace(/\b([a-z])(\w*)/gi, (_, first: string, rest: string) => first.toUpperCase() + rest);
}

/** "2024-09" -> "2024.09" — the format zh-CN resumes overwhelmingly use. */
export function formatYm(value: string | undefined): string {
  if (!value) return "";
  const parts = value.split("-");
  if (parts.length === 1) return parts[0] ?? "";
  return `${parts[0]}.${parts[1]}`;
}

export function formatRange(range: import("./types.js").DateRange | undefined): string {
  if (!range) return "";
  const start = formatYm(range.start);
  const end = range.current ? "至今" : formatYm(range.end);
  if (start && end) return `${start} - ${end}`;
  return start || end;
}

/** "2024-09-01" -> "2024年9月1日" for Chinese date widgets. */
export function formatChineseDate(value: string | undefined): string {
  if (!value) return "";
  const [y, m, d] = value.split("-");
  if (!y) return "";
  if (!m) return `${y}年`;
  if (!d) return `${y}年${Number.parseInt(m, 10)}月`;
  return `${y}年${Number.parseInt(m, 10)}月${Number.parseInt(d, 10)}日`;
}
