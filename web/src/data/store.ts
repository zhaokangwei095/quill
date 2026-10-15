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
  DEFAULT_SETTINGS,
  type ApplicationRecord,
  type DocumentRecord,
  type JdAnalysis,
  type MemoryEntry,
  type Profile,
  type Settings,
  type TailorReport,
} from "@quill/core";

export interface WorkbenchState {
  profile?: Profile;
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
  importDocument(document: Omit<DocumentRecord, "id" | "uploadedAt">): Promise<WorkbenchState>;
  deleteDocument(id: string): Promise<WorkbenchState>;
  saveAnalysis(text: string, meta?: { company?: string; role?: string }): Promise<JdAnalysis>;
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

  async function load(): Promise<WorkbenchState> {
    const profile = read<Profile | undefined>(KEYS.profile, undefined);
    return {
      ...(profile ? { profile } : {}),
      documents: read<DocumentRecord[]>(KEYS.documents, []),
      memory: read<MemoryEntry[]>(KEYS.memory, []),
      analyses: read<JdAnalysis[]>(KEYS.analyses, []),
      reports: read<TailorReport[]>(KEYS.reports, []),
      records: read<ApplicationRecord[]>(KEYS.records, []),
      settings: { ...DEFAULT_SETTINGS, ...read<Partial<Settings>>(KEYS.settings, {}) },
    };
  }

  return {
    kind: "local",
    load,

    async saveProfile(profile) {
      const next = { ...profile, updatedAt: Date.now() };
      write(KEYS.profile, next);
      return next;
    },

    async importDocument(input) {
      const state = await load();
      const { parseResume } = await import("@quill/core");
      const record: DocumentRecord = {
        id: `doc-${Date.now().toString(36)}`,
        kind: input.kind,
        fileName: input.fileName,
        mimeType: input.mimeType,
        text: input.text.slice(0, 400_000),
        uploadedAt: Date.now(),
      };
      write(KEYS.documents, [record, ...state.documents].slice(0, 12));
      if (input.kind === "resume") {
        const { profile } = parseResume(record.text, { profileId: "profile-1", sourceDocumentId: record.id });
        write(KEYS.profile, profile);
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

    async saveAnalysis(text, meta) {
      const { analyzeJd } = await import("@quill/core");
      const state = await load();
      const analysis = analyzeJd(text, meta ?? {});
      write(KEYS.analyses, [analysis, ...state.analyses].slice(0, 30));
      return analysis;
    },

    async saveReport(report) {
      const state = await load();
      write(KEYS.reports, [report, ...state.reports.filter((item) => item.id !== report.id)].slice(0, 30));
      return report;
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
      const response = await request<{ state: WorkbenchState }>({ type: "import-document", document });
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

    async saveAnalysis(text, meta) {
      const response = await request<{ analysis: JdAnalysis }>({ type: "analyze-jd", text, meta });
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
