/**
 * The application ledger.
 *
 * Pure functions over the record list so the storage layer stays dumb. The
 * workbench renders whatever these produce, which keeps "what stage is this
 * application at" testable without a browser.
 */

import type {
  ApplicationRecord,
  ApplicationStage,
  DocumentRecord,
  JdAnalysis,
  Profile,
  Settings,
  TailorReport,
} from "../types.js";
import { STAGE_LABELS } from "../types.js";
import { unique } from "../text.js";

export { STAGE_LABELS };

/** Stage order for grouping and progress rendering. */
export const STAGE_SEQUENCE: ApplicationStage[] = [
  "draft",
  "submitted",
  "screening",
  "assessment",
  "interview-1",
  "interview-2",
  "interview-3",
  "offer",
];

/** Stages that mean the process has ended. */
export const CLOSED_STAGES: ApplicationStage[] = ["rejected", "withdrawn"];

export function isClosed(stage: ApplicationStage): boolean {
  return CLOSED_STAGES.includes(stage);
}

export function isActive(stage: ApplicationStage): boolean {
  return !isClosed(stage) && stage !== "draft";
}

/** How far along the process is, 0-1, for a progress indicator. */
export function stageProgress(stage: ApplicationStage): number {
  if (stage === "rejected" || stage === "withdrawn") return 1;
  const index = STAGE_SEQUENCE.indexOf(stage);
  if (index < 0) return 0;
  return (index + 1) / STAGE_SEQUENCE.length;
}

/* ---------------------------------------------------------------- creating */

export function createRecord(input: {
  company: string;
  role: string;
  city?: string;
  salary?: string;
  url?: string;
  source?: string;
  resumeDocumentId?: string;
  stage?: ApplicationStage;
  submittedFields?: Array<{ label: string; value: string }>;
  at?: number;
}): ApplicationRecord {
  const at = input.at ?? Date.now();
  const stage = input.stage ?? "submitted";
  return {
    id: `app-${at.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    company: input.company,
    role: input.role,
    ...(input.city ? { city: input.city } : {}),
    ...(input.salary ? { salary: input.salary } : {}),
    ...(input.url ? { url: input.url } : {}),
    ...(input.source ? { source: input.source } : {}),
    ...(input.resumeDocumentId ? { resumeDocumentId: input.resumeDocumentId } : {}),
    ...(input.submittedFields ? { submittedFields: input.submittedFields } : {}),
    stage,
    ...(stage === "draft" ? {} : { appliedAt: at }),
    createdAt: at,
    updatedAt: at,
    timeline: [{ at, note: `创建记录（${STAGE_LABELS[stage]}）` }],
  };
}

/* ---------------------------------------------------------------- updating */

export function advanceStage(
  record: ApplicationRecord,
  stage: ApplicationStage,
  note?: string,
  at = Date.now(),
): ApplicationRecord {
  if (record.stage === stage) return record;
  return {
    ...record,
    stage,
    updatedAt: at,
    appliedAt: record.appliedAt ?? (stage === "draft" ? undefined : at),
    timeline: [...record.timeline, { at, note: note ?? `阶段变更为${STAGE_LABELS[stage]}` }],
  };
}

export function addNote(record: ApplicationRecord, note: string, at = Date.now()): ApplicationRecord {
  return {
    ...record,
    updatedAt: at,
    timeline: [...record.timeline, { at, note }],
  };
}

export function setNextAction(
  record: ApplicationRecord,
  what: string,
  dueAt?: number,
  at = Date.now(),
): ApplicationRecord {
  return {
    ...record,
    updatedAt: at,
    nextAction: dueAt ? { what, dueAt } : { what },
    timeline: [...record.timeline, { at, note: `下一次行动：${what}` }],
  };
}

/* ------------------------------------------------------------------ query */

export interface LedgerStats {
  total: number;
  active: number;
  byStage: Record<string, number>;
  /** Interviews scheduled but not yet past. */
  upcoming: number;
  /** Applications with no activity for 14 days and no closed stage. */
  stale: ApplicationRecord[];
  /** Applications whose next action is due within 3 days (or overdue). */
  dueSoon: ApplicationRecord[];
  /** Response rate: submissions that progressed past screening. */
  responseRate: number;
}

const STALE_MS = 14 * 24 * 60 * 60 * 1000;
const DUE_SOON_MS = 3 * 24 * 60 * 60 * 1000;

export function ledgerStats(records: ApplicationRecord[], now = Date.now()): LedgerStats {
  const byStage: Record<string, number> = {};
  for (const stage of Object.keys(STAGE_LABELS)) byStage[stage] = 0;
  for (const record of records) byStage[record.stage] = (byStage[record.stage] ?? 0) + 1;

  const submitted = records.filter((record) => record.appliedAt !== undefined).length;
  const progressed = records.filter(
    (record) =>
      STAGE_SEQUENCE.indexOf(record.stage) >= STAGE_SEQUENCE.indexOf("screening") ||
      isClosed(record.stage),
  ).length;

  return {
    total: records.length,
    active: records.filter((record) => isActive(record.stage)).length,
    byStage,
    upcoming: records.filter(
      (record) => record.stage.startsWith("interview") && !isClosed(record.stage),
    ).length,
    stale: records.filter(
      (record) => isActive(record.stage) && now - record.updatedAt > STALE_MS,
    ),
    dueSoon: records.filter(
      (record) =>
        record.nextAction?.dueAt !== undefined &&
        record.nextAction.dueAt - now < DUE_SOON_MS &&
        !isClosed(record.stage),
    ),
    responseRate: submitted === 0 ? 0 : progressed / submitted,
  };
}

export type LedgerSort = "recent" | "company" | "stage" | "urgency";

export function sortRecords(records: ApplicationRecord[], sort: LedgerSort): ApplicationRecord[] {
  const copy = [...records];
  switch (sort) {
    case "company":
      return copy.sort((a, b) => a.company.localeCompare(b.company, "zh-Hans-CN"));
    case "stage":
      return copy.sort(
        (a, b) =>
          STAGE_SEQUENCE.indexOf(b.stage) - STAGE_SEQUENCE.indexOf(a.stage) ||
          b.updatedAt - a.updatedAt,
      );
    case "urgency": {
      const urgency = (record: ApplicationRecord) => {
        if (isClosed(record.stage)) return Number.POSITIVE_INFINITY;
        if (record.nextAction?.dueAt) return record.nextAction.dueAt;
        return Number.MAX_SAFE_INTEGER - record.updatedAt;
      };
      return copy.sort((a, b) => urgency(a) - urgency(b));
    }
    case "recent":
    default:
      return copy.sort((a, b) => b.updatedAt - a.updatedAt);
  }
}

export function filterRecords(
  records: ApplicationRecord[],
  query: string,
  stages?: ApplicationStage[],
): ApplicationRecord[] {
  const needle = query.trim().toLowerCase();
  return records.filter((record) => {
    if (stages && stages.length > 0 && !stages.includes(record.stage)) return false;
    if (!needle) return true;
    // Include the timeline: notes the person added while the process was
    // running ("面试官问了分布式") are exactly what they will search for later.
    return [
      record.company,
      record.role,
      record.city ?? "",
      record.notes ?? "",
      record.source ?? "",
      record.nextAction?.what ?? "",
      ...record.timeline.map((entry) => entry.note),
    ]
      .join(" ")
      .toLowerCase()
      .includes(needle);
  });
}

/* ---------------------------------------------------------------- insights */

/**
 * Patterns worth telling the person about. Deliberately few and factual — a
 * dashboard that congratulates you is noise.
 */
export interface Insight {
  kind: "warning" | "info" | "success";
  title: string;
  detail: string;
}

export function ledgerInsights(records: ApplicationRecord[], now = Date.now()): Insight[] {
  const insights: Insight[] = [];
  if (records.length === 0) return insights;

  const stats = ledgerStats(records, now);

  if (stats.stale.length > 0) {
    const names = unique(stats.stale.map((record) => record.company)).slice(0, 3);
    insights.push({
      kind: "warning",
      title: `${stats.stale.length} 个投递超过 14 天没有更新`,
      detail: `${names.join("、")}${stats.stale.length > 3 ? " 等" : ""}。可以礼貌地跟进一次，或标记为已结束。`,
    });
  }

  if (stats.dueSoon.length > 0) {
    insights.push({
      kind: "warning",
      title: `${stats.dueSoon.length} 项待办临近`,
      detail: unique(stats.dueSoon.map((record) => record.nextAction?.what ?? "")).filter(Boolean).join("；"),
    });
  }

  // Interview-heavy weeks are worth flagging early.
  const interviews = records.filter((record) => record.stage.startsWith("interview"));
  if (interviews.length >= 2) {
    insights.push({
      kind: "info",
      title: `${interviews.length} 个投递进入面试阶段`,
      detail: "建议把每一轮的岗位要求与提交内容整理出来，作为面试准备材料。",
    });
  }

  // Rejection concentration: if most applications stop at screening, the
  // resume is the bottleneck, not the volume.
  const submitted = records.filter((record) => record.appliedAt !== undefined);
  if (submitted.length >= 8) {
    const stoppedAtScreening = submitted.filter(
      (record) => record.stage === "screening" || record.stage === "rejected",
    ).length;
    if (stoppedAtScreening / submitted.length > 0.8) {
      insights.push({
        kind: "info",
        title: "多数投递停留在筛选阶段",
        detail: "与其继续增加投递数量，不如先针对目标岗位重做一版简历。",
      });
    }
  }

  if (stats.responseRate >= 0.3 && submitted.length >= 5) {
    insights.push({
      kind: "success",
      title: `回复率 ${Math.round(stats.responseRate * 100)}%`,
      detail: "当前简历与岗位的匹配度不错，可以保持这个方向。",
    });
  }

  return insights;
}

/* -------------------------------------------------------------- deadlines */

export function upcomingDeadlines(
  records: ApplicationRecord[],
  days = 7,
  now = Date.now(),
): ApplicationRecord[] {
  const horizon = now + days * 24 * 60 * 60 * 1000;
  return records
    .filter(
      (record) =>
        record.nextAction?.dueAt !== undefined &&
        record.nextAction.dueAt <= horizon &&
        !isClosed(record.stage),
    )
    .sort((a, b) => (a.nextAction?.dueAt ?? 0) - (b.nextAction?.dueAt ?? 0));
}

/* ------------------------------------------------------------------ export */

/** CSV suitable for Excel without a BOM round-trip. */
export function ledgerToCsv(records: ApplicationRecord[]): string {
  const header = ["公司", "岗位", "城市", "阶段", "投递日期", "最近更新", "下一次行动", "链接", "备注"];
  const rows = sortRecords(records, "recent").map((record) => [
    record.company,
    record.role,
    record.city ?? "",
    STAGE_LABELS[record.stage],
    record.appliedAt ? formatDate(record.appliedAt) : "",
    formatDate(record.updatedAt),
    record.nextAction?.dueAt
      ? `${record.nextAction.what}（${formatDate(record.nextAction.dueAt)}）`
      : record.nextAction?.what ?? "",
    record.url ?? "",
    record.notes ?? "",
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

function csvCell(value: string): string {
  const text = String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function formatDate(at: number): string {
  const date = new Date(at);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatRelative(at: number, now = Date.now()): string {
  const diff = now - at;
  const day = 24 * 60 * 60 * 1000;
  if (diff < 60_000) return "刚刚";
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  return formatDate(at);
}

/** Days remaining until a deadline, negative when overdue. */
export function daysUntil(at: number, now = Date.now()): number {
  return Math.ceil((at - now) / (24 * 60 * 60 * 1000));
}

/* ------------------------------------------------------------ cross-links */

export interface WorkbenchSnapshot {
  profile?: Profile;
  documents: DocumentRecord[];
  analyses: JdAnalysis[];
  reports: TailorReport[];
  records: ApplicationRecord[];
  settings: Settings;
  memoryCount: number;
}

/**
 * The "what should I do next" list, used on the workbench home. Ordered by
 * how blocking each item is.
 */
export function nextSteps(snapshot: WorkbenchSnapshot): Array<{ title: string; detail: string; action: string }> {
  const steps: Array<{ title: string; detail: string; action: string }> = [];

  if (!snapshot.profile || !snapshot.profile.identity.fullName) {
    steps.push({
      title: "上传简历",
      detail: "导入一份简历后，扩展才能在网申页面自动识别并填写字段。",
      action: "upload-resume",
    });
    return steps;
  }

  const missingContact = !snapshot.profile.contact.email || !snapshot.profile.contact.phone;
  if (missingContact) {
    steps.push({
      title: "补全联系方式",
      detail: "简历中未识别到邮箱或手机号，请在工作台补全。",
      action: "edit-profile",
    });
  }

  if (snapshot.analyses.length === 0) {
    steps.push({
      title: "粘贴一份岗位描述",
      detail: "有了目标岗位，才能针对它调整简历、生成求职信。",
      action: "new-analysis",
    });
  } else if (snapshot.reports.length === 0) {
    steps.push({
      title: "生成针对性简历建议",
      detail: "已解析岗位要求，可以生成一版按岗位重排的简历建议。",
      action: "tailor",
    });
  }

  const drafts = snapshot.records.filter((record) => record.stage === "draft");
  if (drafts.length > 0) {
    steps.push({
      title: `${drafts.length} 个投递还是草稿`,
      detail: "这些记录尚未标记为已投递。",
      action: "ledger",
    });
  }

  if (snapshot.memoryCount > 0 && !snapshot.settings.confirmLearned) {
    steps.push({
      title: `复习 ${snapshot.memoryCount} 条记忆`,
      detail: "扩展自动记录了你在表单中的手填内容，可以核对或删除。",
      action: "memory",
    });
  }

  const deadlines = upcomingDeadlines(snapshot.records);
  if (deadlines.length > 0) {
    const first = deadlines[0];
    steps.push({
      title: `临近的待办：${first?.nextAction?.what ?? ""}`,
      detail: `${first?.company ?? ""} ${first?.role ?? ""}`,
      action: "ledger",
    });
  }

  return steps;
}
