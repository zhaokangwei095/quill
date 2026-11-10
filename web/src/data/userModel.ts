/**
 * The person's own model endpoint.
 *
 * Two jobs use it:
 *  - turning resume text into the same draft shape the recognition server
 *    returns, so the rest of the import path is unchanged;
 *  - extracting requirements from a job posting when the person does not want
 *    to use the local rule engine.
 *
 * The request goes straight from the browser to the endpoint the person
 * configured. Quill's server never sees this key, and nothing here is written
 * to storage beyond the settings object the person already owns.
 *
 * Both OpenAI-compatible (`/chat/completions`) and Anthropic-compatible
 * (`/v1/messages`) endpoints are supported. They differ in headers, body and
 * response shape, but the prompts are shared.
 */

import {
  analyzeJd,
  type JdAnalysis,
  type ModelConfig,
  type ModelDraftEducation,
  type ModelDraftExperience,
  type ModelDraftProject,
  type ModelResumeDraft,
} from "@quill/core";
import type { ModelResumeResult } from "./model.js";

const TIMEOUT_MS = 120_000;
const MAX_RESUME_CHARS = 60_000;

export class UserModelError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "UserModelError";
    this.code = code;
  }
}

/* ------------------------------------------------------------------ request */

function baseUrl(config: ModelConfig): string {
  const trimmed = config.baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new UserModelError("NO_ENDPOINT", "还没有填写自定义模型的 Base URL。");
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new UserModelError("BAD_ENDPOINT", "Base URL 需要以 http:// 或 https:// 开头。");
  }
  return trimmed;
}

function endpointFor(config: ModelConfig): string {
  const base = baseUrl(config);
  if (config.protocol === "anthropic") {
    if (/\/v1\/messages$/i.test(base)) return base;
    if (/\/v1$/i.test(base)) return `${base}/messages`;
    if (/\/anthropic$/i.test(base)) return `${base}/v1/messages`;
    return `${base}/v1/messages`;
  }
  if (/\/chat\/completions$/i.test(base)) return base;
  if (/\/v1$/i.test(base)) return `${base}/chat/completions`;
  try {
    const path = new URL(base).pathname.replace(/\/+$/, "");
    if (!path || path === "/") return `${base}/v1/chat/completions`;
  } catch {
    // baseUrl() already rejected anything that is not an absolute URL.
  }
  return `${base}/chat/completions`;
}

function providerMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const error = (payload as { error?: unknown }).error;
  if (typeof error === "string") return error.slice(0, 240);
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message.slice(0, 240);
  }
  const message = (payload as { message?: unknown }).message;
  return typeof message === "string" ? message.slice(0, 240) : undefined;
}

function textFromOpenAi(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const message = (choices[0] as { message?: unknown })?.message;
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
          ? ((part as { text: string }).text)
          : "",
      )
      .join("");
  }
  return "";
}

function textFromAnthropic(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const content = (payload as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
        ? ((part as { text: string }).text)
        : "",
    )
    .join("");
}

async function callModel(
  config: ModelConfig,
  system: string,
  user: string,
  maxTokens: number,
): Promise<string> {
  const apiKey = config.apiKey.trim();
  if (!apiKey) throw new UserModelError("NO_KEY", "还没有填写自定义模型的 API Key。");
  const model = config.model.trim();
  if (!model) throw new UserModelError("NO_MODEL", "还没有填写模型名称。");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const temperature = Number.isFinite(config.temperature)
    ? Math.min(2, Math.max(0, config.temperature))
    : 0.2;

  const anthropic = config.protocol === "anthropic";
  const headers: Record<string, string> = { "content-type": "application/json" };
  let body: string;

  if (anthropic) {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
    // Anthropic requires this opt-in for browser-origin requests.
    headers["anthropic-dangerous-direct-browser-access"] = "true";
    body = JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature,
      system,
      messages: [{ role: "user", content: user }],
    });
  } else {
    headers.authorization = `Bearer ${apiKey}`;
    body = JSON.stringify({
      model,
      temperature,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
  }

  let response: Response;
  try {
    response = await fetch(endpointFor(config), {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof UserModelError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new UserModelError("TIMEOUT", "自定义模型响应超时，请稍后重试或换一个更快的模型。");
    }
    throw new UserModelError(
      "UNREACHABLE",
      "无法连接自定义模型。请检查 Base URL、网络，以及该服务是否允许浏览器直连（CORS）；在扩展内打开工作台时不受 CORS 限制。",
    );
  } finally {
    clearTimeout(timer);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }

  if (!response.ok) {
    const detail = providerMessage(payload);
    if (response.status === 401 || response.status === 403) {
      throw new UserModelError("UNAUTHORIZED", "自定义模型服务拒绝了 API Key，请核对后重试。");
    }
    if (response.status === 429) {
      throw new UserModelError("RATE_LIMIT", "自定义模型的额度或频率受限，请稍后再试。");
    }
    throw new UserModelError(
      `HTTP_${response.status}`,
      detail
        ? `自定义模型返回错误：${detail}`
        : `自定义模型服务返回 HTTP ${response.status}。`,
    );
  }

  const content = anthropic ? textFromAnthropic(payload) : textFromOpenAi(payload);
  if (!content.trim()) {
    throw new UserModelError("EMPTY", "自定义模型没有返回内容，请检查模型名称与接口协议。");
  }
  return content;
}

/* --------------------------------------------------------------- utilities */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function stringList(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(/\r?\n|[；;]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .flatMap((item) => (typeof item === "string" ? item.split(/\r?\n/) : []))
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

const DATE_TOKEN =
  /(?:19|20)\d{2}(?:\s*[.\-/年]\s*\d{1,2}(?:\s*月)?)?|(?:19|20)\d{2}\s*年?/g;

function range(value: unknown): { start?: string; end?: string; current?: boolean } | undefined {
  if (typeof value === "string") {
    return rangeFromString(value);
  }
  const record = asRecord(value);
  if (!record) return undefined;
  const start = text(record.start) ?? text(record.start_date);
  const end = text(record.end) ?? text(record.end_date);
  if (!start && !end) return rangeFromString(text(record.duration) ?? "");
  const current =
    record.current === true ||
    Boolean(end && /至今|现在|目前|present|current|now/i.test(end));
  return {
    ...(start ? { start } : {}),
    ...(!current && end ? { end } : {}),
    ...(current ? { current: true } : {}),
  };
}

function rangeFromString(value: string): { start?: string; end?: string; current?: boolean } | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const tokens = trimmed.match(DATE_TOKEN)?.map((item) => item.replace(/\s+/g, " ").trim()) ?? [];
  if (tokens.length === 0) {
    return /至今|现在|目前|present|current|now/i.test(trimmed) ? { current: true } : undefined;
  }
  const current = /至今|现在|目前|present|current|now/i.test(trimmed);
  return {
    start: tokens[0],
    ...(tokens[1] ? { end: tokens[1] } : current ? { current: true } : {}),
  };
}

function jsonObject(raw: string): Record<string, unknown> {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  const candidate = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
  try {
    const parsed = JSON.parse(candidate) as unknown;
    const record = asRecord(parsed);
    if (!record) throw new Error("not an object");
    return record;
  } catch {
    throw new UserModelError("INVALID_JSON", "自定义模型返回的不是有效 JSON，请重试或换一个模型。");
  }
}

/* ---------------------------------------------------------- resume draft */

const RESUME_SYSTEM = [
  "你是简历信息抽取器。只根据简历原文抽取事实；原文没有的信息填空字符串或空数组，不得猜测，也不得把公司名写成学校。",
  "严格返回一个 JSON 对象，不要 Markdown 代码围栏，不要解释。结构必须如下：",
  '{"identity":{"fullName":"","gender":"","birthDate":"","politicalStatus":"","nativePlace":""},',
  '"contact":{"phone":"","email":"","currentCity":"","address":""},',
  '"preference":{"position":"","cities":[],"availableFrom":"","salary":"","jobType":""},',
  '"education":[{"school":"","major":"","degree":"","dates":{"start":"YYYY-MM","end":"YYYY-MM"},"gpa":"","rank":"","honors":[]}],',
  '"experience":[{"company":"","title":"","employmentType":"","city":"","dates":{"start":"YYYY-MM","end":"YYYY-MM"},"highlights":[""]}],',
  '"projects":[{"name":"","category":"","role":"","dates":{"start":"YYYY-MM","end":"YYYY-MM"},"highlights":[""]}],',
  '"skills":{"items":[],"certificates":[],"awards":[],"interests":[]}}',
  "日期只放在 dates.start / dates.end，不要用 start_date、end_date；仍在进行时 end 留空并在原文有“至今”时写“至今”。",
  'experience[].employmentType 只填 "实习"、"全职"、"兼职" 之一；原文没有明确标注就留空，不要根据公司或行业猜测。',
  "preference.jobType 只填原文明确写出的求职/招聘类型（如“实习”“校招”“社招”），没有就留空。",
  'projects[].category 只填 "科研项目"、"开源项目"、"个人作品"、"其他" 之一；判断不出来就留空。',
  "工作与项目内容放在 highlights 数组，每条一个要点；原文是整段时按句号、分号或换行拆成多条。",
  "技能只放技术、工具、语言能力；不要把公司名或项目摘要放进去。",
  "每段教育、实习、项目都单独放入数组。",
].join("");

/**
 * Repair the aliases models commonly produce despite the prompt.
 * The server has a richer validator; this is the browser-side equivalent for
 * user-supplied endpoints, which vary much more than u2-flash.
 */
function normalizeResumeDraft(raw: Record<string, unknown>): ModelResumeDraft {
  const identity =
    asRecord(raw.identity) ??
    asRecord(raw.personal_info) ??
    asRecord(raw.basic_info) ??
    asRecord(raw.profile) ??
    {};
  const contact = asRecord(raw.contact) ?? asRecord(raw.contact_info) ?? {};
  const preference =
    asRecord(raw.preference) ??
    asRecord(raw.job_intention) ??
    asRecord(raw.job_preference) ??
    asRecord(raw.intention) ??
    {};

  const mapEducation = (value: unknown): ModelDraftEducation[] =>
    Array.isArray(value)
      ? value.map((item) => {
          const source = asRecord(item) ?? {};
          return {
            school: text(source.school ?? source.school_name ?? source.university),
            major: text(source.major ?? source.field_of_study),
            degree: text(source.degree ?? source.education_level),
            dates: range(source.dates ?? source),
            gpa: text(source.gpa),
            rank: text(source.rank ?? source.ranking),
            honors: stringList(source.honors ?? source.awards),
          };
        })
      : [];

  const mapExperience = (value: unknown): ModelDraftExperience[] =>
    Array.isArray(value)
      ? value.map((item) => {
          const source = asRecord(item) ?? {};
          return {
            company: text(source.company ?? source.company_name ?? source.employer),
            title: text(source.title ?? source.position ?? source.job_title),
            employmentType: text(
              source.employmentType ??
                source.employment_type ??
                source.jobType ??
                source.job_type,
            ),
            city: text(source.city ?? source.location),
            dates: range(source.dates ?? source),
            highlights: stringList(
              source.highlights ??
                source.responsibilities ??
                source.achievements ??
                source.description,
            ),
          };
        })
      : [];

  const mapProjects = (value: unknown): ModelDraftProject[] =>
    Array.isArray(value)
      ? value.map((item) => {
          const source = asRecord(item) ?? {};
          return {
            name: text(source.name ?? source.project_name ?? source.title),
            category: text(source.category ?? source.type),
            role: text(source.role ?? source.position),
            dates: range(source.dates ?? source),
            highlights: stringList(
              source.highlights ??
                source.description ??
                source.responsibilities ??
                source.achievements,
            ),
          };
        })
      : [];

  const skillsSource = raw.skills;
  const skillsRecord = asRecord(skillsSource) ?? {};
  const skillItems = Array.isArray(skillsSource)
    ? stringList(skillsSource)
    : stringList(skillsRecord.items ?? skillsRecord.skills ?? skillsRecord.technical);

  return {
    identity: {
      fullName: text(identity.fullName) ?? text(identity.name),
      gender: text(identity.gender),
      birthDate: text(identity.birthDate) ?? text(identity.birth_date),
      politicalStatus: text(identity.politicalStatus) ?? text(identity.political_status),
      nativePlace: text(identity.nativePlace) ?? text(identity.hometown),
    },
    contact: {
      phone: text(contact.phone) ?? text(contact.mobile),
      email: text(contact.email),
      currentCity: text(contact.currentCity) ?? text(contact.city),
      address: text(contact.address),
    },
    preference: {
      position: text(preference.position) ?? text(preference.job_title),
      cities: stringList(preference.cities ?? preference.city),
      availableFrom: text(preference.availableFrom) ?? text(preference.available_from),
      salary: text(preference.salary) ?? text(preference.expected_salary),
      jobType:
        text(preference.jobType) ??
        text(preference.job_type) ??
        text(preference.employmentType) ??
        text(preference.employment_type) ??
        text(preference.targetTrack) ??
        text(preference.target_track),
    },
    education: mapEducation(raw.education ?? raw.education_history),
    experience: mapExperience(
      raw.experience ?? raw.work_experience ?? raw.internships ?? raw.work_history,
    ),
    projects: mapProjects(raw.projects ?? raw.project_experience),
    skills: {
      items: skillItems,
      certificates: stringList(skillsRecord.certificates ?? skillsRecord.certifications),
      awards: stringList(skillsRecord.awards ?? skillsRecord.honors),
      interests: stringList(skillsRecord.interests ?? skillsRecord.hobbies),
    },
  };
}

export async function extractResumeWithUserModel(
  text: string,
  config: ModelConfig,
): Promise<ModelResumeResult> {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new UserModelError("EMPTY_RESUME", "这份文件里没有可读取的文字。");
  }

  const clipped = trimmed.slice(0, MAX_RESUME_CHARS);
  const raw = await callModel(
    config,
    RESUME_SYSTEM,
    `请从下面的简历原文中抽取信息，严格按给定 JSON 结构输出。\n\n简历原文：\n${clipped}`,
    8192,
  );
  const draft = normalizeResumeDraft(jsonObject(raw));

  const warnings: string[] = [];
  if (trimmed.length > MAX_RESUME_CHARS) {
    warnings.push("简历文字较长，只把前 60,000 字交给自定义模型，请核对后半部分。");
  }
  if (
    (draft.education?.length ?? 0) === 0 &&
    (draft.experience?.length ?? 0) === 0 &&
    (draft.projects?.length ?? 0) === 0
  ) {
    warnings.push("自定义模型没有识别出经历结构，请核对解析结果或换一个模型。");
  }

  return {
    text: trimmed,
    draft,
    warnings,
    source: "text",
    pageCount: 1,
  };
}

/* --------------------------------------------------------------- job post */

const JD_SYSTEM = [
  "你是招聘岗位分析器。只根据岗位描述抽取要求，不得编造。",
  "严格返回一个 JSON 对象，不要 Markdown 代码围栏，不要解释。结构：",
  '{"role":"","company":"","city":"","minYears":0,"degrees":["本科"],',
  '"requirements":[{"text":"","keywords":["Go"],"mustHave":true,"soft":false}]}',
  "每条 requirement 用原文中的一句话，不要把多个独立要求合并成一条。",
  "mustHave 表示硬性要求；加分项、优先条件为 false。",
  "soft 表示沟通能力、团队协作、抗压能力等无法从简历证明的软要求。",
  "keywords 放技术、工具、语言、证书、行业能力等可以被简历验证的词。",
  "minYears 只填原文明确写出的最低年限，没有就填 0；degrees 只填原文要求的最低学历。",
].join("");

function normalizeJd(
  raw: Record<string, unknown>,
  base: JdAnalysis,
  declaredRole?: string,
): JdAnalysis {
  const requirements = Array.isArray(raw.requirements)
    ? raw.requirements
        .map((item) => {
          const source = asRecord(item) ?? {};
          const requirement = text(source.text) ?? text(source.requirement);
          if (!requirement || requirement.length < 3) return undefined;
          const keywords = stringList(source.keywords ?? source.skills).slice(0, 12);
          const mustHave = source.mustHave === true || source.must_have === true;
          const soft = source.soft === true;
          return {
            text: requirement,
            keywords,
            weight: mustHave ? 3 : soft ? 1 : 2,
            mustHave,
            soft,
            derivedKeywords: false,
          };
        })
        .filter((item): item is NonNullable<typeof item> => item !== undefined)
        .slice(0, 40)
    : [];

  if (requirements.length === 0) {
    throw new UserModelError("EMPTY_JD", "自定义模型没有从这段岗位描述里提取出要求。");
  }

  const minYearsValue = Number(raw.minYears ?? raw.min_years);
  const degrees = stringList(raw.degrees ?? raw.degree);
  const keywords = [...new Set(requirements.flatMap((item) => item.keywords))];
  const company = text(raw.company) ?? base.company;
  const city = text(raw.city) ?? base.city;
  const minYears =
    Number.isFinite(minYearsValue) && minYearsValue > 0 && minYearsValue < 40
      ? Math.floor(minYearsValue)
      : base.minYears;

  return {
    ...base,
    role: declaredRole ?? text(raw.role) ?? base.role,
    ...(company ? { company } : {}),
    ...(city ? { city } : {}),
    ...(minYears !== undefined ? { minYears } : {}),
    degrees: degrees.length > 0 ? degrees : base.degrees,
    requirements,
    keywords: keywords.length > 0 ? keywords : base.keywords,
  };
}

/**
 * Ask the person's model to read a posting.
 *
 * The local analyzer always runs first: it gives the model result an id, the
 * original sections and a defensible fallback. If the model returns an empty
 * or unusable shape, the caller gets the local analysis instead.
 */
export async function analyzeJdWithUserModel(
  text: string,
  meta: { company?: string; role?: string } = {},
  config: ModelConfig,
): Promise<JdAnalysis> {
  const base = analyzeJd(text, meta);
  const raw = await callModel(
    config,
    JD_SYSTEM,
    `请分析下面的岗位描述，严格按给定 JSON 结构输出。${meta.role ? `\n\n用户填写的岗位名称：${meta.role}` : ""}\n\n岗位描述：\n${text.slice(0, 30_000)}`,
    4096,
  );
  return normalizeJd(jsonObject(raw), base, meta.role);
}

/* -------------------------------------------------------------------- test */

export async function testUserModel(
  config: ModelConfig,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const reply = await callModel(
      config,
      "你是一个连通性测试助手。",
      "请只回复两个字母：OK",
      16,
    );
    return reply.trim() ? { ok: true } : { ok: false, message: "模型没有返回内容。" };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "无法连接自定义模型。",
    };
  }
}
