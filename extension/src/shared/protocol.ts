/**
 * The message contract between the content script, the service worker and the
 * extension UI.
 *
 * Every message is a discriminated union with an explicit response type, so a
 * mistyped handler is a compile error rather than a silent no-op in production.
 */

import type {
  ApplicationRecord,
  ApplicationStage,
  Decision,
  DocumentRecord,
  FieldDescriptor,
  FillPlan,
  JdAnalysis,
  MemoryEntry,
  PageScan,
  Profile,
  Settings,
  TailorReport,
} from "@quill/core";

/* --------------------------------------------------------------- requests */

export interface ScanRequest {
  type: "scan";
  /** Re-read the page. */
}

export interface BuildPlanRequest {
  type: "build-plan";
  scan: PageScan;
  pageRole?: string;
  company?: string;
}

export interface ApplyPlanRequest {
  type: "apply-plan";
  plan: FillPlan;
  refs?: string[];
  includeReview?: boolean;
}

export interface ObserveRequest {
  type: "observe";
  /** The field the person just edited, re-scanned. */
  field: FieldDescriptor;
  value: string;
  proposedValues: string[];
}

export interface GetStateRequest {
  type: "get-state";
}

export interface SaveProfileRequest {
  type: "save-profile";
  profile: Profile;
}

export interface ImportDocumentRequest {
  type: "import-document";
  document: DocumentRecord;
}

export interface SaveMemoryRequest {
  type: "save-memory";
  entry: MemoryEntry;
}

export interface DeleteMemoryRequest {
  type: "delete-memory";
  id: string;
}

export interface SaveSettingsRequest {
  type: "save-settings";
  settings: Settings;
}

export interface AnalyzeJdRequest {
  type: "analyze-jd";
  text: string;
  meta?: { company?: string; role?: string; city?: string; jdDocumentId?: string };
}

export interface TailorRequest {
  type: "tailor";
  jdAnalysisId: string;
  options?: { role?: string; company?: string; maxBullets?: number };
}

export interface SaveRecordRequest {
  type: "save-record";
  record: ApplicationRecord;
}

export interface DeleteRecordRequest {
  type: "delete-record";
  id: string;
}

export interface RecordSubmissionRequest {
  type: "record-submission";
  plan: FillPlan;
  company: string;
  role: string;
  url: string;
}

export interface SetPositionRequest {
  type: "set-position";
  x: number;
  y: number;
}

/** Stop showing the panel automatically on one site. */
export interface HideSiteRequest {
  type: "hide-site" | "unhide-site";
  siteKey: string;
}

/** Open the workbench from the in-page panel. */
export interface OpenWorkbenchRequest {
  type: "open-workbench";
  /** Optionally deep-link into a section. */
  view?: string;
}

export type ExtensionRequest =
  | ScanRequest
  | BuildPlanRequest
  | ApplyPlanRequest
  | ObserveRequest
  | GetStateRequest
  | SaveProfileRequest
  | ImportDocumentRequest
  | SaveMemoryRequest
  | DeleteMemoryRequest
  | SaveSettingsRequest
  | AnalyzeJdRequest
  | TailorRequest
  | SaveRecordRequest
  | DeleteRecordRequest
  | RecordSubmissionRequest
  | SetPositionRequest
  | HideSiteRequest
  | OpenWorkbenchRequest;

/* -------------------------------------------------------------- responses */

/** The whole persisted state, as the UI needs it. */
export interface ExtensionState {
  profile?: Profile;
  documents: DocumentRecord[];
  memory: MemoryEntry[];
  analyses: JdAnalysis[];
  reports: TailorReport[];
  records: ApplicationRecord[];
  settings: Settings;
}

export interface FillReport {
  filled: number;
  failed: number;
  skipped: number;
  outcomes: Array<{ ref: string; ok: boolean; label: string; actual?: string; reason?: string }>;
}

export type ExtensionResponse =
  | { ok: true; type: "scan"; scan: PageScan }
  | { ok: true; type: "build-plan"; plan: FillPlan }
  | { ok: true; type: "apply-plan"; report: FillReport }
  | { ok: true; type: "observe"; learned: boolean; reason: string }
  | { ok: true; type: "get-state"; state: ExtensionState }
  | { ok: true; type: "save-profile"; profile: Profile }
  | { ok: true; type: "import-document"; state: ExtensionState }
  | { ok: true; type: "save-memory"; state: ExtensionState }
  | { ok: true; type: "delete-memory"; state: ExtensionState }
  | { ok: true; type: "save-settings"; settings: Settings }
  | { ok: true; type: "analyze-jd"; analysis: JdAnalysis }
  | { ok: true; type: "tailor"; report: TailorReport }
  | { ok: true; type: "save-record"; records: ApplicationRecord[] }
  | { ok: true; type: "delete-record"; records: ApplicationRecord[] }
  | { ok: true; type: "record-submission"; record: ApplicationRecord }
  | { ok: true; type: "set-position"; }
  | { ok: true; type: "hide-site" | "unhide-site"; hiddenSites: string[] }
  | { ok: true; type: "open-workbench"; }
  | { ok: false; error: string };

/**
 * Broadcast when the background changes state, so an open workbench reflects
 * a fill that happened in another tab.
 */
export interface StateChangedEvent {
  type: "state-changed";
  state: ExtensionState;
}

/** Broadcast when the content script learns something new. */
export interface LearnedEvent {
  type: "learned";
  label: string;
  value: string;
  key: string;
}

export type ExtensionEvent = StateChangedEvent | LearnedEvent;

export function isExtensionRequest(value: unknown): value is ExtensionRequest {
  return typeof value === "object" && value !== null && "type" in value;
}

/** Stage labels for the ledger UI, kept here so the popup can render them. */
export const STAGE_ORDER: ApplicationStage[] = [
  "draft",
  "submitted",
  "screening",
  "assessment",
  "interview-1",
  "interview-2",
  "interview-3",
  "offer",
  "rejected",
  "withdrawn",
];

export type { Decision };
