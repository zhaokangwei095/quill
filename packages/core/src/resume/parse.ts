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
  unique,
} from "../text.js";
import {
  segmentResume,
  splitEntries,
  splitHeaderFields,
  stripDateRange,
  type ResumeSection,
} from "./segment.js";
import {
  type Contact,
  type Education,
  type Essays,
  type Experience,
  type Identity,
  type JobPreference,
  type Profile,
  type Project,
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

function parseIdentity(header: string[], section: ResumeSection | undefined): { identity: Identity; contact: Contact } {
  const identity: Identity = {};
  const contact: Contact = {};
  const lines = [...header, ...(section?.lines ?? [])];
  const joined = lines.join(" ");

  // Email and phone are worth hunting for globally — they are unambiguous.
  const email = firstMatch(joined, EMAIL);
  if (email) contact.email = email;

  const phone = firstMatch(joined, PHONE_CN);
  if (phone) contact.phone = phone.replace(/\s+/g, "");
  else {
    const intl = firstMatch(joined, PHONE_INTL);
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
        case "fullName":
          identity.fullName = value;
          break;
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
    for (const line of header.slice(0, 4)) {
      const candidate = line.trim().split(/\s+/)[0] ?? "";
      if (/^[\u4E00-\u9FFF]{2,4}$/.test(candidate)) {
        identity.fullName = candidate;
        break;
      }
      // Latin names: "Zhang San" / "San Zhang" near the top.
      if (/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}$/.test(line.trim())) {
        identity.fullName = line.trim();
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
        contact.currentCity ??= rawValue.trim();
      } else if (/^(地址|通讯地址|联系地址|现住址|address)/.test(key)) {
        contact.address ??= rawValue.trim();
      } else if (/^(微信|wechat)/.test(key)) {
        contact.wechat ??= rawValue.trim();
      } else if (/^(邮编|postal|zip)/.test(key)) {
        contact.postalCode ??= rawValue.trim();
      }
    }
  }

  // Age is derived, never stored as fact.
  return { identity, contact };
}

/* ---------------------------------------------------------------- education */

function parseEducation(section: ResumeSection | undefined): Education[] {
  if (!section) return [];
  const entries = splitEntries(section.lines, "education");
  const out: Education[] = [];

  entries.forEach((entry, index) => {
    const text = entry.join("\n");
    if (!text.trim()) return;
    const education: Education = { id: `edu-${index + 1}` };

    // Lines that are only a date range describe the whole entry.
    const dateLine = entry.find((line) => isDateLine(line));
    if (dateLine) education.dates = parseDateRange(dateLine);

    for (const line of entry) {
      // "北京大学 计算机科学与技术 本科 2018-2022" — strip the range first so
      // "2018-2022" cannot be mistaken for a GPA or a course list.
      const headerOnly = stripDateRange(line);
      const parts = splitHeaderFields(headerOnly);
      for (const [rawKey, rawValue] of pairsIn(line)) {
        const key = normalize(rawKey);
        const value = rawValue.trim();
        if (/^(学校|院校|毕业院校|school|university)/.test(key)) education.school = value;
        else if (/^(专业|major|specialty)/.test(key)) education.major = value;
        else if (/^(学历|degree|education)/.test(key)) education.degree = pickToken(value, DEGREE_LEVELS) ?? value;
        else if (/^(学位|academic)/.test(key)) education.academicDegree = pickToken(value, ACADEMIC_DEGREES) ?? value;
        else if (/^(gpa|平均分|绩点|成绩)/.test(key)) education.gpa = value;
        else if (/^(排名|rank)/.test(key)) education.rank = value;
        else if (/^(主修课程|课程|coursework)/.test(key)) education.courses = value;
      }

      // Unlabelled lines: the school is the token with a university marker.
      if (!education.school) {
        const school = parts.find((part) =>
          /(大学|学院|学校|university|college|institute|academy|école)/i.test(part),
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
        }
        else if (parts.length >= 2 && !DATE_TOKEN.test(parts[0] ?? "") && (parts[0] ?? "").length <= 30) {
          education.school = parts[0];
        }
      }
      if (!education.major) {
        const major = parts.find((part) =>
          /(专业|工程|科学|技术|管理|经济|金融|设计|传播|法学|医学|数学|物理|化学|文学|教育)/.test(part) &&
          !/(大学|学院|学校)/.test(part),
        );
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
      if (!education.gpa) {
        const gpa = headerOnly.match(/(?:gpa|绩点|平均分|成绩)[:：\s]*([0-9]{1,3}(?:\.[0-9]{1,2})?(?:\s*\/\s*[0-9.]{1,4})?%?)/i);
        if (gpa?.[1]) education.gpa = gpa[1].trim();
      }
      if (!education.rank) {
        const rank = headerOnly.match(/(?:排名|rank)[:：\s]*([0-9]+\s*\/\s*[0-9]+|[0-9]+%)/i);
        if (rank?.[1]) education.rank = rank[1].trim();
      }
      if (!education.dates) {
        const range = parseDateRange(line);
        if (range) education.dates = range;
      }
    }

    // Honor / scholarship lines inside an education entry.
    const honors = entry.filter((line) => /(奖学金|荣誉|优秀|标兵|三好|称号|scholarship|honor|award)/i.test(line));
    if (honors.length > 0) education.honors = unique(honors.map((line) => line.trim()));

    if (education.school || education.major || education.degree) out.push(education);
  });

  // If we found degrees but no schools, keep them — some resumes list only the
  // qualification (e.g. a certificate-focused CV).
  return out;
}

/* --------------------------------------------------------------- experience */

function parseExperience(section: ResumeSection | undefined): Experience[] {
  if (!section) return [];
  const entries = splitEntries(section.lines, "experience");
  const out: Experience[] = [];

  entries.forEach((entry, index) => {
    if (entry.length === 0) return;
    const experience: Experience = { id: `exp-${index + 1}`, highlights: [] };
    const dateLine = entry.find((line) => isDateLine(line));
    if (dateLine) experience.dates = parseDateRange(dateLine);

    for (const line of entry) {
      for (const [rawKey, rawValue] of pairsIn(line)) {
        const key = normalize(rawKey);
        const value = rawValue.trim();
        if (!value) continue;
        if (/^(公司|单位|雇主|company|employer|organization)/.test(key)) experience.company = value;
        else if (/^(部门|department|division)/.test(key)) experience.department = value;
        else if (/^(职位|岗位|职务|position|title|role)/.test(key)) experience.title = value;
        else if (/^(工作性质|雇佣|employment type|job type)/.test(key)) experience.employmentType = value;
        else if (/^(工作地点|location)/.test(key)) experience.city = value;
        else if (/^(薪资|salary|薪酬)/.test(key)) experience.salary = value;
        else if (/^(汇报|reports to|supervisor)/.test(key)) experience.reportsTo = value;
        else if (/^(下属|团队规模|team size)/.test(key)) experience.teamSize = value;
        else if (/^(离职原因|reason for leaving)/.test(key)) experience.leaveReason = value;
        else if (/^(证明人|推荐人|reference)/.test(key)) experience.refereeName = value;
      }
    }

    // The first line of an experience entry is nearly always
    // "公司 | 职位 | 时间".
    const headerLine = entry.find((line) => !/^[\u2022\u25CF\u25AA\u002A\u002D\u2013\u2014·•▪◦]/.test(line.trim()));
    if (headerLine) {
      // Aggressive splitting is right here: latin entry headers use commas.
      const parts = splitHeaderFields(stripDateRange(headerLine), true);
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

    // Everything that is not the header is a highlight.
    const bodyLines = entry.filter((line) => line !== headerLine);
    experience.highlights = bodyLines
      .map((line) => line.trim())
      .filter((line) => line.length >= 4 && !/^[\d\s年/\-.,~—–至到]+$/.test(line));

    if (experience.company || experience.title) out.push(experience);
  });

  return out;
}

/* ------------------------------------------------------------------ project */

function parseProjects(section: ResumeSection | undefined): Project[] {
  if (!section) return [];
  const entries = splitEntries(section.lines, "project");
  const out: Project[] = [];

  entries.forEach((entry, index) => {
    if (entry.length === 0) return;
    const project: Project = { id: `proj-${index + 1}`, highlights: [] };
    const dateLine = entry.find((line) => isDateLine(line));
    if (dateLine) project.dates = parseDateRange(dateLine);

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
    if (headerLine && !project.name) {
      const parts = splitHeaderFields(headerLine);
      const withoutDates = parts.filter((part) => !/^[\d\s年/\-.,~—–至到至今presentcurrentnow]+$/i.test(part));
      if (withoutDates[0]) project.name = withoutDates[0].trim();
      if (!project.role) {
        const role = withoutDates.find((part) => /(负责人|核心|成员|开发|设计|主导|参与|owner|lead|developer|designer|member|intern)/i.test(part));
        if (role) project.role = role.trim();
      }
    }

    const bodyLines = entry.filter((line) => line !== headerLine);
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
  "JavaScript", "TypeScript", "Python", "Java", "Go", "Golang", "C++", "C#", "Rust", "Ruby", "PHP", "Swift",
  "Kotlin", "Scala", "Objective-C", "Dart", "HTML", "CSS", "SCSS", "Sass", "Less", "Tailwind", "React",
  "Vue", "Vue.js", "Angular", "Svelte", "Next.js", "Nuxt", "Node.js", "Express", "Koa", "NestJS", "Django",
  "Flask", "FastAPI", "Spring", "Spring Boot", "MyBatis", "MySQL", "PostgreSQL", "MongoDB", "Redis", "Elasticsearch",
  "Kafka", "RabbitMQ", "Docker", "Kubernetes", "K8s", "Jenkins", "Git", "GitLab", "GitHub", "Linux", "Nginx",
  "Flink", "Hive", "HBase", "ClickHouse", "Doris", "StarRocks", "Airflow", "Zookeeper", "Dubbo", "Thrift",
  "Prometheus", "Grafana", "ELK", "SkyWalking", "Istio", "Terraform", "Ansible",
  "AWS", "Azure", "GCP", "阿里云", "腾讯云", "Figma", "Sketch", "Photoshop", "Illustrator", "After Effects",
  "Premiere", "Blender", "Unity", "Unreal", "PyTorch", "TensorFlow", "Pandas", "NumPy", "Spark", "Hadoop",
  "SQL", "Excel", "Tableau", "Power BI", "Matlab", "R", "Shell", "Bash", "Webpack", "Vite", "Rollup",
  "GraphQL", "REST", "gRPC", "WebSocket", "Three.js", "WebGL", "Flutter", "React Native", "小程序", "Axure",
];

export function detectStack(text: string): string[] {
  const found: string[] = [];
  const haystack = ` ${text} `;
  for (const token of TECH_TOKENS) {
    // Escape regex metacharacters (C++, C#, .NET …).
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const boundary = /^[\w]/.test(token) ? `(?<![\\w+#.])` : "";
    const tail = /[\w+#]$/.test(token) ? `(?![\\w+#])` : "";
    const re = new RegExp(`${boundary}${escaped}${tail}`, "i");
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

  // Pass 3: lines with no label at all. Certificate and award wording is
  // distinctive enough to classify by keyword, but we must not add the whole
  // line when pass 1 already split it into items.
  for (const line of section.lines) {
    const hasPairs = pairsIn(line).length > 0;
    if (hasPairs) continue;
    if (/(证书|certificate|certification|资格证|等级证|CET|雅思|托福|IELTS|TOEFL|GRE|GMAT|CPA|CFA|PMP|驾照)/i.test(line)) {
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

function parsePreference(section: ResumeSection | undefined, fallbackPosition?: string): JobPreference {
  const preference: JobPreference = { cities: [], industries: [] };

  if (section) {
    for (const line of section.lines) {
      // Preference blocks are often a single line of pairs.
      const pairs = pairsIn(line);
      if (pairs.length > 0) {
        for (const [rawKey, rawValue] of pairs) {
          const key = normalize(rawKey);
          const value = rawValue.trim();
          if (!value) continue;
          if (/^(意向岗位|期望岗位|应聘岗位|求职岗位|岗位|position|target role)/.test(key)) preference.position = value;
          else if (/^(意向城市|期望城市|意向地区|工作地点|city|location)/.test(key)) preference.cities = splitList(value);
          else if (/^(期望薪资|薪资|salary)/.test(key)) preference.salary = value;
          else if (/^(到岗|入职时间|available|availability)/.test(key)) preference.availableFrom = value;
          else if (/^(求职类型|job type)/.test(key)) preference.jobType = value;
          else if (/^(行业|industry)/.test(key)) preference.industries = splitList(value);
          else if (/^(调剂|relocation)/.test(key)) preference.relocation = value;
        }
        continue;
      }
      const text = line.trim();
      if (/(求职意向|职业目标|objective)/i.test(text)) {
        const after = text.replace(/^.*?[:：]/, "").trim();
        if (after) {
          const cityHits = splitList(after).filter((part) => /(北京|上海|深圳|广州|杭州|成都|南京|武汉|西安|苏州|天津|重庆|长沙|青岛|合肥|厦门|郑州|济南|福州|宁波|无锡|东莞|佛山)/.test(part));
          if (!preference.position) {
            const first = splitList(after)[0];
            if (first) preference.position = first;
          }
          if (cityHits.length > 0) preference.cities = unique([...preference.cities, ...cityHits]);
        }
      }
    }
  }

  if (!preference.position && fallbackPosition) preference.position = fallbackPosition;
  preference.cities = unique(preference.cities);
  return preference;
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

  const { identity, contact } = parseIdentity(header, mergedIdentitySection);
  if (options.fallbackName && !identity.fullName) identity.fullName = options.fallbackName;
  profile.identity = identity;
  profile.contact = contact;
  profile.education = parseEducation(educationSection);
  profile.experience = parseExperience(experienceSection);
  profile.projects = parseProjects(projectSection);
  profile.skills = parseSkills(skillSection);
  profile.preference = parsePreference(preferenceSection, options.fallbackPosition);
  profile.essays = parseEssays(sections);

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
    warnings,
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
