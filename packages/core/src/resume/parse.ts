/**
 * Turning resume text into a Profile.
 *
 * The parser is deliberately conservative: it fills what it can prove from the
 * text and leaves everything else empty rather than guessing. Every value it
 * writes records the source line, because the UI has to be able to answer
 * "where did you get that?" for every field it offers to type.
 */

import {
  clampToLength,
  containsTerm,
  formatRange,
  normalize,
  parseDateRange,
  tidy,
  toLines,
  unique,
} from "../text.js";
import {
  matchHeading,
  ORG_MARKER,
  segmentResume,
  splitEntries,
  splitHeaderFields,
  stripDateRange,
  type ResumeSection,
} from "./segment.js";
import {
  classifyEducationMetric,
  cleanPersonName,
  extractFlexibleLocation,
  extractGraduationDate,
  extractHeaderSemantics,
  findCity,
  inferAcademicDegree,
  isGpaValue,
  looksLikeGraduation,
  mergeSemantics,
  parseCities,
  type ResumeSemantics,
} from "./semantics.js";
import { experienceKindFromLabel, experienceKindFromText } from "../strategy/experience.js";
import { hiringTrackFromLabel } from "../strategy/recruitment.js";
import {
  type Contact,
  type Education,
  type Essays,
  type Experience,
  type Identity,
  type JobPreference,
  type Profile,
  type Project,
  type ProjectCategory,
  type Skill,
  emptyProfile,
} from "../types.js";

/* --------------------------------------------------------------- primitives */

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/u;
/** Chinese mobile, then generic international with separators. */
const PHONE_CN = /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/;
const PHONE_INTL = /(?<!\d)(?:\+\d{1,3}[-\s]?)?(?:\(?\d{2,4}\)?[-\s]?)?\d{3,4}[-\s]?\d{3,4}(?!\d)/;
const DATE_TOKEN = /(19|20)\d{2}\s*(?:[年/\-.]\s*\d{1,2})?/;
const URL = /(?:https?:\/\/)?(?:www\.)?[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+(?:\/[\p{L}\p{N}\-_./?%&=#+]*)?/giu;

const DEGREE_LEVELS = ["博士", "硕士", "研究生", "本科", "学士", "大专", "专科", "高中", "中专", "MBA", "博士研究生", "硕士研究生"];
const ACADEMIC_DEGREES = ["博士学位", "硕士学位", "学士学位", "博士", "硕士", "学士"];
const GENDER_TOKENS = ["男", "女", "male", "female", "femenino", "masculino", "femme", "homme"];
const POLITICAL_TOKENS = [
  "中共党员",
  "中共预备党员",
  "共青团员",
  "民主党派",
  "群众",
  "党员",
  "预备党员",
  "无党派人士",
  "团员",
  "共产党员",
];
const ETHNICITY_TOKENS = ["汉族", "回族", "满族", "蒙古族", "壮族", "维吾尔族", "苗族", "彝族", "土家族", "藏族", "朝鲜族", "侗族", "瑶族", "白族", "布依族"];
const AWARD_OR_HONOR =
  /(奖学金|奖|竞赛|大赛|比赛|冠军|亚军|季军|一等奖|二等奖|三等奖|金奖|银奖|铜奖|荣誉|优秀|标兵|三好|称号|证书|scholarship|award|prize|honou?r|competition|contest|medal)/i;
const CERTIFICATE =
  /(证书|certificate|certification|资格证|等级证|CET|雅思|托福|IELTS|TOEFL|GRE|GMAT|CPA|CFA|PMP|驾照)/i;
/** A page title is not the person's name. */
const NOT_A_NAME = /^(个人简历|求职简历|应聘简历|简历|履历|resume|curriculum vitae|cv|个人资料|基本信息)$/i;

function firstMatch(text: string, pattern: RegExp): string | undefined {
  const match = text.match(pattern);
  return match?.[0]?.trim() || undefined;
}

function pickToken(text: string, tokens: string[]): string | undefined {
  // Longest token first so "中共党员" beats "党员".
  const sorted = [...tokens].sort((a, b) => b.length - a.length);
  for (const token of sorted) {
    if (containsTerm(text, token)) return token;
  }
  return undefined;
}

/** Dates found in an entry header, in order. */
function datesIn(text: string): string[] {
  const out: string[] = [];
  const re = /((?:19|20)\d{2})\s*(?:[年/\-.]\s*(\d{1,2}))?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const year = match[1] ?? "";
    const month = match[2];
    out.push(month ? `${year}-${month.padStart(2, "0")}` : year);
  }
  return out;
}

function isDateLine(line: string): boolean {
  return /(19|20)\d{2}/.test(line) && /[-~—–至到]|至今|现在|present|current/.test(line);
}

/** Pull "字段: 值" pairs out of a line. */
function pairsIn(line: string): Array<[string, string]> {
  /*
   * Resumes pack several pairs onto one line: "现居:杭州市  微信:zs_dev".
   * Splitting on whitespace that precedes a labelled value recovers both, and
   * it survives the whitespace collapsing done by `tidy`. A second pass with a
   * global regex catches pairs glued together without whitespace, e.g.
   * "性别:男民族:汉族".
   */
  const out: Array<[string, string]> = [];
  const parts = line.split(/[|｜;；]{1,}|\s+(?=[\p{L}\u4E00-\u9FFF][\p{L}\u4E00-\u9FFF ]{0,14}[:：])/u);
  for (const part of parts) {
    const pairs = part.matchAll(/([\p{L}\u4E00-\u9FFF][\p{L}\u4E00-\u9FFF\d ]{0,20})[:：]([^:：|｜;；]+)/gu);
    let matched = false;
    for (const match of pairs) {
      const key = match[1]?.trim() ?? "";
      const value = match[2]?.trim() ?? "";
      if (!key || !value) continue;
      // A 20-character "label" is a sentence, not a field name.
      if (key.length > 20) continue;
      out.push([key, value]);
      matched = true;
    }
    if (matched) continue;
    // No colon at all: the caller may still want the raw part.
    const at = part.search(/[:：]/);
    if (at > 0 && at < 24) {
      const key = part.slice(0, at).trim();
      const value = part.slice(at + 1).trim();
      if (key && value) out.push([key, value]);
    }
  }
  return out;
}

/* ----------------------------------------------------------------- identity */

const IDENTITY_LABELS: Record<string, keyof Identity> = {
  姓名: "fullName",
  name: "fullName",
  性别: "gender",
  gender: "gender",
  sex: "gender",
  民族: "ethnicity",
  籍贯: "nativePlace",
  出生年月: "birthDate",
  出生日期: "birthDate",
  生日: "birthDate",
  政治面貌: "politicalStatus",
  政治身份: "politicalStatus",
  身高: "height",
  体重: "weight",
  婚姻状况: "maritalStatus",
  身份证号: "idNumber",
  健康状况: "healthStatus",
  户口所在地: "household",
  户籍: "household",
  国籍: "nationality",
  英文名: "englishName",
  姓名拼音: "namePinyin",
  出生地: "birthPlace",
  出生地点: "birthPlace",
  血型: "bloodType",
  户口性质: "household",
  户籍所在地: "household",
};

function parseIdentity(
  header: string[],
  section: ResumeSection | undefined,
  fullText: string,
): { identity: Identity; contact: Contact; hints: ResumeSemantics } {
  const identity: Identity = {};
  const contact: Contact = {};
  const lines = [...header, ...(section?.lines ?? [])];
  const joined = lines.join(" ");
  const hints: ResumeSemantics = {};

  /*
   * Email and phone are unambiguous, and they are the two fields every form
   * needs. Search the whole document, not just the header: a two-column resume
   * often puts them in a right-hand sidebar, and a resume with an unexpected
   * first heading pushes them out of `header`.
   */
  const contactText = `${fullText}\n${joined}`;
  const email = firstMatch(contactText, EMAIL);
  if (email) contact.email = email;

  const phone = firstMatch(contactText, PHONE_CN);
  if (phone) contact.phone = phone.replace(/\s+/g, "");
  else {
    const intl = firstMatch(contactText, PHONE_INTL);
    // Guard against picking up a year range or an ID number.
    if (intl && intl.replace(/\D/g, "").length >= 8 && !/^(19|20)\d{2}/.test(intl)) {
      contact.phone = intl.replace(/\s+/g, "");
    }
  }

  // "姓名：张三" style lines are the most reliable source.
  for (const line of lines) {
    for (const [rawKey, rawValue] of pairsIn(line)) {
      const key = IDENTITY_LABELS[normalize(rawKey)] ?? IDENTITY_LABELS[rawKey];
      if (!key) continue;
      const value = rawValue.trim();
      if (!value) continue;
      switch (key) {
        case "fullName": {
          /*
           * A label is not a boundary. “姓名：赵康伟 目前在京，可一周内到岗”
           * used to put the whole sentence into the name field. Split the
           * person out and keep the rest as header hints, where the city and
           * availability parsers can see it.
           */
          const cleaned = cleanPersonName(value);
          if (cleaned.name) identity.fullName = cleaned.name;
          else if (/^[一-鿿·]{2,16}$/.test(value) && !NOT_A_NAME.test(value)) identity.fullName = value.trim();
          if (cleaned.residue) mergeSemantics(hints, extractHeaderSemantics(cleaned.residue));
          break;
        }
        case "gender":
          identity.gender = pickToken(value, GENDER_TOKENS) ?? value;
          break;
        case "birthDate": {
          const range = parseDateRange(value);
          identity.birthDate = range?.start ?? value;
          break;
        }
        case "ethnicity":
          identity.ethnicity = pickToken(value, ETHNICITY_TOKENS) ?? value;
          break;
        case "politicalStatus":
          identity.politicalStatus = pickToken(value, POLITICAL_TOKENS) ?? value;
          break;
        default:
          if (key in identity) (identity as Record<string, unknown>)[key] = value;
      }
    }
  }

  // Token sweeps for the fields that are almost always stated bare.
  if (!identity.gender) {
    const gender = pickToken(joined, GENDER_TOKENS);
    if (gender) identity.gender = gender;
  }
  if (!identity.politicalStatus) {
    const status = pickToken(joined, POLITICAL_TOKENS);
    if (status) identity.politicalStatus = status;
  }
  if (!identity.ethnicity) {
    const ethnicity = pickToken(joined, ETHNICITY_TOKENS);
    if (ethnicity) identity.ethnicity = ethnicity;
  }
  if (!identity.birthDate) {
    // A bare date in the *header block* is the date of birth — that is where
    // zh-CN resumes put it ("张三 | 男 | 1999.03 | 13800138000"). We require
    // month precision and a plausible year so a graduation year or a phone
    // fragment cannot be mistaken for it.
    const bare = lines
      .slice(0, 6)
      .flatMap((line) => splitHeaderFields(line))
      .map((part) => part.trim())
      .find((part) => {
        const match = part.match(/^(19\d{2}|20[0-2]\d)\s*[.\-/年]\s*(\d{1,2})\s*月?$/);
        if (!match) return false;
        const year = Number.parseInt(match[1] ?? "0", 10);
        const month = Number.parseInt(match[2] ?? "0", 10);
        return year >= 1950 && year <= 2012 && month >= 1 && month <= 12;
      });
    if (bare) {
      const range = parseDateRange(bare);
      if (range?.start) identity.birthDate = range.start;
    }
  }
  if (!identity.birthDate) {
    // Labelled birth dates anywhere in the document.
    const dobLine = lines.find((line) => /出生|生日|date of birth|birth/i.test(line));
    if (dobLine) {
      const range = parseDateRange(dobLine);
      if (range?.start) identity.birthDate = range.start;
    }
  }

  // Name fallback: on Chinese resumes the first non-empty header line that is
  // 2-4 CJK characters is the name.
  if (!identity.fullName) {
    for (const line of header.slice(0, 6)) {
      const trimmed = line.trim();
      if (NOT_A_NAME.test(normalize(trimmed)) || NOT_A_NAME.test(trimmed)) continue;
      // A school, employer, email or phone line is never the person's name.
      if (/[@\d]|https?:/i.test(trimmed) || ORG_MARKER.test(trimmed)) continue;
      const cleaned = cleanPersonName(trimmed);
      if (cleaned.name) {
        identity.fullName = cleaned.name;
        if (cleaned.residue) mergeSemantics(hints, extractHeaderSemantics(cleaned.residue));
        break;
      }
    }
  }

  // Links.
  for (const url of joined.match(URL) ?? []) {
    const lower = url.toLowerCase();
    if (lower.includes("github") || lower.includes("gitee") || lower.includes("gitlab")) {
      contact.github ??= url;
    } else if (lower.includes("linkedin")) {
      contact.linkedin ??= url;
    } else if (!lower.includes("@") && !lower.includes("mailto")) {
      contact.homepage ??= url;
    }
  }

  // City / address lines.
  for (const line of lines) {
    for (const [rawKey, rawValue] of pairsIn(line)) {
      const key = normalize(rawKey);
      if (/^(现居|现居住地|当前所在地|所在城市|现居城市|location|city)/.test(key)) {
        // “杭州市西湖区” is a city for a form; the street address belongs in
        // `address`, not in the city input.
        contact.currentCity ??= findCity(rawValue) ?? rawValue.trim();
      } else if (/^(地址|通讯地址|联系地址|现住址|address)/.test(key)) {
        contact.address ??= rawValue.trim();
      } else if (/^(微信|wechat)/.test(key)) {
        contact.wechat ??= rawValue.trim();
      } else if (/^(邮编|postal|zip)/.test(key)) {
        contact.postalCode ??= rawValue.trim();
      }
    }
  }

  /*
   * Header-only facts that do not belong to a labelled identity field:
   * “目前在京” is the current city, “可一周内到岗” is availability, and
   * “求职方向：产品经理” is a preference. Reading them here keeps them from
   * being swallowed by the name line or lost entirely.
   */
  mergeSemantics(hints, extractHeaderSemantics([...lines, joined].join("\n")));
  if (!contact.currentCity && hints.currentCity) contact.currentCity = hints.currentCity;

  // Age is derived, never stored as fact.
  return { identity, contact, hints };
}

/* ---------------------------------------------------------------- education */

function parseEducation(section: ResumeSection | undefined, warnings: string[] = []): Education[] {
  if (!section) return [];
  const SCHOOL_MARKER = /(大学|学院|学校|中学|高中|university|college|institute|academy|école)/i;
  const NON_EDUCATION_ORG =
    /(有限公司|有限责任公司|股份|公司|集团|银行|医院|工作室|事务所|科技(?!大学|学院|学校)|\b(?:company|corporation|inc\.?|ltd\.?|corp\.?)\b)/i;
  const NON_EDUCATION_LABEL =
    /^(?:技术栈|专业技能|技能|编程语言|开发语言|开发工具|工具|框架|中间件|数据库|工作单位|任职单位|实习单位|公司|岗位|职位|职务|项目名称|项目角色|工作内容)(?:[:：\s|｜]|$)/i;
  const EDUCATION_LABEL =
    /^(?:学校|院校|毕业院校|school|university|专业|major|specialty|学历|degree|education|学位|academic|主修课程|课程|coursework|学习形式|培养方式|入学时间|毕业时间|平均分|平均成绩|加权平均分|学制)/i;
  const isEducationLabel = (key: string, value: string) =>
    classifyEducationMetric(key, value) !== undefined || EDUCATION_LABEL.test(normalize(key));
  const entries = splitEntries(section.lines, "education");
  const out: Education[] = [];
  const NOT_A_MAJOR =
    /^(全日制|非全日制|统招|在读|毕业|本科|硕士|博士|研究生|学士|大专|专科|高中|中专|gpa|绩点|排名|rank|技术栈|专业|技能|编程语言|[（(]?\d)/i;
  let skippedNonEducationLines = false;

  entries.forEach((entry, index) => {
    const educationLines = entry.filter((line) => {
      const trimmed = line.trim();
      const pairs = pairsIn(trimmed);
      const hasUnknownLabel = pairs.some(([key, value]) => !isEducationLabel(key, value));
      const isBusinessOrganization = NON_EDUCATION_ORG.test(trimmed) && !SCHOOL_MARKER.test(trimmed);
      if (NON_EDUCATION_LABEL.test(trimmed) || hasUnknownLabel || isBusinessOrganization) {
        skippedNonEducationLines = true;
        return false;
      }
      return true;
    });
    const text = educationLines.join("\n");
    if (!text.trim()) return;
    const education: Education = { id: `edu-${index + 1}` };

    // Lines that are only a date range describe the whole entry.
    const dateLine = educationLines.find((line) => isDateLine(line));
    if (dateLine) education.dates = parseDateRange(dateLine);

    for (const line of educationLines) {
      // "北京大学 计算机科学与技术 本科 2018-2022" — strip the range first so
      // "2018-2022" cannot be mistaken for a GPA or a course list.
      const headerOnly = stripDateRange(line);
      const parts = splitHeaderFields(headerOnly);
      const linePairs = pairsIn(line);
      for (const [rawKey, rawValue] of linePairs) {
        const key = normalize(rawKey);
        const value = rawValue.trim();
        /*
         * “成绩排名：18%” is a rank and “GPA：3.8/4.0” is a GPA. This has to
         * run before the `专业` and `成绩` label tests: otherwise “专业排名”
         * matches the major pattern and 18% becomes the person's major.
         */
        const metric = classifyEducationMetric(rawKey, value);
        if (metric === "rank") education.rank = value.replace(/^排名[:：]?\s*/, "").trim();
        else if (metric === "gpa") education.gpa = value;
        else if (/^(学校|院校|毕业院校|school|university)/.test(key)) education.school = value;
        else if (/^(专业|major|specialty)/.test(key)) education.major = value;
        else if (/^(学历|degree|education)/.test(key)) education.degree = pickToken(value, DEGREE_LEVELS) ?? value;
        else if (/^(学位|academic)/.test(key)) education.academicDegree = pickToken(value, ACADEMIC_DEGREES) ?? value;
        else if (/^(主修课程|课程|coursework)/.test(key)) education.courses = value;
      }

      // Unlabelled lines: require a school marker, or an academic marker on the
      // same line before accepting a marker-free institution name.
      if (!education.school && linePairs.length === 0) {
        const school = parts.find(
          (part) => SCHOOL_MARKER.test(part) && !AWARD_OR_HONOR.test(part) && !/[。；;]/.test(part),
        );
        if (school) {
          // "Shanghai Jiao Tong University, Shanghai" — the trailing city is
          // part of the same field on latin resumes; split it off so the form's
          // 院校所在地 field can be filled too.
          const [name, ...rest] = school.split(/,\s*/);
          education.school = (name ?? "")
            .replace(/\s*(本科|硕士|博士|研究生|学士).*$/, "")
            .trim();
          const city = rest.join(", ").trim();
          if (city && !education.city) education.city = city;
        } else if (
          parts.length >= 2 &&
          (DATE_TOKEN.test(line) || pickToken(line, DEGREE_LEVELS) !== undefined) &&
          !DATE_TOKEN.test(parts[0] ?? "") &&
          (parts[0] ?? "").length <= 30 &&
          !AWARD_OR_HONOR.test(parts[0] ?? "") &&
          !NON_EDUCATION_ORG.test(parts[0] ?? "") &&
          !/[。；;]/.test(parts[0] ?? "")
        ) {
          education.school = parts[0];
        }
      }
      if (!education.major && linePairs.length === 0) {
        /*
         * Unlabelled majors must look like a discipline. Accepting any short
         * token here turns nearby company names, product names, and skills into
         * a major when section text has been flattened or interleaved.
         */
        const usable = (part: string): boolean => {
          const candidate = part.trim();
          if (candidate.length < 2 || candidate.length > 24) return false;
          if (SCHOOL_MARKER.test(candidate)) return false;
          if (AWARD_OR_HONOR.test(candidate) || /[。；;，,]/.test(candidate)) return false;
          if (NOT_A_MAJOR.test(candidate)) return false;
          if (/(排名|gpa|绩点|成绩|rank)/i.test(candidate)) return false;
          if (/\d+\s*\/\s*\d+|\d+%|^前\s*\d/.test(candidate)) return false;
          if (/^(北京|上海|深圳|广州|杭州|成都|南京|武汉|西安|苏州|天津|重庆|长沙|青岛|合肥|中国|china)$/i.test(candidate)) {
            return false;
          }
          return true;
        };
        const discipline =
          /(工程|科学|技术|管理|经济|金融|会计|统计|设计|传播|法学|医学|护理|药学|数学|物理|化学|生物|文学|教育|英语|日语|外语|新闻|艺术|历史|哲学|心理|社会|公共|建筑|土木|机械|电气|材料|环境|能源|信息|电子|通信|自动化|软件|计算机|人工智能|智能|数据|网络|安全|物联网|机器人|营销|商务|贸易|人力|资源|农业|食品|交通|物流|航空|海洋|翻译|computer science|engineering|economics|finance|accounting|statistics|physics|chemistry|biology|psychology|journalism|education|design|linguistics|english|medicine|law)/i;
        const major = parts.find((part) => discipline.test(part) && usable(part));
        if (major) {
          education.major = major
            .replace(/^专业[:：]?/, "")
            .replace(/[,，]?\s*\d{4}.*$/, "")
            .trim();
        }
      }
      if (!education.degree) {
        const degree = pickToken(headerOnly, DEGREE_LEVELS);
        if (degree) education.degree = degree;
      }
      if (!education.academicDegree) {
        const academic = pickToken(headerOnly, ACADEMIC_DEGREES);
        if (academic && academic !== education.degree) education.academicDegree = academic;
      }
      if (!education.rank) {
        const rank = headerOnly.match(
          /(?:(?:专业|年级|班级|综合|成绩)?排名|rank)[:：\s]*(前\s*\d+(?:\.\d+)?%|\d+\s*\/\s*\d+|第\s*\d+\s*名|\d+(?:\.\d+)?%)/i,
        );
        if (rank?.[1]) education.rank = rank[1].trim();
      }
      if (!education.gpa) {
        const gpa = headerOnly.match(
          /(?:gpa|绩点|平均分|平均成绩|加权平均分|成绩(?!排名))[:：\s]*(\d{1,3}(?:\.\d{1,2})?(?:\s*\/\s*\d{1,3}(?:\.\d{1,2})?)?%?)/i,
        );
        const value = gpa?.[1]?.trim();
        // “18%” is a rank or a percentage score, never a GPA on a 4/5/100 scale.
        if (value && isGpaValue(value)) education.gpa = value;
      }
      if (!education.dates) {
        const range = parseDateRange(line);
        if (range) education.dates = range;
      }
    }

    // Honor / scholarship / competition lines inside an education entry.
    const honors = educationLines.filter((line) => AWARD_OR_HONOR.test(line));
    if (honors.length > 0) education.honors = unique(honors.map((line) => line.trim()));

    /*
     * “本科” implies 学士 and “硕士研究生” implies 硕士. Forms usually ask for
     * both 学历 and 学位; deriving the second from the first is not invention,
     * it is the definition of the qualification.
     */
    if (!education.academicDegree) {
      const inferred = inferAcademicDegree(education.degree);
      if (inferred) education.academicDegree = inferred;
    }
    if (!education.studyMode) {
      education.studyMode = pickToken(text, ["全日制", "非全日制", "统招", "定向", "委培"]);
    }

    if (education.school || education.major || education.degree) out.push(education);
  });

  // If we found degrees but no schools, keep them — some resumes list only the
  // qualification (e.g. a certificate-focused CV).
  if (skippedNonEducationLines) {
    warnings.push("教育经历区块中发现疑似单位或非教育标签，相关内容未用于学校/专业识别，请核对。");
  }
  return out;
}

/* --------------------------------------------------------------- experience */

/**
 * The first block of an entry, up to three short non-bullet lines. The first
 * long sentence or bullet is where the description starts.
 */
function splitEntryHeader(entry: string[]): { header: string[]; body: string[] } {
  const header: string[] = [];
  let index = 0;
  // Description lines usually begin with an action, not with an organisation.
  // Without this, three short bullets were consumed as a three-line header and
  // the entry lost its highlights.
  const BODY_START =
    /^(负责|主导|参与|使用|优化|设计|开发|实现|搭建|推动|完成|协助|独立|基于|通过|针对|根据|撰写|分析|管理|维护|带领|组织|落地|重构|建设|支持|保障|研究|探索|制定|输出|跟进|对接|协调|配合|built|led|developed|designed|implemented|created|managed|reduced|improved|increased|optimized|conducted|analyzed|collaborated|responsible|worked|using|through|based)/i;

  for (; index < entry.length && header.length < 3; index += 1) {
    const line = (entry[index] ?? "").trim();
    if (!line) continue;
    if (/^[•●▪*-–—·•▪◦]/.test(line)) break;
    if (line.length > 90 || /[。；;]$/.test(line)) break;
    if (header.length > 0 && BODY_START.test(line)) break;
    // A prose line with a comma, and no date or pipe to mark it as an entry
    // header, is description rather than header.
    if (header.length > 0 && /[，,]/.test(line) && !/(19|20)\d{2}|[|｜·•]/.test(line)) break;
    header.push(line);
  }

  return { header, body: entry.slice(index) };
}

function parseExperience(section: ResumeSection | undefined): Experience[] {
  if (!section) return [];
  const entries = splitEntries(section.lines, "experience");
  const sectionKind = experienceKindFromLabel(section.heading);
  const out: Experience[] = [];

  entries.forEach((entry, index) => {
    if (entry.length === 0) return;
    const experience: Experience = {
      id: `exp-${index + 1}`,
      highlights: [],
      ...(sectionKind
        ? { employmentType: sectionKind === "internship" ? "实习" : "工作" }
        : {}),
    };
    const dateLine = entry.find((line) => isDateLine(line));
    if (dateLine) experience.dates = parseDateRange(dateLine);
    let explicitEmploymentType = false;

    for (const line of entry) {
      for (const [rawKey, rawValue] of pairsIn(line)) {
        const key = normalize(rawKey);
        const value = rawValue.trim();
        if (!value) continue;
        if (/^(公司|单位|雇主|company|employer|organization)/.test(key)) experience.company = value;
        else if (/^(部门|department|division)/.test(key)) experience.department = value;
        else if (/^(职位|岗位|职务|position|title|role)/.test(key)) experience.title = value;
        else if (/^(工作性质|雇佣|employment type|job type)/.test(key)) {
          experience.employmentType = value;
          explicitEmploymentType = true;
        } else if (/^(工作地点|location)/.test(key)) experience.city = value;
        else if (/^(薪资|salary|薪酬)/.test(key)) experience.salary = value;
        else if (/^(汇报|reports to|supervisor)/.test(key)) experience.reportsTo = value;
        else if (/^(下属|团队规模|team size)/.test(key)) experience.teamSize = value;
        else if (/^(离职原因|reason for leaving)/.test(key)) experience.leaveReason = value;
        else if (/^(证明人|推荐人|reference)/.test(key)) experience.refereeName = value;
      }
    }

    /*
     * The header is a short block, not one line. Chinese resumes often write
     * “公司” / “职位” / “2020.07 - 2023.06” on three lines, and English ones
     * put the company and the dates on separate lines. Taking only the first
     * line turned the title into a highlight.
     */
    const headerLine = entry.find((line) => !/^[\u2022\u25CF\u25AA\u002A\u002D\u2013\u2014·•▪◦]/.test(line.trim()));
    const headerSplit = splitEntryHeader(entry);
    const headerText =
      headerSplit.header.map(stripDateRange).filter(Boolean).join(" | ") || stripDateRange(headerLine ?? "");
    if (headerText) {
      // Aggressive splitting is right here: latin entry headers use commas.
      const parts = splitHeaderFields(headerText, true);
      const withoutDates = parts.filter(
        (part) => part.length > 0 && !/^[\d\s年/\-.,~—–至到至今presentcurrentnow]+$/i.test(part),
      );
      if (!experience.company && withoutDates[0]) {
        experience.company = withoutDates[0].replace(/^[\u2022\u25CF\u25AA]\s*/, "").trim();
      }
      // Job titles carry role words; use that to locate the second token.
      if (!experience.title) {
        const title = withoutDates.find((part) =>
          /(工程师|经理|专员|主管|总监|设计师|开发|运营|分析师|顾问|助理|实习生|研究员|教师|编辑|策划|销售|产品|测试|架构|leader|engineer|manager|intern|analyst|designer|developer|specialist|consultant|director|associate)/i.test(
            part,
          ),
        );
        if (title) experience.title = title.trim();
        else if (withoutDates[1] && withoutDates[1] !== experience.company) experience.title = withoutDates[1].trim();
      }
      if (!experience.city) {
        const city = withoutDates.find((part) => /(市|区|省|北京|上海|深圳|广州|杭州|成都|南京|武汉|西安|苏州|天津|重庆|长沙|青岛|合肥)/.test(part));
        if (city) experience.city = city.trim();
      }
    }

    const bodyLines = headerSplit.body;
    experience.highlights = bodyLines
      .map((line) => line.trim())
      .filter((line) => line.length >= 4 && !/^[\d\s年/\-.,~—–至到]+$/.test(line));

    /*
     * The resume often marks the nature in the title (“后端开发实习生”) or in
     * an explicit “工作性质：实习” pair. The section heading is a good default
     * for “实习经历 / 工作经历”, but a title is more specific when a resume
     * mixes both kinds under one heading.
     */
    if (!explicitEmploymentType) {
      const inferred = experienceKindFromText([experience.title, headerText].filter(Boolean).join(" "));
      if (inferred) experience.employmentType = inferred === "internship" ? "实习" : "全职";
    }

    if (experience.company || experience.title) out.push(experience);
  });

  return out;
}

/* ------------------------------------------------------------------ project */

/**
 * Infer a project category only when the resume names one directly.
 *
 * A resume that just says “某系统” is not forced into a bucket; the person can
 * choose one in the editor, and an empty value is better than a wrong guess.
 */
function inferProjectCategory(text: string): ProjectCategory | undefined {
  if (/科研|学术研究|课题|论文|实验室|research project|academic project/i.test(text)) {
    return "research";
  }
  if (/开源|open.?source|github|gitee|gitlab/i.test(text)) return "opensource";
  if (/个人作品|个人项目|作品集|个人开发|portfolio|personal project|side project/i.test(text)) {
    return "personal";
  }
  return undefined;
}

function parseProjects(section: ResumeSection | undefined): Project[] {
  if (!section) return [];
  const entries = splitEntries(section.lines, "project");
  const out: Project[] = [];

  entries.forEach((entry, index) => {
    if (entry.length === 0) return;
    const project: Project = { id: `proj-${index + 1}`, highlights: [] };
    const dateLine = entry.find((line) => isDateLine(line));
    if (dateLine) project.dates = parseDateRange(dateLine);
    const category = inferProjectCategory(entry.join(" "));
    if (category) project.category = category;

    for (const line of entry) {
      for (const [rawKey, rawValue] of pairsIn(line)) {
        const key = normalize(rawKey);
        const value = rawValue.trim();
        if (!value) continue;
        if (/^(项目名称|项目|project)/.test(key)) project.name = value;
        else if (/^(角色|role)/.test(key)) project.role = value;
        else if (/^(描述|背景|介绍|description|summary)/.test(key)) project.summary = value;
        else if (/^(链接|地址|link|url|demo)/.test(key)) project.link = value;
      }
    }

    const headerLine = entry.find((line) => !/^[\u2022\u25CF\u25AA\u002A\u002D\u2013\u2014·•▪◦]/.test(line.trim()));
    const headerSplit = splitEntryHeader(entry);
    const headerText =
      headerSplit.header.map(stripDateRange).filter(Boolean).join(" | ") || stripDateRange(headerLine ?? "");
    if (headerText && !project.name) {
      const parts = splitHeaderFields(headerText);
      const withoutDates = parts.filter((part) => !/^[\d\s年/\-.,~—–至到至今presentcurrentnow]+$/i.test(part));
      if (withoutDates[0]) project.name = withoutDates[0].trim();
      if (!project.role) {
        const role = withoutDates.find((part) => /(负责人|核心|成员|开发|设计|主导|参与|owner|lead|developer|designer|member|intern)/i.test(part));
        if (role) project.role = role.trim();
      }
    }

    const bodyLines = headerSplit.body;
    project.highlights = bodyLines
      .map((line) => line.trim())
      .filter((line) => line.length >= 4 && !/^[\d\s年/\-.,~—–至到]+$/.test(line));

    // Project descriptions are often written as one paragraph.
    if (project.highlights.length > 1 && !project.summary) {
      project.summary = project.highlights.slice(0, 2).join(" ").slice(0, 240);
    }

    // Technology stack heuristics.
    const stackText = entry.join(" ");
    project.stack = detectStack(stackText);

    if (project.name || project.summary || project.highlights.length > 0) out.push(project);
  });

  return out;
}

/* -------------------------------------------------------------------- skill */

const TECH_TOKENS = [
  /* Languages */
  "JavaScript", "TypeScript", "Python", "Java", "Go", "Golang", "C++", "C#", "C", "Rust", "Ruby", "PHP",
  "Swift", "Kotlin", "Scala", "Objective-C", "Dart", "Lua", "R", "MATLAB", "Julia", "Perl", "Shell", "Bash",
  "PowerShell", "SQL", "HTML", "HTML5", "CSS", "CSS3", "SCSS", "Sass", "Less",
  /* Front end */
  "React", "React Native", "Vue", "Vue.js", "Vue 3", "Angular", "Svelte", "Next.js", "Nuxt", "Tailwind",
  "Webpack", "Vite", "Rollup", "Three.js", "WebGL", "WebSocket", "小程序", "GraphQL", "REST", "gRPC",
  /* Back end and frameworks */
  "Node.js", "Deno", "Express", "Koa", "NestJS", "Django", "Flask", "FastAPI", "Tornado", "Celery",
  "Spring", "Spring Boot", "Spring Cloud", "Spring MVC", "MyBatis", "Hibernate", "JPA", "Dubbo", "Thrift",
  "Maven", "Gradle", "JUnit", "Mockito", "Swagger", "Postman",
  /* Data and storage */
  "MySQL", "PostgreSQL", "Oracle", "SQL Server", "SQLite", "MongoDB", "Redis", "Memcached", "Elasticsearch",
  "OpenSearch", "ClickHouse", "Doris", "StarRocks", "HBase", "Cassandra", "Neo4j", "Kafka", "RabbitMQ",
  "RocketMQ", "Pulsar", "Zookeeper", "Nacos", "Consul", "Etcd", "Hive", "Hadoop", "MapReduce", "Spark",
  "Flink", "Storm", "Presto", "Trino", "Airflow", "DolphinScheduler", "ELK",
  /* Infrastructure */
  "Docker", "Kubernetes", "K8s", "Helm", "Istio", "Prometheus", "Grafana", "SkyWalking", "Jenkins",
  "GitLab CI", "GitHub Actions", "Argo CD", "Terraform", "Ansible", "Nginx", "HAProxy", "Linux", "Unix",
  "AWS", "Azure", "GCP", "阿里云", "腾讯云", "华为云", "Git", "GitLab", "GitHub", "SVN", "Jira", "Confluence",
  /* AI and data science */
  "PyTorch", "TensorFlow", "Keras", "Scikit-learn", "sklearn", "XGBoost", "LightGBM", "CatBoost", "Pandas",
  "NumPy", "SciPy", "Matplotlib", "Seaborn", "OpenCV", "NLTK", "spaCy", "Hugging Face", "Transformers",
  "LangChain", "LlamaIndex", "RAG", "LLM", "CUDA", "cuDNN", "TensorRT", "ONNX",
  /* Analysis and office */
  "Excel", "VBA", "Tableau", "Power BI", "PowerBI", "SPSS", "SAS", "Stata", "EViews", "Visio", "Word",
  "PowerPoint", "PPT",
  /* Design */
  "Figma", "Sketch", "Axure", "Photoshop", "Illustrator", "After Effects", "Premiere", "Final Cut Pro",
  "剪映", "Blender", "Unity", "Unreal",
  /* Engineering and hardware */
  "SolidWorks", "AutoCAD", "CATIA", "Creo", "ANSYS", "Abaqus", "COMSOL", "Simulink", "STM32", "Arduino",
  "Raspberry Pi", "PLC", "Verilog", "VHDL", "FPGA", "Cadence", "Synopsys", "Altium Designer", "Keil",
  "IAR", "FreeRTOS", "RTOS", "Qt", "MFC", "OpenGL", "Vulkan", "OpenCL", "ROS", "Gazebo", "SLAM", "PCL",
  "Eigen",
  /* Testing */
  "JMeter", "Selenium", "Cypress", "Playwright", "Pytest",
  /* Finance */
  "Wind", "Bloomberg", "Choice", "同花顺", "iFinD",
];

/**
 * Tokens that are also ordinary English words must be written the way the
 * technology is written. Without this, “go to market” becomes Go and “the word
 * processing feature” becomes Microsoft Word in the skill list.
 */
const CASE_SENSITIVE_TOKENS = new Set([
  "Go",
  "R",
  "C",
  "Word",
  "Choice",
  "Excel",
  "Spark",
  "Spring",
  "Express",
  "Less",
  "REST",
  "Wind",
  "Storm",
  "Doris",
  "Unity",
]);

export function detectStack(text: string): string[] {
  const found: string[] = [];
  const haystack = ` ${text} `;
  for (const token of TECH_TOKENS) {
    // Escape regex metacharacters (C++, C#, .NET …).
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const boundary = /^[\w]/.test(token) ? `(?<![\\w+#.])` : "";
    const tail = /[\w+#]$/.test(token) ? `(?![\\w+#])` : "";
    const re = new RegExp(`${boundary}${escaped}${tail}`, CASE_SENSITIVE_TOKENS.has(token) ? "" : "i");
    if (re.test(haystack)) found.push(token);
  }
  return unique(found);
}

function parseSkills(section: ResumeSection | undefined): Skill {
  const skill: Skill = { items: [], certificates: [], awards: [], interests: [] };
  if (!section) return skill;
  const text = section.lines.join("\n");

  /*
   * Pass 1: labelled lines. Inside a skills section almost every pair that is
   * not explicitly a certificate, award, interest or language is a skill — the
   * labels vary endlessly ("编程语言", "框架与中间件", "技术栈", "熟练使用").
   */
  for (const line of section.lines) {
    const pairs = pairsIn(line);
    for (const [rawKey, rawValue] of pairs) {
      const key = normalize(rawKey);
      const value = rawValue.trim();
      if (!value) continue;
      const items = value.split(/[、,，；;\/|]/).map((item) => item.trim()).filter(Boolean);
      if (/(证书|资格|certificat|执照)/.test(key)) skill.certificates.push(...items);
      else if (/(奖项|荣誉|获奖|奖励|award|honor|prize)/.test(key)) skill.awards.push(...items);
      else if (/(兴趣|爱好|interest|hobb)/.test(key)) skill.interests.push(...items);
      else if (/(语言|外语|英语|language)/.test(key)) skill.items.push(...items);
      else skill.items.push(...items);
    }
  }

  // Pass 2: unlabelled content. Known technology names anywhere in the section.
  skill.items.push(...detectStack(text));

  /*
   * Pass 2b: unlabelled lists. “Python、Java、Go” or
   * “CET-6、普通话二级甲等、教师资格证” are extremely common under a skills
   * heading, and they have no colon for pass 1 to anchor on. Splitting a
   * list-like line and classifying each token is safe; a prose sentence is not
   * list-like (too long, or separated by full stops rather than 、).
   */
  const listLines = new Set<string>();
  for (const line of section.lines) {
    if (pairsIn(line).length > 0) continue;
    const cleaned = line.replace(/^[\s•●▪·•▪◦]+/, "").trim();
    if (!cleaned || cleaned.length > 140 || /[。！？!?]$/.test(cleaned)) continue;
    // “熟悉 Java、Python” is prose about skills, not a list of skill names.
    if (/^(熟悉|掌握|了解|精通|使用|会|具备|擅长|熟练|能够|有|负责|参与)/.test(cleaned)) continue;

    const parts = cleaned
      .split(/[、,，；;\/|]+/)
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length < 2) continue;
    if (!parts.every((part) => part.length <= 30 && !/[:：]/.test(part))) continue;

    listLines.add(line);
    for (const part of parts) {
      if (CERTIFICATE.test(part)) skill.certificates.push(part);
      else if (AWARD_OR_HONOR.test(part)) skill.awards.push(part);
      else skill.items.push(part);
    }
  }

  // Pass 3: lines with no label at all. Certificate and award wording is
  // distinctive enough to classify by keyword, but we must not add the whole
  // line when pass 1 or 2b already split it into items.
  for (const line of section.lines) {
    const hasPairs = pairsIn(line).length > 0;
    if (hasPairs || listLines.has(line)) continue;
    if (CERTIFICATE.test(line)) {
      const cleaned = line.replace(/^[\s\u2022\u25CF\u25AA·•▪◦]+/, "").trim();
      if (cleaned.length < 80) skill.certificates.push(cleaned);
    }
    if (/(奖学金|优秀|标兵|冠军|一等奖|二等奖|三等奖|金奖|银奖|荣誉|称号|award|prize|scholarship|honor)/i.test(line)) {
      const cleaned = line.replace(/^[\s\u2022\u25CF\u25AA·•▪◦]+/, "").trim();
      if (cleaned.length < 100) skill.awards.push(cleaned);
    }
    if (/(爱好|兴趣|hobb|interest)/i.test(line)) {
      const at = line.search(/[:：]/);
      if (at >= 0) {
        skill.interests.push(
          ...line
            .slice(at + 1)
            .split(/[、,，；;\/|]/)
            .map((item) => item.trim())
            .filter(Boolean),
        );
      }
    }
  }

  /*
   * Clean up. A "skill" that is really a sentence, a certificate heading, or
   * an empty token is noise that would later be typed into a form field.
   */
  const isNoise = (item: string) =>
    item.length === 0 ||
    item.length > 40 ||
    /^\d+$/.test(item) ||
    /^(证书|奖项|荣誉|技能|语言|兴趣|爱好)[:：]?$/.test(item) ||
    /^[\d\s./%]+$/.test(item);

  skill.items = unique(skill.items.filter((item) => !isNoise(item) && !/[:：]/.test(item)));
  skill.certificates = unique(
    skill.certificates.filter((item) => !isNoise(item) && !/^(证书|资格)[:：]?$/.test(item)),
  );
  skill.awards = unique(skill.awards.filter((item) => !isNoise(item)));
  skill.interests = unique(skill.interests.filter((item) => !isNoise(item) && item.length < 30));

  /*
   * Any certificate or award token that also landed in `items` (because it sat
   * on a line whose label we did not recognise) is removed from skills — a form
   * asking for 专业技能 does not want "CET-6".
   */
  const nonSkill = new Set([...skill.certificates, ...skill.awards, ...skill.interests]);
  skill.items = skill.items.filter((item) => !nonSkill.has(item));
  return skill;
}

/* --------------------------------------------------------------- preference */

function parsePreference(
  section: ResumeSection | undefined,
  fallbackPosition?: string,
  hints: ResumeSemantics = {},
): { preference: JobPreference; warnings: string[] } {
  const preference: JobPreference = { cities: [], industries: [] };
  const warnings: string[] = [];

  // Facts read from the header are weak evidence: a labelled preference line
  // in the section may override them below.
  if (hints.position) preference.position = hints.position;
  if (hints.availableFrom) preference.availableFrom = hints.availableFrom;
  if (hints.flexibleLocation) preference.relocation = hints.flexibleLocation;

  const applyCities = (value: string): void => {
    const parsed = parseCities(value);
    if (parsed.cities.length > 0) preference.cities = unique(parsed.cities);
    if (parsed.flexible) {
      preference.relocation = preference.relocation
        ? `${preference.relocation}、${parsed.flexible}`
        : parsed.flexible;
      if (parsed.cities.length === 0) {
        warnings.push("期望城市里有非城市描述，已改放到「地点灵活度」，请核对。");
      }
    } else if (parsed.rejected.length > 0) {
      warnings.push("期望城市里有无法识别的城市名，请核对。");
    }
  };

  const applyAvailability = (value: string): void => {
    /*
     * “预计2029年7月” under 到岗时间 is almost always a graduation date.
     * If the header already answered the question (“一周内到岗”), prefer that
     * direct answer; otherwise keep the value but ask the person to check it.
     */
    if (looksLikeGraduation(value) && hints.availableFrom && !looksLikeGraduation(hints.availableFrom)) {
      preference.availableFrom = hints.availableFrom;
      warnings.push("「到岗时间」看起来是毕业时间，已优先使用简历开头写的可到岗时间，请核对。");
      return;
    }
    preference.availableFrom = value;
    if (looksLikeGraduation(value)) {
      warnings.push("「到岗时间」里出现了“预计/毕业”等字样，可能填的是毕业时间，请核对。");
    }
  };

  const applyPosition = (value: string): void => {
    const cleaned = value.trim();
    if (!cleaned || cleaned.length > 30) return;
    if (/^(城市|薪资|到岗|入职|地点)/.test(cleaned)) return;
    if (/^\d{4}\s*[年./-]/.test(cleaned)) return;
    if (findCity(cleaned)) return;
    preference.position = cleaned;
  };

  if (section) {
    for (const line of section.lines) {
      // Preference blocks are often a single line of pairs.
      const pairs = pairsIn(line);
      if (pairs.length > 0) {
        /*
         * “后端开发工程师 意向城市：杭州、上海” has a bare value before the
         * first label. In a preference block that leading token is the target
         * position; without it the line looked like it contained only cities.
         */
        const segments = line.split(/\s+/).filter(Boolean);
        const labelAt = segments.findIndex((segment) => /[:：]/.test(segment));
        const leadingParts = labelAt > 0 ? segments.slice(0, labelAt) : [];
        const leading = leadingParts.join(" ").replace(/[|｜·•]\s*$/, "").trim();
        if (leading && !preference.position) {
          // “产品经理 北京 意向城市：…” — keep the role, drop the city.
          applyPosition(findCity(leading) && leadingParts.length > 1 ? (leadingParts[0] ?? leading) : leading);
        }

        for (const [rawKey, rawValue] of pairs) {
          const key = normalize(rawKey);
          const value = rawValue.trim();
          if (!value) continue;
          if (/(意向岗位|期望岗位|应聘岗位|求职岗位|求职方向|目标岗位|岗位|position|targetrole|targetposition)/.test(key)) {
            applyPosition(value);
          } else if (/(意向城市|期望城市|意向地区|工作地点|期望地点|city|location)/.test(key)) {
            applyCities(value);
          } else if (/(期望薪资|薪资|salary)/.test(key)) {
            preference.salary = value;
          } else if (/(到岗|入职时间|available|availability)/.test(key)) {
            applyAvailability(value);
          } else if (/(求职类型|招聘类型|投递类型|应聘类型|jobtype|targettrack)/.test(key)) {
            preference.jobType = value;
            const track = hiringTrackFromLabel(value);
            if (track) preference.targetTrack = track;
          } else if (/(行业|industry)/.test(key)) {
            preference.industries = splitList(value);
          } else if (/(调剂|relocation|地点灵活|灵活度)/.test(key)) {
            preference.relocation = value;
          }
        }
        continue;
      }

      const text = line.trim();
      const flexible = extractFlexibleLocation(text);
      if (flexible && !preference.relocation) preference.relocation = flexible;

      if (/(求职意向|职业目标|objective)/i.test(text)) {
        const after = text.replace(/^.*?[:：]/, "").trim();
        if (after) {
          const parts = splitList(after);
          if (!preference.position && parts[0]) applyPosition(parts[0]);
          const parsed = parseCities(after);
          if (parsed.cities.length > 0) preference.cities = unique([...preference.cities, ...parsed.cities]);
          if (parsed.flexible) {
            preference.relocation = preference.relocation
              ? `${preference.relocation}、${parsed.flexible}`
              : parsed.flexible;
          }
        }
      }
    }
  }

  if (!preference.position && fallbackPosition) preference.position = fallbackPosition;
  preference.cities = unique(preference.cities.filter((city) => findCity(city) !== undefined));
  if (
    looksLikeGraduation(preference.availableFrom) &&
    hints.availableFrom &&
    !looksLikeGraduation(hints.availableFrom)
  ) {
    preference.availableFrom = hints.availableFrom;
  }
  return { preference, warnings: unique(warnings) };
}

function splitList(value: string): string[] {
  return value
    .split(/[、,，；;\/|\s]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item.length < 24);
}

/* ------------------------------------------------------------------- essays */

function parseEssays(sections: ResumeSection[]): Essays {
  const essays: Essays = { unclassified: {} };
  const summarySections = sections.filter((section) => section.section === "essay");
  for (const section of summarySections) {
    const body = section.lines.join("\n").trim();
    if (!body) continue;
    const normalized = normalize(section.heading);
    if (/自我评价|个人评价|selfevaluation|summary|个人总结/.test(normalized)) {
      essays.selfIntro = clampToLength(body, 1200);
    } else if (/自我介绍|selfintroduction|aboutme/.test(normalized)) {
      essays.selfIntro ??= clampToLength(body, 1200);
    } else if (/职业规划|careerplan/.test(normalized)) {
      essays.careerPlan = clampToLength(body, 1200);
    } else if (/优势|strength/.test(normalized)) {
      essays.strengths = clampToLength(body, 1200);
    } else {
      essays.unclassified[section.heading] = body;
    }
  }
  return essays;
}

/* ------------------------------------------------------- structural fallback */

/**
 * When no education heading is recognised, the sections still contain the
 * facts — they are just not labelled. Find school-name anchors and take a small
 * window around each (the date often sits one line above or a few lines below).
 * This runs only when the normal path found nothing, so it cannot duplicate
 * well-formed entries.
 */
function fallbackEducationSection(text: string): ResumeSection | undefined {
  const lines = toLines(tidy(text));
  const anchors: number[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").trim();
    if (!line || line.length > 80) continue;
    if (/^[•●▪·•▪◦]/.test(line)) continue;
    if (matchHeading(line)) continue;
    if (AWARD_OR_HONOR.test(line) && !/(大学|学院|学校|university|college|institute)/i.test(line)) continue;
    if (/(大学|学院|学校|university|college|institute|academy)/i.test(line)) anchors.push(index);
  }

  if (anchors.length === 0) return undefined;

  const anchorSet = new Set(anchors);
  const collected: string[] = [];

  anchors.forEach((anchor, order) => {
    const previous = (lines[anchor - 1] ?? "").trim();
    const canTakePrevious =
      anchor > 0 &&
      !anchorSet.has(anchor - 1) &&
      previous.length <= 60 &&
      (DATE_TOKEN.test(previous) || pickToken(previous, DEGREE_LEVELS) !== undefined);

    const from = canTakePrevious ? anchor - 1 : anchor;
    const nextAnchor = anchors[order + 1] ?? lines.length;
    let to = Math.min(nextAnchor, anchor + 4);
    for (let index = anchor + 1; index < to; index += 1) {
      if (matchHeading(lines[index] ?? "")) {
        to = index;
        break;
      }
    }
    collected.push(...lines.slice(from, to).filter(Boolean));
  });

  if (collected.length === 0) return undefined;
  return { section: "education", heading: "教育经历", lines: collected };
}

/**
 * Same idea for work history: an organisation name plus a date range within
 * two lines is a job entry. Schools are excluded so the education fallback and
 * this one cannot claim the same lines.
 */
function fallbackExperienceSection(text: string): ResumeSection | undefined {
  const lines = toLines(tidy(text));
  const anchors: number[] = [];
  const SCHOOL = /(大学|学院|学校|university|college|institute|academy)/i;
  const WORK_MARKER =
    /(公司|集团|科技|有限公司|股份|银行|医院|研究院|研究所|事务所|工作室|实验室|中心|事业部|团队|协会|学生会|团委|社团|university|college|institute|academy|inc\.?|ltd\.?|corp)/i;
  const ROLE_MARKER =
    /(实习生|工程师|经理|专员|主管|总监|设计师|运营|分析师|顾问|助理|研究员|负责人|成员|主席|部长|队长|开发|产品|测试|算法|销售|编辑|策划)/i;
  // Project titles are the other fallback's job. Without this guard a line
  // such as “分布式文件存储系统 | 核心开发 | 2022.03 - 2022.06” becomes a job.
  const PROJECT_MARKER = /(项目|系统|平台|小程序|app|网站|模型|算法|研究|作品)/i;

  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").trim();
    if (!line || line.length > 70) continue;
    if (/^[•●▪·•▪◦]/.test(line)) continue;
    if (matchHeading(line)) continue;
    if (AWARD_OR_HONOR.test(line)) continue;
    if (SCHOOL.test(line)) continue;
    if (/[@]|https?:/i.test(line)) continue;

    const hasOrg = WORK_MARKER.test(line);
    const roleNear = [index - 1, index, index + 1, index + 2].some((at) =>
      ROLE_MARKER.test(lines[at] ?? ""),
    );
    // “字节跳动 / 产品经理实习生 / 2024.06 - 2024.09” has no 公司 marker;
    // the role on the next line is what identifies it as a job entry.
    if (!hasOrg && !roleNear) continue;
    if (PROJECT_MARKER.test(line) && !hasOrg) continue;

    const nearRange = [index - 2, index - 1, index + 1, index + 2].some((at) => {
      const candidate = lines[at] ?? "";
      return DATE_TOKEN.test(candidate) && /[-~—–至到至今]|present|current/i.test(candidate);
    });
    if (nearRange) anchors.push(index);
  }

  if (anchors.length === 0) return undefined;

  /*
   * A header often produces several nearby candidates (org line, role line,
   * city line). Keep the first of each cluster instead of emitting three
   * overlapping entries for the same job.
   */
  const merged: number[] = [];
  for (const anchor of [...new Set(anchors)].sort((a, b) => a - b)) {
    const previous = merged[merged.length - 1];
    if (previous === undefined || anchor - previous > 2) merged.push(anchor);
  }

  const collected: string[] = [];
  merged.forEach((anchor, order) => {
    const nextAnchor = merged[order + 1] ?? lines.length;
    let to = Math.min(nextAnchor, anchor + 5);
    for (let index = anchor + 1; index < to; index += 1) {
      if (matchHeading(lines[index] ?? "")) {
        to = index;
        break;
      }
    }
    collected.push(...lines.slice(anchor, to).filter(Boolean));
  });

  if (collected.length === 0) return undefined;
  return { section: "experience", heading: "工作经历", lines: collected };
}

/**
 * Project recovery for resumes without a usable project heading. A project
 * header is a short name-like line with a project word and either a date range
 * or bullets underneath. Job headers are excluded by the role/date guard.
 */
function fallbackProjectSection(text: string): ResumeSection | undefined {
  const lines = toLines(tidy(text));
  const anchors: number[] = [];
  const SCHOOL = /(大学|学院|学校|university|college|institute|academy)/i;
  const STRICT_PROJECT = /(项目|系统|平台|小程序|app|网站|模型|算法|研究|作品)/i;
  const LOOSE_PROJECT = /(设计|开发)/i;
  const WORK_MARKER =
    /(公司|集团|科技|有限公司|股份|银行|医院|研究院|事务所|工作室|实验室|中心|事业部|university|college|institute|academy)/i;
  const ROLE_MARKER =
    /(实习生|工程师|经理|专员|主管|总监|设计师|运营|分析师|顾问|助理|研究员|负责人|成员|主席|部长|队长)/i;

  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").trim();
    if (!line || line.length > 60) continue;
    if (/^[•●▪·•▪◦]/.test(line)) continue;
    if (matchHeading(line)) continue;
    if (SCHOOL.test(line) || AWARD_OR_HONOR.test(line)) continue;
    if (/[@]|https?:/i.test(line)) continue;

    const next = (lines[index + 1] ?? "").trim();
    const nextBullet = /^[•●▪·•▪◦]/.test(next);
    const hasDate = DATE_TOKEN.test(line) && /[-~—–至到至今]|present|current/i.test(line);
    const strict = STRICT_PROJECT.test(line);
    const loose = LOOSE_PROJECT.test(line);

    // “字节跳动 | 服务端开发实习生 | 2022.07 - 2022.10” also contains
    // 开发; only the strict project words can claim a dated role header.
    if (!strict && !(loose && nextBullet)) continue;
    if (ROLE_MARKER.test(line) && hasDate && !strict) continue;
    if (!hasDate && !nextBullet) continue;

    anchors.push(index);
  }

  if (anchors.length === 0) return undefined;

  const merged: number[] = [];
  for (const anchor of [...new Set(anchors)].sort((a, b) => a - b)) {
    const previous = merged[merged.length - 1];
    if (previous === undefined || anchor - previous > 2) merged.push(anchor);
  }

  const collected: string[] = [];
  merged.forEach((anchor, order) => {
    const nextAnchor = merged[order + 1] ?? lines.length;
    let to = Math.min(nextAnchor, anchor + 6);
    for (let index = anchor + 1; index < to; index += 1) {
      if (matchHeading(lines[index] ?? "")) {
        to = index;
        break;
      }
    }
    collected.push(...lines.slice(anchor, to).filter(Boolean));
  });

  if (collected.length === 0) return undefined;
  return { section: "project", heading: "项目经历", lines: collected };
}

/**
 * Skill/certificate recovery when the resume has no skill heading. It only
 * takes lines with an explicit skill, certificate, award or list signal, so a
 * project description cannot turn into a skill list by accident.
 */
function fallbackSkillSection(text: string): ResumeSection | undefined {
  const lines = toLines(tidy(text));
  const picked: string[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > 120) continue;
    if (matchHeading(trimmed)) continue;
    if (/^(主修课程|课程|核心课程)[:：]/.test(trimmed)) continue;
    if (DATE_TOKEN.test(trimmed) && /(大学|学院|公司|集团|科技|有限|研究院)/.test(trimmed)) continue;

    const isCertificate = CERTIFICATE.test(trimmed);
    const isAward = AWARD_OR_HONOR.test(trimmed);
    const stack = detectStack(trimmed);
    const listLike =
      /[、,，/|]/.test(trimmed) &&
      trimmed.split(/[、,，/|]+/).filter(Boolean).length >= 2 &&
      !/[。！？!?]/.test(trimmed);

    if (!isCertificate && !isAward && stack.length === 0 && !listLike) continue;
    // A colon normally means “label: prose”; only certificate/award labels
    // are safe here, because parseSkills would copy the prose as a skill.
    if (/[:：]/.test(trimmed) && !isCertificate && !isAward) {
      const value = trimmed.slice(trimmed.search(/[:：]/) + 1).trim();
      if (value.length > 40 || /[。！？!?]/.test(value)) continue;
    }
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    picked.push(trimmed);
    if (picked.length >= 30) break;
  }

  if (picked.length === 0) return undefined;
  return { section: "skill", heading: "技能与证书", lines: picked };
}

/* -------------------------------------------------------------------- entry */

export interface ParseOptions {
  /** Job title to use when the resume has no explicit 求职意向. */
  fallbackPosition?: string;
  /** Name to use when the resume header cannot be read. */
  fallbackName?: string;
  profileId?: string;
  sourceDocumentId?: string;
}

export interface ParseResult {
  profile: Profile;
  /** Fields we filled, with the source line — drives the evidence panel. */
  evidence: Record<string, { quote: string }>;
  /** Warnings worth surfacing ("no email found", "two schools detected"). */
  warnings: string[];
  /** Section headings we recognised, for a debuggable preview. */
  detectedSections: string[];
}

export function parseResume(text: string, options: ParseOptions = {}): ParseResult {
  const profile = emptyProfile(options.profileId ?? "profile-1");
  if (options.sourceDocumentId) profile.sourceDocumentId = options.sourceDocumentId;
  profile.rawText = tidy(text);

  const { sections, header } = segmentResume(text);
  const warnings: string[] = [];

  const identitySection = sections.find((section) => section.section === "identity");
  const contactSection = sections.find((section) => section.section === "contact");
  const educationSection = sections.find((section) => section.section === "education");
  const experienceSection = sections.find((section) => section.section === "experience");
  const projectSection = sections.find((section) => section.section === "project");
  const skillSection = sections.find((section) => section.section === "skill");
  const preferenceSection = sections.find((section) => section.section === "preference");

  const mergedIdentitySection =
    identitySection && contactSection
      ? { ...identitySection, lines: [...identitySection.lines, ...contactSection.lines] }
      : identitySection ?? contactSection;

  const fullText = tidy(text);
  const { identity, contact, hints } = parseIdentity(header, mergedIdentitySection, fullText);
  if (options.fallbackName && !identity.fullName) identity.fullName = options.fallbackName;
  if (!hints.graduation) hints.graduation = extractGraduationDate(fullText);
  profile.identity = identity;
  profile.contact = contact;

  let education = parseEducation(educationSection, warnings);
  if (education.length === 0) {
    const fallback = fallbackEducationSection(fullText);
    if (fallback) {
      const recovered = parseEducation(fallback, warnings);
      if (recovered.length > 0) {
        education = recovered;
        warnings.push("没有找到教育经历标题，已按学校名称自动识别，请核对。");
      }
    }
  }

  // “预计2029年7月毕业” is a graduation date, not an availability. Use it to
  // complete an education range that only has a start date.
  if (hints.graduation) {
    const target = [...education].reverse().find((item) => item.dates?.start && !item.dates.end);
    if (target?.dates) target.dates = { ...target.dates, end: hints.graduation };
  }

  let experience = parseExperience(experienceSection);
  if (experience.length === 0) {
    const fallback = fallbackExperienceSection(fullText);
    if (fallback) {
      const recovered = parseExperience(fallback);
      if (recovered.length > 0) {
        experience = recovered;
        warnings.push("没有找到工作经历标题，已按单位名称和日期自动识别，请核对。");
      }
    }
  }

  let projects = parseProjects(projectSection);
  if (projects.length === 0) {
    const fallback = fallbackProjectSection(fullText);
    if (fallback) {
      const recovered = parseProjects(fallback);
      if (recovered.length > 0) {
        projects = recovered;
        warnings.push("没有找到项目经历标题，已按项目名称和日期自动识别，请核对。");
      }
    }
  }

  let skills = parseSkills(skillSection);
  if (
    skills.items.length === 0 &&
    skills.certificates.length === 0 &&
    skills.awards.length === 0 &&
    skills.interests.length === 0
  ) {
    const fallback = fallbackSkillSection(fullText);
    if (fallback) {
      const recovered = parseSkills(fallback);
      if (
        recovered.items.length > 0 ||
        recovered.certificates.length > 0 ||
        recovered.awards.length > 0 ||
        recovered.interests.length > 0
      ) {
        skills = recovered;
        warnings.push("没有找到技能/证书栏，已按关键词从全文提取，请核对。");
      }
    }
  }

  const preferenceResult = parsePreference(preferenceSection, options.fallbackPosition, hints);
  profile.education = education;
  profile.experience = experience;
  profile.projects = projects;
  profile.skills = skills;
  profile.preference = preferenceResult.preference;
  profile.essays = parseEssays(sections);
  warnings.push(...preferenceResult.warnings);

  // Page-footer noise (page numbers) must not become skills or awards.
  profile.skills.items = profile.skills.items.filter((item) => !/^\d+$/.test(item));
  profile.skills.awards = profile.skills.awards.filter((item) => !/^\d+\s*\/\s*\d+$/.test(item));

  if (!contact.email) warnings.push("未找到邮箱，请手动补充");
  if (!contact.phone) warnings.push("未找到手机号，请手动补充");
  if (!identity.fullName) warnings.push("未能识别姓名");
  if (profile.education.length === 0) warnings.push("未识别到教育经历");
  if (profile.experience.length === 0 && profile.projects.length === 0) {
    warnings.push("未识别到工作或项目经历");
  }
  if (profile.education.length > 3) warnings.push(`识别到 ${profile.education.length} 段教育经历，请核对`);
  if (
    profile.education.length === 0 &&
    profile.experience.length === 0 &&
    profile.projects.length === 0 &&
    (profile.rawText?.length ?? 0) > 800
  ) {
    warnings.push("简历文字已读取，但没有识别出经历结构；可能是多栏/表格排版，请对照原文核对后手动补充");
  }
  if (identity.fullName && /(目前|到岗|入职|求职|男|女|本科|硕士|博士)/.test(identity.fullName)) {
    warnings.push("姓名里可能混入了状态信息，请核对");
  }
  if (profile.education.some((item) => item.gpa && /%/.test(item.gpa))) {
    warnings.push("GPA 里出现了百分比，可能把排名当成了 GPA，请核对");
  }
  if (profile.education.some((item) => item.rank && isGpaValue(item.rank))) {
    warnings.push("专业排名里出现了看起来像 GPA 的值，请核对");
  }

  const parseWarnings = [...new Set(warnings)];
  profile.parseWarnings = parseWarnings;

  const evidence: Record<string, { quote: string }> = {};
  const note = (key: string, quote: string | undefined) => {
    if (quote) evidence[key] = { quote: clampToLength(quote.trim(), 160) };
  };
  note("identity.fullName", identity.fullName);
  note("identity.gender", identity.gender);
  note("identity.birthDate", identity.birthDate);
  note("identity.politicalStatus", identity.politicalStatus);
  note("identity.ethnicity", identity.ethnicity);
  note("identity.nativePlace", identity.nativePlace);
  note("contact.phone", contact.phone);
  note("contact.email", contact.email);
  note("contact.currentCity", contact.currentCity);
  note("contact.address", contact.address);
  note("contact.wechat", contact.wechat);
  note("contact.github", contact.github);
  note("contact.homepage", contact.homepage);
  note("preference.position", profile.preference.position);
  note("preference.availableFrom", profile.preference.availableFrom);
  note("preference.cities", profile.preference.cities.join("、"));
  profile.education.forEach((education, index) => {
    note(`education-${index}.school`, education.school);
    note(`education-${index}.major`, education.major);
    note(`education-${index}.degree`, education.degree);
  });
  profile.experience.forEach((experience, index) => {
    note(`experience-${index}.company`, experience.company);
    note(`experience-${index}.title`, experience.title);
  });
  profile.projects.forEach((project, index) => {
    note(`project-${index}.name`, project.name);
  });

  return {
    profile,
    evidence,
    warnings: parseWarnings,
    detectedSections: sections.map((section) => `${section.heading}`),
  };
}

/** Human summary used by the import review screen. */
export function summarizeProfile(profile: Profile): string[] {
  const lines: string[] = [];
  if (profile.identity.fullName) lines.push(`姓名 ${profile.identity.fullName}`);
  if (profile.contact.email) lines.push(`邮箱 ${profile.contact.email}`);
  if (profile.contact.phone) lines.push(`电话 ${profile.contact.phone}`);
  if (profile.education.length > 0) {
    const first = profile.education[0];
    lines.push(`教育 ${[first?.school, first?.major, first?.degree].filter(Boolean).join(" · ")}`);
  }
  if (profile.experience.length > 0) {
    const companies = profile.experience.map((item) => item.company).filter(Boolean);
    if (companies.length > 0) lines.push(`经历 ${companies.slice(0, 3).join("、")}`);
  }
  if (profile.skills.items.length > 0) lines.push(`技能 ${profile.skills.items.slice(0, 8).join(" · ")}`);
  return lines;
}
