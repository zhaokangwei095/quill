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
  DiagnosticBundle,
  DiagnosticEvent,
  DiagnosticSnapshot,
  DocumentRecord,
  FieldDescriptor,
  ExperienceKind,
  FillPlan,
  HiringTrack,
  JdAnalysis,
  MemoryEntry,
  PageScan,
  Profile,
  ProfileDossier,
  ProfileSummary,
  ReparseMode,
  ReparsePreview,
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

export interface GetProfileDossiersRequest {
  type: "get-profile-dossiers";
}

export interface GetStateRequest {
  type: "get-state";
}

/**
 * A repeatable section on the page whose profile source is a structured array.
 *
 * Deliberately limited to education/experience/projects: those are the three
 * collections with one profile record per row. Awards and certificates are
 * flat strings, so an opened row would have nothing sensible to put in it.
 */
export type RepeatSectionKey = "education" | "experience" | "projects";

/** How many rows the page should have, according to the profile. */
export type SectionTargets = Record<RepeatSectionKey, number> & {
  /** All saved experience records, including those excluded by hiring type. */
  experienceTotal: number;
};

export interface SectionTargetsRequest {
  type: "section-targets";
  hiringTrack?: HiringTrack;
  experienceKind?: ExperienceKind;
  pageRole?: string;
  company?: string;
  jobContext?: string;
}

/* ---------------------------------------------------------- diagnostics */

export interface LogEventRequest {
  type: "log-event";
  event: DiagnosticEvent;
}

/** Replace the "last operation" snapshot used in a diagnostic bundle. */
export interface DiagnosticsSnapshotRequest {
  type: "diagnostics-snapshot";
  snapshot: DiagnosticSnapshot;
}

export interface DiagnosticsExportRequest {
  type: "diagnostics-export";
  /** The person's own account of what went wrong. */
  description?: string;
}

export interface DiagnosticsClearRequest {
  type: "diagnostics-clear";
}

/**
 * A notice for the panel: this empty section can be opened and filled.
 *
 * `desired` is the number of profile entries, already capped by the content
 * script. A `desired` of 0 means the page has the section but the profile has
 * nothing to put in it; the panel uses that to explain the gap instead of
 * silently ignoring it. The panel only renders these; it never clicks anything
 * itself.
 */
export interface SectionPlanItem {
  key: RepeatSectionKey;
  label: string;
  /** Total rows the profile justifies (capped). */
  desired: number;
  /** Rows the page already renders, blank or not. */
  existing: number;
  /** Rows “填写” would actually click “添加” for. */
  toAdd: number;
  /** No matching experience type exists, but other typed records do. */
  reason?: "experience-kind-mismatch";
}

export interface SaveProfileRequest {
  type: "save-profile";
  profile: Profile;
}

export interface ImportDocumentRequest {
  type: "import-document";
  document: Omit<DocumentRecord, "id" | "uploadedAt">;
  /**
   * Present when the workbench already built the profile from the recognition
   * server's draft. The worker then must not re-parse the text with local rules.
   */
  profile?: Profile;
}

/**
 * Re-run the current parser over the resume text already on this device.
 *
 * Parser fixes do not reach a profile that was parsed by an older build: the
 * stored profile is a snapshot, not a view. Re-parsing also overwrites manual
 * corrections, so the UI must call `preview-reparse` first and show the diff.
 *
 * `mode: "merge"` fills blanks and keeps every existing value; `"replace"`
 * uses the new parse wholesale. The worker stores a one-deep backup either way.
 */
export interface PreviewReparseRequest {
  type: "preview-reparse";
}

export interface ReparseResumeRequest {
  type: "reparse-resume";
  mode: ReparseMode;
}

/** Put back the profile as it was before the most recent re-parse. */
export interface UndoReparseRequest {
  type: "undo-reparse";
}

export interface CreateProfileRequest {
  type: "create-profile";
  name: string;
}

export interface SwitchProfileRequest {
  type: "switch-profile";
  id: string;
}

export interface RenameProfileRequest {
  type: "rename-profile";
  id: string;
  name: string;
}

export interface DeleteProfileRequest {
  type: "delete-profile";
  id: string;
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

/**
 * Persist an analysis the workbench produced with the person's own model.
 * The worker only stores it; it must not re-run the local analyzer.
 */
export interface SaveAnalysisResultRequest {
  type: "save-analysis-result";
  analysis: JdAnalysis;
}

export interface TailorRequest {
  type: "tailor";
  jdAnalysisId: string;
  /** Explicit dossier chosen by the workbench; otherwise match by job. */
  dossierId?: string;
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
  | GetProfileDossiersRequest
  | GetStateRequest
  | SectionTargetsRequest
  | LogEventRequest
  | DiagnosticsSnapshotRequest
  | DiagnosticsExportRequest
  | DiagnosticsClearRequest
  | SaveProfileRequest
  | ImportDocumentRequest
  | PreviewReparseRequest
  | ReparseResumeRequest
  | UndoReparseRequest
  | CreateProfileRequest
  | SwitchProfileRequest
  | RenameProfileRequest
  | DeleteProfileRequest
  | SaveMemoryRequest
  | DeleteMemoryRequest
  | SaveSettingsRequest
  | AnalyzeJdRequest
  | SaveAnalysisResultRequest
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
  /** The workbench's current editing profile; page filling may auto-match another dossier. */
  profile?: Profile;
  /** All directions, without their resume text. */
  profiles: ProfileSummary[];
  activeProfileId?: string;
  /** Present after a re-parse until “撤销” is used or another replaces it. */
  reparseBackup?: { at: number };
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
  /**
   * Sections that had to be opened before filling, e.g. “工作经历 1 行”.
   *
   * Reported separately from `filled` because clicking “添加” is a visible
   * change to the page the person did not make field by field; it should be
   * acknowledged rather than buried in the total.
   */
  prepared?: Array<{ label: string; rows: number }>;
}

export type ExtensionResponse =
  | { ok: true; type: "scan"; scan: PageScan }
  | { ok: true; type: "build-plan"; plan: FillPlan }
  | { ok: true; type: "apply-plan"; report: FillReport }
  | { ok: true; type: "observe"; learned: boolean; reason: string }
  | { ok: true; type: "get-profile-dossiers"; dossiers: ProfileDossier[] }
  | { ok: true; type: "get-state"; state: ExtensionState }
  | { ok: true; type: "section-targets"; targets: SectionTargets }
  | { ok: true; type: "log-event" }
  | { ok: true; type: "diagnostics-snapshot" }
  | { ok: true; type: "diagnostics-export"; bundle: DiagnosticBundle }
  | { ok: true; type: "diagnostics-clear" }
  | { ok: true; type: "save-profile"; profile: Profile }
  | { ok: true; type: "import-document"; state: ExtensionState }
  | { ok: true; type: "preview-reparse"; preview: ReparsePreview }
  | { ok: true; type: "reparse-resume"; state: ExtensionState }
  | { ok: true; type: "undo-reparse"; state: ExtensionState }
  | { ok: true; type: "create-profile"; state: ExtensionState }
  | { ok: true; type: "switch-profile"; state: ExtensionState }
  | { ok: true; type: "rename-profile"; state: ExtensionState }
  | { ok: true; type: "delete-profile"; state: ExtensionState }
  | { ok: true; type: "save-memory"; state: ExtensionState }
  | { ok: true; type: "delete-memory"; state: ExtensionState }
  | { ok: true; type: "save-settings"; settings: Settings }
  | { ok: true; type: "analyze-jd"; analysis: JdAnalysis }
  | { ok: true; type: "save-analysis-result"; analysis: JdAnalysis }
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
