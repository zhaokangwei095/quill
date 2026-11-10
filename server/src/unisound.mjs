/**
 * UniSound MaaS client.
 *
 * The resume pipeline uses two capabilities:
 *
 *  - u2-ocr      turns a rendered page image into faithful, line-structured text;
 *  - u2-flash    turns that text into a strict JSON draft of the profile.
 *
 * Both calls happen on this server. The platform key is read from the
 * environment and never reaches the browser.
 */

const OCR_URL = "https://maas-api.unisound.com/v1/ocr/image/extract";
const MESSAGES_URL = "https://maas-api.unisound.com/anthropic/v1/messages";
const OCR_MODEL = "u2-ocr";
const STRUCTURE_MODEL = "u2-flash";

/** Errors we can explain to the person without leaking provider internals. */
export class ProviderError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.status = status;
  }
}

function apiKey() {
  const key = process.env.UNISOUND_API_KEY;
  if (!key) {
    throw new ProviderError(
      "MODEL_NOT_CONFIGURED",
      "服务器还没有配置简历识别模型，请稍后联系维护者。",
      503,
    );
  }
  return key;
}

async function request(url, init) {
  let response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new ProviderError("MODEL_UNREACHABLE", "无法连接简历识别服务，请检查网络后重试。", 502);
  }

  const raw = await response.text();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = undefined;
  }
  return { response, payload, raw };
}

function providerFailure(payload, status) {
  const code = Number(payload?.base_resp?.status_code ?? 0);
  const message = String(payload?.base_resp?.status_msg ?? "");

  if (code === 100101 || code === 100102 || code === 100103 || code === 100106 || status === 401) {
    return new ProviderError("MODEL_UNAUTHORIZED", "简历识别服务的凭证无效，请联系维护者。", 502);
  }
  if (code === 100104) {
    return new ProviderError("MODEL_QUOTA", "简历识别额度已用尽，请联系维护者。", 502);
  }
  if (code === 100105) {
    return new ProviderError("MODEL_UNAUTHORIZED", "当前账户没有该模型的权限，请联系维护者。", 502);
  }
  if (code === 100501 || code === 100502 || status === 429) {
    return new ProviderError("MODEL_RATE_LIMIT", "简历识别请求过多，请稍等片刻后重试。", 429);
  }
  if (code === 100997 || code === 100998 || code === 100999 || status >= 500) {
    return new ProviderError("MODEL_UNAVAILABLE", "简历识别服务暂时不可用，请稍后重试。", 502);
  }
  if (code === 261001 || code === 261003) {
    return new ProviderError("OCR_BAD_FILE", "这个文件无法被识别，请换一份清晰的 PDF 或图片。", 400);
  }
  if (code === 100601) {
    return new ProviderError("FILE_TOO_LARGE", "文件超过识别服务的体积限制，请压缩后重试。", 413);
  }
  return new ProviderError(
    "MODEL_ERROR",
    message ? "简历识别服务返回了错误，请稍后重试。" : "简历识别服务暂时不可用，请稍后重试。",
    502,
  );
}

/**
 * Send one rendered page image to u2-ocr and return plain text.
 *
 * The prompt is deliberately transcription-only. Asking the OCR model to infer
 * fields made it drop section labels and invent placements in testing; the
 * structure step is a separate model with its own validation.
 */
export async function ocrPage(png, { page = 1, signal } = {}) {
  const form = new FormData();
  form.append("model", OCR_MODEL);
  form.append("type", "image");
  form.append("file", `data:image/png;base64,${png.toString("base64")}`);
  form.append(
    "prompt",
    "按页面原始顺序忠实转写这张简历图片中的全部可见文字，保留原有的标题、字段标签、行序和换行；" +
      "不要推断、改写或补充，也不要输出任何分析或说明。只输出转写文本。",
  );

  const { response, payload } = await request(OCR_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey()}` },
    body: form,
    signal,
  });

  if (!response.ok || Number(payload?.base_resp?.status_code ?? 1) !== 0) {
    throw providerFailure(payload, response.status);
  }

  const content = typeof payload?.content === "string" ? payload.content : "";
  return {
    page,
    text: cleanOcrText(content),
    usage: {
      promptTokens: Number(payload?.usage?.prompt_tokens ?? 0),
      completionTokens: Number(payload?.usage?.completion_tokens ?? 0),
      totalTokens: Number(payload?.usage?.total_tokens ?? 0),
    },
  };
}

/** Remove model decoration without touching the resume's actual words. */
export function cleanOcrText(text) {
  return text
    .replace(/^```(?:text|markdown|md)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t　]+/g, " ").trimEnd())
    .filter((line, index, lines) => line.trim().length > 0 || (lines[index - 1] ?? "").trim().length > 0)
    .join("\n")
    .trim();
}

/**
 * The schema is intentionally flat and explicit. U2-Flash provides "standard"
 * structured output — valid JSON, not schema-enforced — so every field still
 * goes through `validateDraft` on this side.
 */
const PROFILE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["identity", "contact", "preference", "education", "experience", "projects", "skills"],
  properties: {
    identity: {
      type: "object",
      additionalProperties: false,
      required: ["fullName", "gender", "birthDate", "politicalStatus", "nativePlace"],
      properties: {
        fullName: { type: "string" },
        gender: { type: "string" },
        birthDate: { type: "string" },
        politicalStatus: { type: "string" },
        nativePlace: { type: "string" },
      },
    },
    contact: {
      type: "object",
      additionalProperties: false,
      required: ["phone", "email", "currentCity", "address"],
      properties: {
        phone: { type: "string" },
        email: { type: "string" },
        currentCity: { type: "string" },
        address: { type: "string" },
      },
    },
    preference: {
      type: "object",
      additionalProperties: false,
      required: ["position", "cities", "availableFrom", "salary", "jobType"],
      properties: {
        position: { type: "string" },
        cities: { type: "array", items: { type: "string" } },
        availableFrom: { type: "string" },
        salary: { type: "string" },
        jobType: { type: "string" },
      },
    },
    education: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["school", "major", "degree", "start", "end", "gpa", "rank", "honors"],
        properties: {
          school: { type: "string" },
          major: { type: "string" },
          degree: { type: "string" },
          start: { type: "string" },
          end: { type: "string" },
          gpa: { type: "string" },
          rank: { type: "string" },
          honors: { type: "array", items: { type: "string" } },
        },
      },
    },
    experience: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["company", "title", "employmentType", "city", "start", "end", "highlights"],
        properties: {
          company: { type: "string" },
          title: { type: "string" },
          employmentType: { type: "string" },
          city: { type: "string" },
          start: { type: "string" },
          end: { type: "string" },
          highlights: { type: "array", items: { type: "string" } },
        },
      },
    },
    projects: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "category", "role", "start", "end", "highlights"],
        properties: {
          name: { type: "string" },
          category: { type: "string" },
          role: { type: "string" },
          start: { type: "string" },
          end: { type: "string" },
          highlights: { type: "array", items: { type: "string" } },
        },
      },
    },
    skills: {
      type: "object",
      additionalProperties: false,
      required: ["items", "certificates", "awards", "interests"],
      properties: {
        items: { type: "array", items: { type: "string" } },
        certificates: { type: "array", items: { type: "string" } },
        awards: { type: "array", items: { type: "string" } },
        interests: { type: "array", items: { type: "string" } },
      },
    },
  },
};

const SYSTEM_PROMPT =
  "你是简历信息抽取器。只根据简历原文抽取事实；原文没有的信息填空字符串或空数组，不得猜测。" +
  "必须严格使用给定 JSON Schema 的顶层字段名 identity、contact、preference、education、experience、projects、skills，" +
  "不得改名成 personal_info、work_experience 之类的字段，也不得新增 Schema 中没有的字段。" +
  "日期必须放在 start 和 end 里，不要用 start_date、end_date；工作与项目经历里的要点放在 highlights 数组。" +
  'experience[].employmentType 只填 "实习"、"全职"、"兼职" 之一；原文没有明确标注就填空字符串，不要根据公司或行业猜测。' +
  "preference.jobType 只填原文明确写出的求职/招聘类型（如“实习”“校招”“社招”），没有就填空字符串。" +
  '项目的 category 只填 "科研项目"、"开源项目"、"个人作品"、"其他" 之一；判断不出来就填空字符串，不要因为经历发生在课程或实训中就默认归为“其他”。' +
  "每段教育、实习、项目都单独放入数组。技能只放技术、工具、语言能力；不要把公司名或项目摘要放进去。" +
  "只输出一个 JSON 对象，不要解释，不要 Markdown 代码围栏。";

/**
 * Ask u2-flash for a structured draft.
 *
 * Thinking is disabled deliberately: with it on, a 4K response was consumed
 * entirely by reasoning in testing and never reached the JSON. The larger cap
 * leaves room for a multi-entry resume.
 */
export async function structureResume(text, { signal } = {}) {
  const { response, payload, raw } = await request(MESSAGES_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey(),
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: STRUCTURE_MODEL,
      max_tokens: 16384,
      system: SYSTEM_PROMPT,
      thinking: { type: "disabled" },
      output_config: {
        format: { type: "json_schema", schema: PROFILE_SCHEMA },
      },
      messages: [
        {
          role: "user",
          content: `请从下面的简历原文中抽取信息，按给定 JSON Schema 输出。\n\n简历原文：\n${text}`,
        },
      ],
    }),
    signal,
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new ProviderError("MODEL_UNAUTHORIZED", "简历识别服务的凭证无效，请联系维护者。", 502);
    }
    if (response.status === 429) {
      throw new ProviderError("MODEL_RATE_LIMIT", "简历识别请求过多，请稍等片刻后重试。", 429);
    }
    throw new ProviderError("MODEL_UNAVAILABLE", "简历结构化服务暂时不可用，请稍后重试。", 502);
  }

  const content = Array.isArray(payload?.content)
    ? payload.content.filter((part) => part.type === "text").map((part) => part.text).join("")
    : "";
  if (!content.trim()) {
    throw new ProviderError(
      payload?.stop_reason === "max_tokens" ? "STRUCTURE_TOO_LONG" : "STRUCTURE_EMPTY",
      payload?.stop_reason === "max_tokens"
        ? "简历内容较长，结构化结果被截断，请稍后重试。"
        : "模型没有返回可用的结构化结果，请稍后重试。",
      502,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim());
  } catch {
    throw new ProviderError("STRUCTURE_INVALID_JSON", "模型返回的结构化结果无法解析，请稍后重试。", 502);
  }

  const validation = validateDraft(parsed);
  if (!validation.ok) {
    if (validation.empty) {
      throw new ProviderError(
        "STRUCTURE_EMPTY_DRAFT",
        "模型没有从这份简历里抽取到内容，请稍后重试。",
        422,
      );
    }
    throw new ProviderError("STRUCTURE_INVALID_SHAPE", "模型返回的字段结构不完整，请稍后重试。", 502);
  }

  return {
    draft: validation.draft,
    warnings: validation.warnings,
    usage: {
      promptTokens: Number(payload?.usage?.input_tokens ?? 0),
      completionTokens: Number(payload?.usage?.output_tokens ?? 0),
      totalTokens:
        Number(payload?.usage?.input_tokens ?? 0) + Number(payload?.usage?.output_tokens ?? 0),
    },
    rawChars: raw.length,
  };
}

/* ------------------------------------------------------------- validation */

const SCHOOL_MARKER = /(大学|学院|学校|中学|高中|university|college|institute|academy|école)/i;
const BUSINESS_MARKER = /(有限公司|有限责任公司|股份|公司|集团|银行|医院|工作室|事务所|科技(?!大学|学院|学校)|\b(?:company|corporation|inc\.?|ltd\.?|corp\.?)\b)/i;
const DISCIPLINE =
  /(工程|科学|技术|管理|经济|金融|会计|统计|设计|传播|法学|医学|护理|药学|数学|物理|化学|生物|文学|教育|英语|日语|外语|新闻|艺术|历史|哲学|心理|社会|公共|建筑|土木|机械|电气|材料|环境|能源|信息|电子|通信|自动化|软件|计算机|人工智能|智能|数据|网络|安全|物联网|机器人|营销|商务|贸易|人力|资源|农业|食品|交通|物流|航空|海洋|翻译|computer science|engineering|economics|finance|accounting|statistics|physics|chemistry|biology|psychology|journalism|education|design|linguistics|english|medicine|law)/i;
const EMAIL_SHAPE = /^[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}$/;
const PHONE_SHAPE = /^\+?[\d\s()-]{7,20}$/;

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function list(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}

function firstText(...values) {
  for (const value of values) {
    const result = text(value);
    if (result) return result;
  }
  return "";
}

/**
 * Map the model's free-text project type onto the four categories the product
 * supports. Training/course projects land in `other` rather than earning a
 * category of their own.
 */
function projectCategory(value) {
  const lower = firstText(value).toLowerCase();
  if (!lower) return undefined;
  if (/科研|研究|学术|课题|论文|research|academic/.test(lower)) return "research";
  if (/开源|open.?source|github|gitee|gitlab/.test(lower)) return "opensource";
  if (/个人作品|个人项目|作品集|个人开发|portfolio|personal|side.?project/.test(lower)) {
    return "personal";
  }
  if (/其他|其它|other|课程|实训|竞赛|比赛|training|course/.test(lower)) return "other";
  return undefined;
}

/** Date keys vary even when the required shape says `start` / `end`. */
function startOf(item) {
  return firstText(item?.start, item?.start_date, item?.startDate);
}

function endOf(item) {
  return firstText(item?.end, item?.end_date, item?.endDate);
}

function dateRangeOf(item) {
  const start = date(startOf(item));
  const end = date(endOf(item));
  if (!start && !end) return undefined;
  return { ...(start ? { start } : {}), ...(end ? { end } : {}) };
}

/**
 * Some responses collapse the range into `duration: "2022.09-2026.06"`.
 * Split it rather than dropping both dates.
 */
function rangeOf(item) {
  const explicit = dateRangeOf(item);
  if (explicit) return explicit;
  const duration = firstText(item?.duration, item?.period, item?.date_range, item?.dateRange);
  if (!duration) return undefined;
  const parts = duration.split(/\s*(?:-|–|—|~|～|至)\s*|\s+to\s+/i);
  const start = date(parts[0]);
  const end = date(parts[1]);
  if (!start && !end) return undefined;
  return { ...(start ? { start } : {}), ...(end ? { end } : {}) };
}

/** Flatten nested skill categories of any depth that still holds strings. */
function flattenStrings(value, depth = 0) {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap((item) => flattenStrings(item, depth + 1));
  if (value && typeof value === "object" && depth < 3) {
    return Object.values(value).flatMap((item) => flattenStrings(item, depth + 1));
  }
  return [];
}

function dedupe(values) {
  const seen = new Set();
  return values.filter((value) => {
    const key = value.replace(/\s+/g, " ").toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function date(value) {
  const trimmed = text(value);
  if (!trimmed) return "";
  const match = trimmed.match(/((?:19|20)\d{2})(?:[.\-/年]\s*(\d{1,2}))?/);
  if (!match) return "";
  const year = match[1];
  const month = match[2]?.padStart(2, "0");
  return month ? `${year}-${month}` : year;
}

export function validateDraft(value) {
  const warnings = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, draft: undefined, warnings };
  }
  const input = value;
  /*
   * U2-Flash's structured output is "standard", not schema-enforced: it has
   * returned `personal_info` / `work_experience` / `start_date` despite the
   * schema. Read the common aliases rather than losing an entire section.
   */
  const person = input.identity ?? input.personal_info ?? input.personalInfo ?? {};
  const contact = input.contact ?? person.contact ?? person;
  const preference = input.preference ?? input.job_preference ?? input.jobPreference ?? {};
  // `skills` arrives as an object of categories, a bare list, or one string.
  const skills =
    typeof input.skills === "string"
      ? { items: [input.skills] }
      : Array.isArray(input.skills)
        ? { items: input.skills }
        : (input.skills ?? {});

  const educationInput = Array.isArray(input.education) ? input.education : [];
  const experienceInput = Array.isArray(input.experience)
    ? input.experience
    : Array.isArray(input.work_experience)
      ? input.work_experience
      : Array.isArray(input.workExperience)
        ? input.workExperience
        : Array.isArray(input.internships)
          ? input.internships
          : Array.isArray(input.work_history)
            ? input.work_history
            : [];
  const projectsInput = Array.isArray(input.projects) ? input.projects : [];

  const education = educationInput
    .map((item, index) => {
      const school = firstText(item?.school, item?.school_name);
      const major = firstText(item?.major, item?.field_of_study, item?.specialty);
      const degree = firstText(item?.degree, item?.education_level);
      const dates = rangeOf(item);
      const gpa = firstText(item?.gpa);
      const rank = firstText(item?.rank);
      const honors = dedupe(list(item?.honors ?? item?.awards));

      if (school && BUSINESS_MARKER.test(school) && !SCHOOL_MARKER.test(school)) {
        warnings.push("教育经历里出现了单位名称，已保留该条目但不把它当作学校，请核对。");
        return undefined;
      }
      if (major && (!DISCIPLINE.test(major) || /(排名|gpa|绩点|%|\d+\s*\/\s*\d+)/i.test(major))) {
        warnings.push("有一段教育经历的专业看起来不像学科名称，已留空，请核对。");
        return {
          id: `edu-${index + 1}`,
          ...(school ? { school } : {}),
          ...(degree ? { degree } : {}),
          ...(dates ? { dates } : {}),
          ...(gpa ? { gpa } : {}),
          ...(rank ? { rank } : {}),
          ...(honors.length ? { honors } : {}),
        };
      }
      return {
        id: `edu-${index + 1}`,
        ...(school ? { school } : {}),
        ...(major ? { major } : {}),
        ...(degree ? { degree } : {}),
        ...(dates ? { dates } : {}),
        ...(gpa ? { gpa } : {}),
        ...(rank ? { rank } : {}),
        ...(honors.length ? { honors } : {}),
      };
    })
    .filter(Boolean);

  const experience = experienceInput
    .map((item, index) => {
      const company = firstText(item?.company, item?.company_name, item?.employer);
      const title = firstText(item?.title, item?.position, item?.job_title);
      const employmentType = firstText(
        item?.employmentType,
        item?.employment_type,
        item?.jobType,
        item?.job_type,
      );
      const city = firstText(item?.city, item?.location);
      const dates = rangeOf(item);
      const highlights = list(item?.highlights);
      if (highlights.length === 0) {
        highlights.push(
          ...list(item?.description),
          ...list(item?.responsibilities),
          ...list(item?.achievements),
        );
      }

      if (company && SCHOOL_MARKER.test(company) && !BUSINESS_MARKER.test(company)) {
        warnings.push("工作经历里出现了学校名称，已保留该条目但不把它当作单位，请核对。");
        return undefined;
      }
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
    .filter(Boolean);

  const projects = projectsInput
    .map((item, index) => {
      const name = firstText(item?.name, item?.project_name, item?.title);
      if (!name) return undefined;
      const role = firstText(item?.role, item?.position);
      const dates = rangeOf(item);
      const highlights = list(item?.highlights);
      if (highlights.length === 0) {
        highlights.push(
          ...list(item?.description),
          ...list(item?.responsibilities),
          ...list(item?.achievements),
        );
      }
      const category =
        projectCategory(firstText(item?.category, item?.type)) ??
        projectCategory([name, role, ...highlights].join(" "));
      return {
        id: `proj-${index + 1}`,
        name,
        ...(category ? { category } : {}),
        ...(role ? { role } : {}),
        ...(dates ? { dates } : {}),
        highlights,
      };
    })
    .filter(Boolean);

  const awardKeys = new Set();
  for (const entry of education) {
    for (const honor of entry.honors ?? []) awardKeys.add(honor.replace(/\s+/g, "").toLowerCase());
  }
  const rawAwards = list(skills.awards ?? skills.honors);
  const awards = dedupe(rawAwards).filter(
    (award) => !awardKeys.has(award.replace(/\s+/g, "").toLowerCase()),
  );
  if (awards.length !== rawAwards.length) {
    warnings.push("奖项与教育荣誉有重复，已合并，请核对。");
  }

  const phone = firstText(contact.phone, contact.mobile, contact.phone_number);
  const email = firstText(contact.email, contact.email_address);
  if (phone && !PHONE_SHAPE.test(phone)) warnings.push("识别到的手机号格式不完整，请核对。");
  if (email && !EMAIL_SHAPE.test(email)) warnings.push("识别到的邮箱格式不完整，请核对。");

  const fullName = firstText(person.fullName, person.full_name, person.name);
  const gender = firstText(person.gender);
  const birth = date(firstText(person.birthDate, person.birth_date, person.date_of_birth));
  const politicalStatus = firstText(person.politicalStatus, person.political_status);
  const nativePlace = firstText(person.nativePlace, person.native_place, person.hometown);
  const currentCity = firstText(
    contact.currentCity,
    contact.current_city,
    contact.city,
    contact.location,
  );
  const address = firstText(contact.address);

  const preferencePosition = firstText(
    preference.position,
    preference.desired_position,
    preference.job_intention,
  );
  const cities = list(preference.cities ?? preference.desired_cities ?? preference.city);
  const availableFrom = firstText(
    preference.availableFrom,
    preference.available_from,
    preference.availability,
  );
  const salary = firstText(preference.salary, preference.expected_salary);
  const jobType = firstText(
    preference.jobType,
    preference.job_type,
    preference.employmentType,
    preference.employment_type,
    preference.targetTrack,
    preference.target_track,
  );

  const skillItems = list(skills.items ?? skills.skills);
  const reservedSkillKeys = new Set([
    "items",
    "skills",
    "certificates",
    "certifications",
    "language_certificates",
    "awards",
    "honors",
    "interests",
    "hobbies",
  ]);
  const categoryItems = Object.entries(skills)
    .filter(([key]) => !reservedSkillKeys.has(key))
    .flatMap(([, value]) => flattenStrings(value));

  const draft = {
    identity: {
      ...(fullName ? { fullName } : {}),
      ...(gender ? { gender } : {}),
      ...(birth ? { birthDate: birth } : {}),
      ...(politicalStatus ? { politicalStatus } : {}),
      ...(nativePlace ? { nativePlace } : {}),
    },
    contact: {
      ...(phone ? { phone } : {}),
      ...(email ? { email } : {}),
      ...(currentCity ? { currentCity } : {}),
      ...(address ? { address } : {}),
    },
    preference: {
      ...(preferencePosition ? { position: preferencePosition } : {}),
      cities,
      ...(availableFrom ? { availableFrom } : {}),
      ...(salary ? { salary } : {}),
      ...(jobType ? { jobType } : {}),
    },
    education,
    experience,
    projects,
    skills: {
      items: dedupe(skillItems.length > 0 ? skillItems : categoryItems),
      certificates: dedupe(
        list(skills.certificates ?? skills.certifications ?? skills.language_certificates),
      ),
      awards,
      interests: dedupe(list(skills.interests ?? skills.hobbies)),
    },
  };

  if (draft.education.length === 0) warnings.push("模型没有识别出教育经历，请核对。");
  if (draft.experience.length === 0 && draft.projects.length === 0) {
    warnings.push("模型没有识别出工作或项目经历，请核对。");
  }

  const hasContent =
    Boolean(draft.identity.fullName) ||
    Boolean(draft.contact.phone) ||
    Boolean(draft.contact.email) ||
    draft.education.length > 0 ||
    draft.experience.length > 0 ||
    draft.projects.length > 0 ||
    draft.skills.items.length > 0 ||
    draft.skills.certificates.length > 0;

  if (!hasContent) {
    // An empty shape is not a usable draft: the caller should fall back rather
    // than replace the person's profile with blanks.
    return { ok: false, draft: undefined, warnings, empty: true };
  }

  return { ok: true, draft, warnings: [...new Set(warnings)] };
}

export { OCR_MODEL, STRUCTURE_MODEL, PROFILE_SCHEMA };
