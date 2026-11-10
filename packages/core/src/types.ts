/**
 * Domain model for Quill.
 *
 * The vocabulary is deliberately small and stable: a *profile* describes the
 * person, a *field* describes a widget on someone else's page, a *decision*
 * connects the two with evidence, and a *memory entry* is what the person
 * taught us by hand.
 */

/* ------------------------------------------------------------------ value */

export type Primitive = string | number | boolean;

/** A single value we can place into a widget. */
export interface FieldValue {
  /** Canonical, human-readable text as it should appear in the field. */
  text: string;
  /** Machine value for selects/radios (the option's `value`), when different. */
  raw?: string;
  /** ISO-8601 for dates (`2024-09-01`) so widgets can consume it directly. */
  iso?: string;
  /** For multi-selects and checkbox groups. */
  multiple?: string[];
}

/* -------------------------------------------------------------------- dates */

/** `2024-09` (month precision) or `2024-09-01` (day precision). */
export type PartialDate = string;

export interface DateRange {
  start?: PartialDate;
  end?: PartialDate;
  /** True when the person is still there ("至今"). */
  current?: boolean;
}

/* ------------------------------------------------------------------ profile */

export interface Identity {
  fullName?: string;
  /** 曾用名 */
  formerName?: string;
  /** 姓名拼音 / 罗马字，用于英文表单 */
  namePinyin?: string;
  /** 英文名，外企表单常用 */
  englishName?: string;
  gender?: string;
  /** 民族 */
  ethnicity?: string;
  birthDate?: PartialDate;
  /** 出生地，与籍贯不同 */
  birthPlace?: string;
  /** 政治面貌 */
  politicalStatus?: string;
  maritalStatus?: string;
  /** 籍贯 */
  nativePlace?: string;
  /** 户口所在地 */
  household?: string;
  nationality?: string;
  idType?: string;
  idNumber?: string;
  /** 身高 / 体重 / 视力 — common on Chinese state-owned enterprise forms. */
  height?: string;
  weight?: string;
  vision?: string;
  bloodType?: string;
  healthStatus?: string;
  /** 是否有亲属在本单位 */
  relativesInCompany?: string;
}

export interface Contact {
  phone?: string;
  /** 紧急联系电话 */
  alternatePhone?: string;
  email?: string;
  wechat?: string;
  qq?: string;
  /** 现居住地 */
  currentCity?: string;
  /** 通讯地址 */
  address?: string;
  postalCode?: string;
  homepage?: string;
  github?: string;
  linkedin?: string;
  /** 紧急联系人 */
  emergencyContactName?: string;
  emergencyContactPhone?: string;
  emergencyContactRelation?: string;
}

export interface Education {
  id: string;
  school?: string;
  /** 院系，与学校不同层级 */
  college?: string;
  major?: string;
  /** 学历：本科 / 硕士 / 博士 / 大专 */
  degree?: string;
  /** 学位：学士 / 硕士 / 博士 */
  academicDegree?: string;
  dates?: DateRange;
  /** 学制 */
  duration?: string;
  /** 绩点。可能带满分，如 "4.0/5.0"，表单要求分栏时由 resolve 拆分。 */
  gpa?: string;
  /** 满绩绩点，如 "5.0"（部分 ATS 把 GPA 与 GPA-BASE 分成两个框） */
  gpaBase?: string;
  /** 专业排名，如 "3/120" */
  rank?: string;
  /** 是否统招 / 全日制 */
  studyMode?: string;
  city?: string;
  /** 主修课程 */
  courses?: string;
  honors?: string[];
  /** 语言与等级，如 "英语 CET-6 585" */
  languages?: string[];
  /** 是否海外经历 */
  overseas?: boolean;
}

export type HiringTrack = "internship" | "campus" | "experienced" | "unknown";

/** The category a repeatable experience section explicitly asks for, when known. */
export type ExperienceKind = "internship" | "employment";

export interface Experience {
  id: string;
  company?: string;
  /** 部门 */
  department?: string;
  title?: string;
  /** 职位类别：实习 / 全职 / 兼职 */
  employmentType?: string;
  city?: string;
  dates?: DateRange;
  /** 薪资（离职前月薪 / 期望） */
  salary?: string;
  /** 汇报对象 */
  reportsTo?: string;
  /** 下属人数 */
  teamSize?: string;
  /** 工作职责与成果，逐条 */
  highlights: string[];
  /** 掌握的技术 / 工具 */
  stack?: string[];
  /** 离职原因 */
  leaveReason?: string;
  /** 证明人 */
  refereeName?: string;
  refereeTitle?: string;
  refereePhone?: string;
  /** 与证明人的关系 */
  refereeRelation?: string;
}

/**
 * What kind of project this is.
 *
 * Application forms that ask for a project type usually offer a closed list.
 * Training/course projects are intentionally not a category of their own: they
 * add little on a resume, while research, open source and personal work are
 * the distinctions a recruiter actually reads for.
 */
export type ProjectCategory = "research" | "opensource" | "personal" | "other";

export const PROJECT_CATEGORIES: ProjectCategory[] = [
  "research",
  "opensource",
  "personal",
  "other",
];

export const PROJECT_CATEGORY_LABELS: Record<ProjectCategory, string> = {
  research: "科研项目",
  opensource: "开源项目",
  personal: "个人作品",
  other: "其他",
};

/** Accept the labels models and forms use, and collapse them to one value. */
export function normalizeProjectCategory(value: unknown): ProjectCategory | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim().toLowerCase();
  if (!text) return undefined;
  if (/科研|研究|学术|课题|论文|research|academic/.test(text)) return "research";
  if (/开源|open.?source|github|gitee|gitlab/.test(text)) return "opensource";
  if (/个人作品|个人项目|作品集|个人开发|portfolio|personal|side.?project/.test(text)) {
    return "personal";
  }
  if (/其他|其它|other|课程|实训|竞赛|比赛|training|course/.test(text)) return "other";
  return undefined;
}

export interface Project {
  id: string;
  name?: string;
  /** 科研 / 开源 / 个人作品 */
  category?: ProjectCategory;
  role?: string;
  dates?: DateRange;
  /** 项目背景 / 目标 */
  summary?: string;
  highlights: string[];
  stack?: string[];
  link?: string;
}

export interface Skill {
  /** 专业技能 / 工具 */
  items: string[];
  /** 证书 */
  certificates: string[];
  /** 奖项 */
  awards: string[];
  /** 兴趣特长 */
  interests: string[];
}

export interface JobPreference {
  /** 意向岗位 */
  position?: string;
  /** 意向城市，按优先级 */
  cities: string[];
  /** 期望薪资 */
  salary?: string;
  /** 到岗时间 */
  availableFrom?: string;
  /** 求职类型（全职 / 实习等），网申字段的值 */
  jobType?: string;
  /**
   * 这份简历主要投递的招聘类型。
   *
   * 页面自身能识别实习/校招/社招时以页面为准；页面没有明确类型时，用它决定
   * 优先读取哪一类经历。未设置表示不按类型过滤。
   */
  targetTrack?: Exclude<HiringTrack, "unknown">;
  /** 是否接受调剂 / 出差 / 加班 */
  relocation?: string;
  travel?: string;
  overtime?: string;
  /** 期望行业 */
  industries: string[];
  /** 获取渠道 */
  sourceChannel?: string;
}

/** Long-form answers. Kept separate because they are composed, not copied. */
export interface Essays {
  selfIntro?: string;
  whyCompany?: string;
  whyRole?: string;
  strengths?: string;
  weakness?: string;
  careerPlan?: string;
  achievement?: string;
  hobby?: string;
  /** 你还有哪些补充 */
  additional?: string;
  /** Anything the person wrote verbatim that we could not classify. */
  unclassified: Record<string, string>;
}

export interface Profile {
  id: string;
  /** Which uploaded document this profile was derived from, if any. */
  sourceDocumentId?: string;
  updatedAt: number;
  identity: Identity;
  contact: Contact;
  education: Education[];
  experience: Experience[];
  projects: Project[];
  skills: Skill;
  preference: JobPreference;
  essays: Essays;
  /** Verbatim text of the source document, for evidence quoting. */
  rawText?: string;
  /** Latest parser warnings to review alongside manually checked fields. */
  parseWarnings?: string[];
}

export function emptyProfile(id = "profile-1"): Profile {
  return {
    id,
    updatedAt: Date.now(),
    identity: {},
    contact: {},
    education: [],
    experience: [],
    projects: [],
    skills: { items: [], certificates: [], awards: [], interests: [] },
    preference: { cities: [], industries: [] },
    essays: { unclassified: {} },
  };
}

/**
 * A named direction ("后端开发", "产品经理", "海外岗位") with its own copy of
 * the profile.
 *
 * Directions are separate dossiers rather than a tag on one profile because the
 * differences are not only in 求职意向: the same person will foreground
 * different projects, rewrite the self-introduction, and list different skills
 * for each direction. Editing one must not silently change what gets submitted
 * for another. Each dossier stores its own independently uploaded resume.
 */
export interface ProfileDossier {
  id: string;
  name: string;
  profile: Profile;
  createdAt: number;
  updatedAt: number;
}

/**
 * What the UI needs to render the direction switcher without transferring every
 * dossier's full text (which includes the resume verbatim).
 */
export interface ProfileSummary {
  id: string;
  name: string;
  updatedAt: number;
  /** 求职意向岗位, when the dossier has one. */
  position?: string;
  educationCount: number;
  experienceCount: number;
  projectCount: number;
}

/* -------------------------------------------------------------------- field */

export type FieldKind =
  | "text"
  | "email"
  | "tel"
  | "url"
  | "number"
  | "date"
  | "textarea"
  | "select"
  | "combobox"
  | "radio-group"
  | "checkbox-group"
  | "checkbox"
  | "file"
  | "contenteditable"
  | "unknown";

export type LabelSource =
  | "label-for"
  | "aria-label"
  | "aria-labelledby"
  | "wrapper"
  | "table-header"
  | "preceding"
  | "placeholder"
  | "name-attribute"
  | "title-attribute"
  | "section-heading"
  | "none";

export type FieldSection =
  | "identity"
  | "contact"
  | "education"
  | "experience"
  | "project"
  | "skill"
  | "preference"
  | "essay"
  | "meta"
  | "unknown";

export interface FieldOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/** Everything we know about one widget, without holding a DOM reference. */
export interface FieldDescriptor {
  /**
   * Stable identity across re-scans of the same page. Built from the element's
   * DOM path plus a fingerprint of its attributes, so it survives re-renders
   * that keep the same structure but change node identity.
   */
  ref: string;
  kind: FieldKind;
  /** Best label we could recover. */
  label: string;
  /** Where that label came from — drives how much we trust it. */
  labelSource: LabelSource;
  /** Secondary text nearby (hints, helper text, group legends). */
  hint?: string;
  name?: string;
  id?: string;
  placeholder?: string;
  /** The HTML `autocomplete` token, when the author provided one. */
  autocomplete?: string;
  title?: string;
  required: boolean;
  disabled: boolean;
  readOnly: boolean;
  /** 1-based index among sibling repeats (2nd education row, etc.). */
  repeatIndex?: number;
  maxLength?: number;
  pattern?: string;
  inputType?: string;
  options?: FieldOption[];
  /**
   * The control accepts several choices from `options`.
   *
   * A custom multi-select often hides behind a plain read-only `<input>` with a
   * tag list beside it, so the element's own tag says "text" while the widget
   * is really a multi-value picker. Without this flag the resolver matches the
   * whole list against one option and, finding several equally good candidates,
   * gives up.
   */
  multiple?: boolean;
  section: FieldSection;
  /** Nearest heading text, for context and grouping. */
  groupHeading?: string;
  /** Explicitly identified experience section type, when its heading says so. */
  experienceKind?: ExperienceKind;
  /** Detected widget library, used to pick the right fill technique. */
  framework?: WidgetFramework;
  /** Canonical key from the classifier, e.g. `contact.phone`. */
  key?: string;
  keyConfidence?: number;
  /** 0-100 confidence that this field should have a value. */
  importance?: number;
}

export type WidgetFramework =
  | "native"
  | "react-select"
  | "antd"
  | "element-ui"
  | "select2"
  | "vant"
  | "arco"
  | "semi"
  | "workday"
  | "taleo";

/** The scan result for one page. */
export interface PageScan {
  url: string;
  origin: string;
  title: string;
  /** Site-level signature, e.g. `careers.tencent.com`. */
  siteKey: string;
  scannedAt: number;
  fields: FieldDescriptor[];
  /** Detected application system, if we recognise it. */
  ats?: string;
  /** Hiring track inferred from page title, route and prominent page text. */
  hiringTrack?: HiringTrack;
  /** Job posting text extracted from the visible page, without form values. */
  jobContext?: string;
  /** Progress indicator text the page itself shows, when present. */
  pageProgress?: string;
  /**
   * What the page expects in its education section.
   *
   * `current-only` — a single “当前教育经历 / 最高学历” block (Tencent). Fill the
   * highest/current record and do not open older rows.
   * `full-history` — a repeatable “教育经历” section that expects every degree.
   * `unknown` — no clear wording; fill the rows the page already shows.
   */
  educationPolicy?: "current-only" | "full-history" | "unknown";
}

/* ----------------------------------------------------------------- evidence */

export type EvidenceSource =
  | "resume"
  | "profile"
  | "memory"
  | "site-memory"
  | "derived"
  | "composed"
  | "default"
  | "none";

export interface Evidence {
  source: EvidenceSource;
  /** Human-readable where-it-came-from line, shown in the review panel. */
  detail: string;
  /** The exact snippet from the resume that supports the value, if any. */
  quote?: string;
}

/* ---------------------------------------------------------------- decisions */

export type DecisionStatus =
  | "ready" /* confident, safe to apply */
  | "review" /* value exists but is inferred — ask before applying */
  | "choice" /* several plausible values — the person must pick */
  | "missing"; /* nothing to go on */

export interface Decision {
  ref: string;
  key: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  status: DecisionStatus;
  /** Proposed value; absent for `missing` and `choice`. */
  value?: FieldValue;
  /** Candidates for `choice` status. */
  candidates?: Array<{ value: FieldValue; evidence: Evidence }>;
  /** 0-1. */
  confidence: number;
  evidence: Evidence;
  /** Why the engine chose this — one short sentence, shown in the panel. */
  rationale: string;
  /** Warnings the person should see before applying (e.g. long answer). */
  caution?: string;
}

export interface FillPlan {
  url: string;
  siteKey: string;
  createdAt: number;
  decisions: Decision[];
  /** Counts for the summary strip in the overlay. */
  tally: Record<DecisionStatus, number>;
  /** Site-specific notes (e.g. "this ATS paginates education rows"). */
  notes: string[];
}

/* ------------------------------------------------------------------ memory */

export type MemoryOrigin = "learned" | "confirmed" | "imported";

export interface MemoryEntry {
  id: string;
  /** Canonical key this answer belongs to. */
  key: string;
  /** The label we saw when we learned it — survives key changes. */
  labelSnapshot: string;
  value: string;
  origin: MemoryOrigin;
  /** Domain it was learned on, when it is site-specific. */
  siteKey?: string;
  /** How many times we have seen the same answer. */
  hits: number;
  createdAt: number;
  updatedAt: number;
  /** True once the person reviewed it in the library. */
  reviewed: boolean;
}

/* ------------------------------------------------------------------ ledger */

export type ApplicationStage =
  | "draft"
  | "submitted"
  | "screening"
  | "assessment"
  | "interview-1"
  | "interview-2"
  | "interview-3"
  | "offer"
  | "rejected"
  | "withdrawn";

export interface ApplicationRecord {
  id: string;
  company: string;
  role: string;
  city?: string;
  salary?: string;
  /** Where the posting lives. */
  url?: string;
  source?: string;
  stage: ApplicationStage;
  /** When the person pressed submit. */
  appliedAt?: number;
  createdAt: number;
  updatedAt: number;
  /** Free-form materials the person attached. */
  resumeDocumentId?: string;
  /** Snapshot of what we submitted, for recall before an interview. */
  submittedFields?: Array<{ label: string; value: string }>;
  nextAction?: { what: string; dueAt?: number };
  timeline: Array<{ at: number; note: string }>;
  notes?: string;
}

export const STAGE_LABELS: Record<ApplicationStage, string> = {
  draft: "未提交",
  submitted: "已投递",
  screening: "筛选中",
  assessment: "测评",
  "interview-1": "一面",
  "interview-2": "二面",
  "interview-3": "终面",
  offer: "Offer",
  rejected: "未通过",
  withdrawn: "已撤回",
};

/* ---------------------------------------------------------------- documents */

export type DocumentKind = "resume" | "cover-letter" | "jd" | "other";

export interface DocumentRecord {
  id: string;
  kind: DocumentKind;
  fileName: string;
  mimeType: string;
  /** Extracted plain text. */
  text: string;
  /** Original file, kept so the person can re-parse or re-download. */
  bytes?: ArrayBuffer;
  parsedProfileId?: string;
  uploadedAt: number;
  /** Marked when the person edits the extracted text by hand. */
  editedAt?: number;
  /**
   * How this document's profile was produced.
   *
   * `model` means OCR and/or structured extraction ran on the recognition
   * server; `local` means only on-device rules were used. Older records have no
   * value, which is also treated as local.
   */
  extractionMethod?: "model" | "local";
}

/* ------------------------------------------------------------- tailoring */

export interface JdAnalysis {
  id: string;
  jdDocumentId?: string;
  company?: string;
  role: string;
  city?: string;
  seniority?: string;
  /** Requirements pulled out of the posting. */
  requirements: Array<{
    text: string;
    /** Skills/competencies this requirement implies. */
    keywords: string[];
    /** Weight 1-3, from phrasing ("必须" > "优先"). */
    weight: number;
    mustHave: boolean;
    /**
     * True for a behavioural expectation (沟通能力, 团队协作) rather than a
     * verifiable skill. Soft requirements cannot be proved from a resume, so
     * they are reported but never counted as blocking gaps.
     */
    soft?: boolean;
    /**
     * True when the keywords were derived from the sentence itself rather than
     * matched against the curated vocabulary. Derived keywords are alternative
     * phrasings of one idea ("支付与金融相关业务"), not a checklist of separate
     * technologies, so a single hit satisfies the whole requirement.
     */
    derivedKeywords?: boolean;
  }>;
  /**
   * A stated minimum number of years, kept separate from `requirements`
   * because it is verified against the dates in the profile rather than by
   * keyword matching.
   */
  minYears?: number;
  /** Degrees the posting requires. */
  degrees: string[];
  /** Terms that look like skills but are not in our dictionary. */
  keywords: string[];
  sections: Array<{ heading: string; body: string }>;
  createdAt: number;
}

export interface TailoredBullet {
  /** Rewritten bullet, ready to paste into a resume. */
  text: string;
  /** Original bullet it came from. */
  source?: string;
  /** JD keywords this bullet now answers. */
  answers: string[];
  /** Why the rewrite is defensible — what we did not change. */
  note: string;
}

export interface TailoredSection {
  heading: string;
  /** Which profile entity this came from. */
  entityId?: string;
  meta: string;
  bullets: TailoredBullet[];
}

export interface GapItem {
  requirement: string;
  mustHave: boolean;
  /** What we found in the profile, if anything. */
  closest: string;
  /** `matched` | `partial` | `gap` */
  verdict: "matched" | "partial" | "gap";
  suggestion: string;
}

export interface TailorReport {
  id: string;
  jdAnalysisId: string;
  profileId: string;
  /** Direction dossier id, when the report was built from an auto-matched resume. */
  dossierId?: string;
  /** Direction name shown alongside the report, so its source is auditable. */
  dossierName?: string;
  createdAt: number;
  /** The one-line positioning statement. */
  headline: string;
  summary: string;
  sections: TailoredSection[];
  gaps: GapItem[];
  /** Keyword coverage, 0-1. */
  coverage: number;
  coverLetter: string;
  interviewPrompts: string[];
  /** Honest note about how this was produced. */
  method: "engine" | "model";
}

/* ------------------------------------------------------------------ settings */

export interface Settings {
  appearance: "system" | "light" | "dark";
  /** Show the floating panel on every job-application page. */
  autoScan: boolean;
  /** Apply only high-confidence decisions without asking. */
  autoApplyConfident: boolean;
  /** Watch for hand-typed answers and remember them. */
  learnFromUserInput: boolean;
  /** Ask before remembering. */
  confirmLearned: boolean;
  /** Never overwrite a field that already has content. */
  preserveExisting: boolean;
  /** Highlight filled fields so the person can audit quickly. */
  highlightFilled: boolean;
  /** Compose long-form answers from resume material. */
  composeEssays: boolean;
  /** Server-side OCR and structured resume extraction. */
  resumeModel: ResumeModelSettings;
  /**
   * The person's own OpenAI- or Anthropic-compatible endpoint.
   *
   * Used in the browser for text-only resume structure extraction and job
   * analysis. The key never goes to Quill's recognition server.
   */
  model?: ModelConfig;
  /** Whether the first-run setup has been completed or explicitly skipped. */
  setupCompleted?: boolean;
  /** Which path the person chose in the first-run setup. */
  setupMode?: "quill" | "custom" | "local";
}

/**
 * Recognition-server settings.
 *
 * The server holds the platform key; the browser never sees it. `consentShown`
 * records that the person accepted the upload notice once. Until it is true,
 * every import stops and asks before sending anything.
 */
export interface ResumeModelSettings {
  /**
   * Off by default in the public build: local rules work without any network.
   * Turning this on sends new resume text to the configured recognition server.
   */
  enabled: boolean;
  /** Recognition server root, no trailing slash. */
  baseUrl: string;
  /** Private-beta access code sent as `X-Quill-Beta`; empty when not needed. */
  betaCode?: string;
  /** The person has seen and accepted the upload notice at least once. */
  consentShown: boolean;
}

/**
 * Empty in the public build. Local rules need no server; people who choose the
 * hosted recognition service enter the address provided to them. During local
 * server development, set this to `http://127.0.0.1:8787`.
 */
export const DEFAULT_RESUME_MODEL_BASE_URL = "";

export type ModelProtocol = "openai" | "anthropic";

export interface ModelConfig {
  /** Which request/response shape the endpoint speaks. */
  protocol?: ModelProtocol;
  /** Base URL, normally ending at the provider's API root. */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 0-2 */
  temperature: number;
  /** Off by default: a partially filled config must never be used. */
  enabled?: boolean;
}

export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  protocol: "openai",
  baseUrl: "",
  apiKey: "",
  model: "",
  temperature: 0.2,
  enabled: false,
};

export const DEFAULT_SETTINGS: Settings = {
  appearance: "system",
  autoScan: true,
  autoApplyConfident: false,
  learnFromUserInput: true,
  confirmLearned: true,
  preserveExisting: true,
  highlightFilled: true,
  composeEssays: true,
  resumeModel: {
    enabled: false,
    baseUrl: DEFAULT_RESUME_MODEL_BASE_URL,
    betaCode: "",
    consentShown: false,
  },
  model: { ...DEFAULT_MODEL_CONFIG },
  setupCompleted: false,
};

/**
 * Deep-merge the two settings objects that have their own shape.
 *
 * Storage merges settings with a shallow spread, which would replace
 * `resumeModel` wholesale and turn old saved objects into missing fields. Every
 * load path goes through here instead.
 */
export function normalizeSettings(settings?: Partial<Settings>): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...(settings ?? {}),
    resumeModel: {
      ...DEFAULT_SETTINGS.resumeModel,
      ...(settings?.resumeModel ?? {}),
    },
    model: {
      ...DEFAULT_MODEL_CONFIG,
      ...(settings?.model ?? {}),
    },
  };
}

/** A complete custom-model configuration that is safe to call. */
export function customModelReady(model?: ModelConfig): boolean {
  return Boolean(
    model?.enabled &&
      model.baseUrl.trim().length > 0 &&
      model.apiKey.trim().length > 0 &&
      model.model.trim().length > 0,
  );
}

/* ------------------------------------------------------------------ helpers */

export function tallyDecisions(decisions: Decision[]): Record<DecisionStatus, number> {
  const tally: Record<DecisionStatus, number> = { ready: 0, review: 0, choice: 0, missing: 0 };
  for (const d of decisions) tally[d.status] += 1;
  return tally;
}

/** Keys we treat as long-form answers rather than short facts. */
export const ESSAY_KEYS = new Set([
  "essay.selfIntro",
  "essay.whyCompany",
  "essay.whyRole",
  "essay.strengths",
  "essay.weakness",
  "essay.careerPlan",
  "essay.achievement",
  "essay.hobby",
  "essay.additional",
  "work.description",
  "project.description",
  "skill.summary",
]);

export function isEssayKey(key: string): boolean {
  return ESSAY_KEYS.has(key) || key.startsWith("essay.");
}
