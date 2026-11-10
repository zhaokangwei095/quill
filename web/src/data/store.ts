/**
 * The workbench's storage adapter.
 *
 * One interface, two back ends, chosen at runtime:
 *
 *  - `extension` when the page is served from `chrome-extension://`. There the
 *    real store lives in the extension's service worker, so the workbench talks
 *    to it over the message protocol and therefore shares data with the in-page
 *    panel and the popup.
 *  - `local` everywhere else, so the same application runs as a normal website
 *    without any extension installed. Data lives in `localStorage` under the
 *    same key names.
 *
 * The interface is intentionally synchronous-looking for reads (they are
 * awaited) and identical for writes, so no view has to know which is which.
 */

import {
  applyReparse,
  DEFAULT_DOSSIER_NAME,
  DEFAULT_SETTINGS,
  MAX_PROFILE_DOSSIERS,
  newDossier,
  normalizeDossierName,
  normalizeSettings,
  previewReparse as buildReparsePreview,
  resolveDossiers,
  summarizeDossier,
  type ApplicationRecord,
  type DocumentRecord,
  type JdAnalysis,
  type MemoryEntry,
  type Profile,
  type ProfileDossier,
  type ProfileSummary,
  type ReparseMode,
  type ReparsePreview,
  type Settings,
  type TailorReport,
} from "@quill/core";

export interface WorkbenchState {
  /** The workbench's current editing profile; page filling may auto-match another dossier. */
  profile?: Profile;
  /** All directions, with counts only — the full profiles stay in storage. */
  profiles: ProfileSummary[];
  activeProfileId?: string;
  reparseBackup?: { at: number };
  documents: DocumentRecord[];
  memory: MemoryEntry[];
  analyses: JdAnalysis[];
  reports: TailorReport[];
  records: ApplicationRecord[];
  settings: Settings;
}

export interface QuillStore {
  readonly kind: "extension" | "local";
  load(): Promise<WorkbenchState>;
  saveProfile(profile: Profile): Promise<Profile>;
  /**
   * Store a resume and replace the profile of the direction currently open in the workbench.
   *
   * `profile` is supplied when the model pipeline already built one; without
   * it the store parses `text` with the local rules.
   */
  importDocument(
    document: Omit<DocumentRecord, "id" | "uploadedAt"> & { profile?: Profile },
  ): Promise<WorkbenchState>;
  /** Read and diff the stored resume text without changing anything. */
  previewReparse(): Promise<ReparsePreview>;
  /** Apply a previewed re-parse. `merge` keeps existing values. */
  reparseResume(mode: ReparseMode): Promise<WorkbenchState>;
  /** Restore the profile as it was before the last re-parse. */
  undoReparse(): Promise<WorkbenchState>;
  /** Create a blank direction for its own resume upload. */
  createProfile(name: string): Promise<WorkbenchState>;
  switchProfile(id: string): Promise<WorkbenchState>;
  renameProfile(id: string, name: string): Promise<WorkbenchState>;
  deleteProfile(id: string): Promise<WorkbenchState>;
  deleteDocument(id: string): Promise<WorkbenchState>;
  /** Load every direction's full profile for job-aware resume selection. */
  loadProfileDossiers(): Promise<ProfileDossier[]>;
  /** Generate a report from a specific dossier, or let the worker match the job. */
  tailor(analysisId: string, dossierId?: string): Promise<TailorReport>;
  saveAnalysis(text: string, meta?: { company?: string; role?: string }): Promise<JdAnalysis>;
  /** Persist an analysis produced elsewhere, e.g. by the person's own model. */
  saveAnalysisResult(analysis: JdAnalysis): Promise<JdAnalysis>;
  saveReport(report: TailorReport): Promise<TailorReport>;
  saveRecord(record: ApplicationRecord): Promise<ApplicationRecord[]>;
  deleteRecord(id: string): Promise<ApplicationRecord[]>;
  saveMemory(entry: MemoryEntry): Promise<WorkbenchState>;
  deleteMemory(id: string): Promise<WorkbenchState>;
  clearMemory(): Promise<WorkbenchState>;
  saveSettings(settings: Settings): Promise<Settings>;
  subscribe?(listener: (state: WorkbenchState) => void): () => void;
}

const KEYS = {
  profile: "quill.profile",
  profiles: "quill.profiles",
  activeProfile: "quill.active-profile",
  reparseBackup: "quill.reparse-backup",
  documents: "quill.documents",
  memory: "quill.memory",
  analyses: "quill.analyses",
  reports: "quill.reports",
  records: "quill.records",
  settings: "quill.settings",
} as const;

/* ------------------------------------------------------------ detection */

function isExtension(): boolean {
  return (
    typeof chrome !== "undefined" &&
    typeof chrome.runtime !== "undefined" &&
    typeof chrome.runtime.id === "string" &&
    location.protocol === "chrome-extension:"
  );
}

/* -------------------------------------------------------- local storage */

/**
 * A `localStorage`-backed store, used when the workbench is hosted as a normal
 * website. It mirrors the extension's semantics exactly: documents keep their
 * text, memory is compacted on write, and the same defaults apply.
 */
function createLocalStore(): QuillStore {
  function read<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  function write(key: string, value: unknown): void {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      // Quota exceeded. A resume's text is the only large thing we store, so
      // surface a message the view can show rather than failing silently.
      throw new Error(
        error instanceof Error && /quota/i.test(error.message)
          ? "浏览器本地存储空间已满，请先在设置里清理旧数据"
          : "无法写入本地存储",
      );
    }
  }

  interface LocalReparseBackup {
    at: number;
    dossierId?: string;
    profile: Profile;
  }

  function readDossiers(): ReturnType<typeof resolveDossiers> {
    return resolveDossiers(
      read<ProfileDossier[] | undefined>(KEYS.profiles, undefined),
      read<Profile | undefined>(KEYS.profile, undefined),
      read<string | undefined>(KEYS.activeProfile, undefined),
    );
  }

  function persistDossiers(dossiers: ProfileDossier[], activeId: string): Profile {
    const active = dossiers.find((dossier) => dossier.id === activeId) ?? dossiers[0];
    if (!active) throw new Error("没有可用的方向档案");
    write(KEYS.profiles, dossiers);
    write(KEYS.activeProfile, active.id);
    // Legacy key, for a downgrade or a version-1 export.
    write(KEYS.profile, active.profile);
    return active.profile;
  }

  function saveProfileNow(profile: Profile): Profile {
    const { dossiers, activeId } = readDossiers();
    const now = Date.now();
    const id = activeId ?? profile.id ?? "profile-1";
    const nextProfile: Profile = { ...profile, id, updatedAt: now };
    let list = dossiers;

    if (list.length === 0) {
      list = [
        {
          id,
          name: profile.preference.position?.trim()
            ? normalizeDossierName(profile.preference.position)
            : DEFAULT_DOSSIER_NAME,
          profile: nextProfile,
          createdAt: now,
          updatedAt: now,
        },
      ];
    } else if (list.some((dossier) => dossier.id === id)) {
      list = list.map((dossier) =>
        dossier.id === id ? { ...dossier, profile: nextProfile, updatedAt: now } : dossier,
      );
    } else {
      list = [
        ...list,
        {
          id,
          name: normalizeDossierName(`方向 ${list.length + 1}`),
          profile: nextProfile,
          createdAt: now,
          updatedAt: now,
        },
      ];
    }
    return persistDossiers(list, id);
  }

  function loadNow(): WorkbenchState {
    const { dossiers, activeId } = readDossiers();
    const active = dossiers.find((dossier) => dossier.id === activeId) ?? dossiers[0];
    const backup = read<LocalReparseBackup | undefined>(KEYS.reparseBackup, undefined);
    return {
      ...(active ? { profile: active.profile } : {}),
      profiles: dossiers.map(summarizeDossier),
      ...(active ? { activeProfileId: active.id } : {}),
      ...(backup && (!backup.dossierId || backup.dossierId === active?.id)
        ? { reparseBackup: { at: backup.at } }
        : {}),
      documents: read<DocumentRecord[]>(KEYS.documents, []),
      memory: read<MemoryEntry[]>(KEYS.memory, []),
      analyses: read<JdAnalysis[]>(KEYS.analyses, []),
      reports: read<TailorReport[]>(KEYS.reports, []),
      records: read<ApplicationRecord[]>(KEYS.records, []),
      settings: normalizeSettings(read<Partial<Settings>>(KEYS.settings, {})),
    };
  }

  const load = async (): Promise<WorkbenchState> => loadNow();

  function saveReportNow(report: TailorReport): TailorReport {
    const state = loadNow();
    write(KEYS.reports, [report, ...state.reports.filter((item) => item.id !== report.id)].slice(0, 30));
    return report;
  }

  async function reparseSource(): Promise<{
    before: Profile;
    parsed: Profile;
    sourceChars: number;
    dossierId?: string;
  }> {
    const state = await load();
    const before = state.profile;
    if (!before) throw new Error("还没有简历资料，请先上传简历");
    const text = before.rawText ?? state.documents.find((document) => document.kind === "resume")?.text;
    if (!text) throw new Error("没有可重新解析的简历文字，请重新上传简历");
    const { parseResume } = await import("@quill/core");
    const { profile: parsed } = parseResume(text, {
      profileId: before.id,
      ...(before.sourceDocumentId ? { sourceDocumentId: before.sourceDocumentId } : {}),
    });
    return {
      before,
      parsed,
      sourceChars: text.length,
      ...(state.activeProfileId ? { dossierId: state.activeProfileId } : {}),
    };
  }

  return {
    kind: "local",
    load,

    async saveProfile(profile) {
      return saveProfileNow(profile);
    },

    async importDocument(input) {
      const state = await load();
      const { profile: providedProfile, ...documentInput } = input;
      const record: DocumentRecord = {
        id: `doc-${Date.now().toString(36)}`,
        kind: documentInput.kind,
        fileName: documentInput.fileName,
        mimeType: documentInput.mimeType,
        text: documentInput.text.slice(0, 400_000),
        uploadedAt: Date.now(),
        ...(documentInput.extractionMethod ? { extractionMethod: documentInput.extractionMethod } : {}),
      };
      write(KEYS.documents, [record, ...state.documents].slice(0, 12));
      if (input.kind === "resume") {
        const profile = providedProfile
          ? {
              ...providedProfile,
              id: state.profile?.id ?? "profile-1",
              sourceDocumentId: record.id,
              updatedAt: Date.now(),
            }
          : (await import("@quill/core")).parseResume(record.text, {
              profileId: state.profile?.id ?? "profile-1",
              sourceDocumentId: record.id,
            }).profile;
        if (state.profile) {
          write(KEYS.reparseBackup, {
            at: Date.now(),
            ...(state.activeProfileId ? { dossierId: state.activeProfileId } : {}),
            profile: state.profile,
          });
        }
        saveProfileNow(profile);
      }
      return load();
    },

    async deleteDocument(id) {
      const state = await load();
      write(
        KEYS.documents,
        state.documents.filter((document) => document.id !== id),
      );
      return load();
    },

    async previewReparse() {
      const { before, parsed, sourceChars } = await reparseSource();
      return buildReparsePreview(before, parsed, sourceChars);
    },

    async reparseResume(mode) {
      const { before, parsed, dossierId } = await reparseSource();
      const next = applyReparse(before, parsed, mode);
      write(KEYS.reparseBackup, { at: Date.now(), ...(dossierId ? { dossierId } : {}), profile: before });
      saveProfileNow(next);
      return load();
    },

    async undoReparse() {
      const backup = read<LocalReparseBackup | undefined>(KEYS.reparseBackup, undefined);
      if (!backup?.profile) throw new Error("没有可撤销的重新解析记录");
      const { dossiers } = readDossiers();
      if (backup.dossierId && dossiers.some((dossier) => dossier.id === backup.dossierId)) {
        write(KEYS.activeProfile, backup.dossierId);
      }
      saveProfileNow(backup.profile);
      localStorage.removeItem(KEYS.reparseBackup);
      return load();
    },

    async createProfile(name) {
      const { dossiers, activeId } = readDossiers();
      if (dossiers.length >= MAX_PROFILE_DOSSIERS) {
        throw new Error(`最多保留 ${MAX_PROFILE_DOSSIERS} 个方向档案，请先删除不再使用的方向`);
      }
      const active = dossiers.find((dossier) => dossier.id === activeId) ?? dossiers[0];
      if (!active) throw new Error("请先建立一个方向档案，再新建方向");
      const dossier = newDossier(name);
      persistDossiers([...dossiers, dossier], dossier.id);
      return load();
    },

    async switchProfile(id) {
      const { dossiers } = readDossiers();
      const target = dossiers.find((dossier) => dossier.id === id);
      if (!target) throw new Error("找不到这个方向档案");
      persistDossiers(dossiers, target.id);
      return load();
    },

    async renameProfile(id, name) {
      const { dossiers, activeId } = readDossiers();
      const normalized = normalizeDossierName(name);
      if (!dossiers.some((dossier) => dossier.id === id)) throw new Error("找不到这个方向档案");
      const next = dossiers.map((dossier) =>
        dossier.id === id ? { ...dossier, name: normalized, updatedAt: Date.now() } : dossier,
      );
      persistDossiers(next, activeId ?? id);
      return load();
    },

    async deleteProfile(id) {
      const { dossiers, activeId } = readDossiers();
      if (dossiers.length <= 1) throw new Error("至少保留一个方向档案");
      const next = dossiers.filter((dossier) => dossier.id !== id);
      if (next.length === dossiers.length) throw new Error("找不到这个方向档案");
      const nextActive = activeId === id ? (next[0]?.id ?? "") : (activeId ?? next[0]?.id ?? "");
      persistDossiers(next, nextActive);
      return load();
    },

    async loadProfileDossiers() {
      return readDossiers().dossiers;
    },

    async tailor(analysisId, dossierId) {
      const state = await load();
      const analysis = state.analyses.find((item) => item.id === analysisId);
      if (!analysis) throw new Error("找不到该岗位分析结果，请重新解析");
      const { dossiers, activeId } = readDossiers();
      const { matchDossierForJob, tailorResume } = await import("@quill/core");
      const match = dossierId
        ? { dossier: dossiers.find((item) => item.id === dossierId), matchedByJob: false }
        : matchDossierForJob(dossiers, activeId, {
            jobRole: analysis.role,
            jobText: [
              analysis.role,
              ...analysis.requirements.map((item) => item.text),
              ...analysis.keywords,
              ...analysis.sections.map((section) => section.body),
            ].join("\n"),
          });
      const profile = match.dossier?.profile ?? state.profile;
      if (!profile) throw new Error("请先上传简历");
      const report = tailorResume(profile, analysis, {
        ...(analysis.company ? { company: analysis.company } : {}),
        ...(match.dossier ? { dossierId: match.dossier.id, dossierName: match.dossier.name } : {}),
        maxBullets: 3,
      });
      saveReportNow(report);
      return report;
    },

    async saveAnalysis(text, meta) {
      const { analyzeJd } = await import("@quill/core");
      const state = await load();
      const analysis = analyzeJd(text, meta ?? {});
      write(KEYS.analyses, [analysis, ...state.analyses].slice(0, 30));
      return analysis;
    },

    async saveAnalysisResult(analysis) {
      const state = await load();
      write(KEYS.analyses, [analysis, ...state.analyses].slice(0, 30));
      return analysis;
    },

    async saveReport(report) {
      return saveReportNow(report);
    },

    async saveRecord(record) {
      const state = await load();
      const index = state.records.findIndex((item) => item.id === record.id);
      const records =
        index >= 0
          ? state.records.map((item) => (item.id === record.id ? record : item))
          : [record, ...state.records];
      write(KEYS.records, records);
      return records;
    },

    async deleteRecord(id) {
      const state = await load();
      const records = state.records.filter((item) => item.id !== id);
      write(KEYS.records, records);
      return records;
    },

    async saveMemory(entry) {
      const { compactMemory } = await import("@quill/core");
      const state = await load();
      const index = state.memory.findIndex((item) => item.id === entry.id);
      const next =
        index >= 0
          ? state.memory.map((item) => (item.id === entry.id ? entry : item))
          : [entry, ...state.memory];
      write(KEYS.memory, compactMemory(next).slice(0, 600));
      return load();
    },

    async deleteMemory(id) {
      const state = await load();
      write(
        KEYS.memory,
        state.memory.filter((item) => item.id !== id),
      );
      return load();
    },

    async clearMemory() {
      write(KEYS.memory, []);
      return load();
    },

    async saveSettings(settings) {
      write(KEYS.settings, settings);
      return settings;
    },
  };
}

/* -------------------------------------------------------- extension store */

/**
 * Talks to the extension's service worker. Every mutation there broadcasts a
 * `state-changed` message, which `subscribe` turns into a React update, so the
 * workbench stays live while the person fills a form in another tab.
 */
function createExtensionStore(): QuillStore {
  async function request<R>(message: Record<string, unknown>): Promise<R> {
    const response = (await chrome.runtime.sendMessage(message)) as { ok: boolean; error?: string } & R;
    if (!response || !response.ok) throw new Error(response?.error ?? "扩展没有响应");
    return response;
  }

  const reload = async (): Promise<WorkbenchState> => {
    const response = await request<{ state: WorkbenchState }>({ type: "get-state" });
    return response.state;
  };

  return {
    kind: "extension",
    load: reload,

    async saveProfile(profile) {
      const response = await request<{ profile: Profile }>({ type: "save-profile", profile });
      return response.profile;
    },

    async importDocument(document) {
      const { profile, ...record } = document;
      const response = await request<{ state: WorkbenchState }>({
        type: "import-document",
        document: record,
        ...(profile ? { profile } : {}),
      });
      return response.state;
    },

    async previewReparse() {
      const response = await request<{ preview: ReparsePreview }>({ type: "preview-reparse" });
      return response.preview;
    },

    async reparseResume(mode) {
      const response = await request<{ state: WorkbenchState }>({ type: "reparse-resume", mode });
      return response.state;
    },

    async undoReparse() {
      const response = await request<{ state: WorkbenchState }>({ type: "undo-reparse" });
      return response.state;
    },

    async createProfile(name) {
      const response = await request<{ state: WorkbenchState }>({ type: "create-profile", name });
      return response.state;
    },

    async switchProfile(id) {
      const response = await request<{ state: WorkbenchState }>({ type: "switch-profile", id });
      return response.state;
    },

    async renameProfile(id, name) {
      const response = await request<{ state: WorkbenchState }>({ type: "rename-profile", id, name });
      return response.state;
    },

    async deleteProfile(id) {
      const response = await request<{ state: WorkbenchState }>({ type: "delete-profile", id });
      return response.state;
    },

    async deleteDocument(id) {
      // The extension has no dedicated message; a full profile re-import is not
      // wanted here, so we remove the document through storage directly.
      const documents = (await chrome.storage.local.get("quill.documents"))["quill.documents"] as
        | DocumentRecord[]
        | undefined;
      const next = (documents ?? []).filter((document) => document.id !== id);
      await chrome.storage.local.set({ "quill.documents": next });
      return reload();
    },

    async loadProfileDossiers() {
      const response = await request<{ dossiers: ProfileDossier[] }>({ type: "get-profile-dossiers" });
      return response.dossiers;
    },

    async tailor(analysisId, dossierId) {
      const response = await request<{ report: TailorReport }>({
        type: "tailor",
        jdAnalysisId: analysisId,
        ...(dossierId ? { dossierId } : {}),
      });
      return response.report;
    },

    async saveAnalysis(text, meta) {
      const response = await request<{ analysis: JdAnalysis }>({ type: "analyze-jd", text, meta });
      return response.analysis;
    },

    async saveAnalysisResult(analysis) {
      const response = await request<{ analysis: JdAnalysis }>({ type: "save-analysis-result", analysis });
      return response.analysis;
    },

    async saveReport(report) {
      // Reports are produced by the worker; saving an edited one goes straight
      // to storage so the worker does not need a second code path.
      const reports = (await chrome.storage.local.get("quill.reports"))["quill.reports"] as
        | TailorReport[]
        | undefined;
      const next = [report, ...(reports ?? []).filter((item) => item.id !== report.id)].slice(0, 30);
      await chrome.storage.local.set({ "quill.reports": next });
      return report;
    },

    async saveRecord(record) {
      const response = await request<{ records: ApplicationRecord[] }>({ type: "save-record", record });
      return response.records;
    },

    async deleteRecord(id) {
      const response = await request<{ records: ApplicationRecord[] }>({ type: "delete-record", id });
      return response.records;
    },

    async saveMemory(entry) {
      const response = await request<{ state: WorkbenchState }>({ type: "save-memory", entry });
      return response.state;
    },

    async deleteMemory(id) {
      const response = await request<{ state: WorkbenchState }>({ type: "delete-memory", id });
      return response.state;
    },

    async clearMemory() {
      await chrome.storage.local.set({ "quill.memory": [] });
      return reload();
    },

    async saveSettings(settings) {
      const response = await request<{ settings: Settings }>({ type: "save-settings", settings });
      return response.settings;
    },

    subscribe(listener) {
      const handler = (message: unknown): void => {
        if (
          typeof message === "object" &&
          message !== null &&
          (message as { type?: string }).type === "state-changed"
        ) {
          listener((message as { state: WorkbenchState }).state);
        }
      };
      chrome.runtime.onMessage.addListener(handler);
      return () => chrome.runtime.onMessage.removeListener(handler);
    },
  };
}

/* ----------------------------------------------------------------- export */

let cached: QuillStore | undefined;

/**
 * The store for the current context. Detected once — `location.protocol` cannot
 * change during a page's life, so there is nothing to re-evaluate.
 */
export function getStore(): QuillStore {
  cached ??= isExtension() ? createExtensionStore() : createLocalStore();
  return cached;
}

export function storeKind(): "extension" | "local" {
  return getStore().kind;
}
