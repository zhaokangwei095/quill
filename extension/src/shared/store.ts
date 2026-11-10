/**
 * Persistence.
 *
 * Everything lives in `chrome.storage.local`, which is the only store the
 * service worker and every page can reach. Documents keep their extracted text
 * but not their bytes — a resume PDF can be several megabytes and
 * `storage.local` caps at ~10 MB, so we store the text (the only thing the
 * engine needs) and let the person re-upload the file if they want it back.
 */

import {
  appendDiagnosticEvent as appendEventEntry,
  compactDiagnosticEvents,
  compactMemory,
  DEFAULT_SETTINGS,
  DEFAULT_DOSSIER_NAME,
  DIAGNOSTIC_BYTE_LIMIT,
  DIAGNOSTIC_EVENT_LIMIT,
  MAX_PROFILE_DOSSIERS,
  newDossier,
  normalizeDossierName,
  normalizeSettings,
  resolveDossiers,
  summarizeDossier,
  type ApplicationRecord,
  type DiagnosticEvent,
  type DiagnosticSnapshot,
  type DiagnosticsState,
  type DocumentRecord,
  type JdAnalysis,
  type MemoryEntry,
  type Profile,
  type ProfileDossier,
  type Settings,
  type TailorReport,
} from "@quill/core";
import type { ExtensionState } from "./protocol.js";

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
  panel: "quill.panel",
  diagnostics: "quill.diagnostics",
} as const;

/** How much of a long document we keep. ~1.5 MB of text is generous. */
const MAX_TEXT_LENGTH = 400_000;
const MAX_DOCUMENTS = 12;
const MAX_REPORTS = 30;
const MAX_ANALYSES = 30;

async function read<T>(key: string, fallback: T): Promise<T> {
  const result = await chrome.storage.local.get(key);
  const value = result[key];
  if (value === undefined || value === null) return fallback;
  return value as T;
}

async function write(key: string, value: unknown): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

/* ------------------------------------------------------- direction dossiers */

interface ReparseBackupRecord {
  at: number;
  dossierId?: string;
  profile: Profile;
}

/**
 * Profile mutations are read-modify-write on one array. A fill in one tab and a
 * rename in the workbench can arrive together, so they queue instead of racing.
 */
let dossierQueue: Promise<unknown> = Promise.resolve();

function withDossiers<T>(task: () => Promise<T>): Promise<T> {
  const run = dossierQueue.then(task, task);
  dossierQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function readDossiers(): Promise<ReturnType<typeof resolveDossiers>> {
  const [stored, legacy, activeId] = await Promise.all([
    read<ProfileDossier[] | undefined>(KEYS.profiles, undefined),
    read<Profile | undefined>(KEYS.profile, undefined),
    read<string | undefined>(KEYS.activeProfile, undefined),
  ]);
  return resolveDossiers(stored, legacy, activeId);
}

/** Full dossiers are used only inside the worker to match a job to its resume. */
export function loadProfileDossiers(): Promise<ReturnType<typeof resolveDossiers>> {
  return readDossiers();
}

async function persistDossiers(dossiers: ProfileDossier[], activeId: string): Promise<Profile> {
  const active = dossiers.find((dossier) => dossier.id === activeId) ?? dossiers[0];
  if (!active) throw new Error("没有可用的方向档案");
  await write(KEYS.profiles, dossiers);
  await write(KEYS.activeProfile, active.id);
  // Keep the legacy key in sync so older builds and a downgrade still work.
  await write(KEYS.profile, active.profile);
  return active.profile;
}

/* ------------------------------------------------------------------- state */

export async function loadState(): Promise<ExtensionState> {
  const [{ dossiers, activeId }, documents, memory, analyses, reports, records, settings, backup] =
    await Promise.all([
      readDossiers(),
      read<DocumentRecord[]>(KEYS.documents, []),
      read<MemoryEntry[]>(KEYS.memory, []),
      read<JdAnalysis[]>(KEYS.analyses, []),
      read<TailorReport[]>(KEYS.reports, []),
      read<ApplicationRecord[]>(KEYS.records, []),
      read<Settings>(KEYS.settings, DEFAULT_SETTINGS),
      read<ReparseBackupRecord | undefined>(KEYS.reparseBackup, undefined),
    ]);
  const active = dossiers.find((dossier) => dossier.id === activeId) ?? dossiers[0];
  return {
    ...(active ? { profile: active.profile } : {}),
    profiles: dossiers.map(summarizeDossier),
    ...(active ? { activeProfileId: active.id } : {}),
    ...(backup && (!backup.dossierId || backup.dossierId === active?.id)
      ? { reparseBackup: { at: backup.at } }
      : {}),
    documents,
    memory,
    analyses,
    reports,
    records,
    // Deep-merge so a new nested setting does not read as undefined.
    settings: normalizeSettings(settings),
  };
}

export function saveProfile(profile: Profile): Promise<Profile> {
  return withDossiers(async () => {
    const { dossiers, activeId } = await readDossiers();
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
          name: profile.preference.position?.trim()
            ? normalizeDossierName(profile.preference.position)
            : normalizeDossierName(`方向 ${list.length + 1}`),
          profile: nextProfile,
          createdAt: now,
          updatedAt: now,
        },
      ];
    }

    return persistDossiers(list, id);
  });
}

/** A new direction gets an empty profile for its own resume upload. */
export function createProfileDossier(name: string): Promise<void> {
  return withDossiers(async () => {
    const { dossiers, activeId } = await readDossiers();
    if (dossiers.length >= MAX_PROFILE_DOSSIERS) {
      throw new Error(`最多保留 ${MAX_PROFILE_DOSSIERS} 个方向档案，请先删除不再使用的方向`);
    }
    const active = dossiers.find((dossier) => dossier.id === activeId) ?? dossiers[0];
    if (!active) throw new Error("请先建立一个方向档案，再新建方向");
    const dossier = newDossier(name);
    await persistDossiers([...dossiers, dossier], dossier.id);
  });
}

export function switchProfileDossier(id: string): Promise<void> {
  return withDossiers(async () => {
    const { dossiers } = await readDossiers();
    const target = dossiers.find((dossier) => dossier.id === id);
    if (!target) throw new Error("找不到这个方向档案");
    await persistDossiers(dossiers, target.id);
  });
}

export function renameProfileDossier(id: string, name: string): Promise<void> {
  return withDossiers(async () => {
    const { dossiers, activeId } = await readDossiers();
    const normalized = normalizeDossierName(name);
    let found = false;
    const next = dossiers.map((dossier) => {
      if (dossier.id !== id) return dossier;
      found = true;
      return { ...dossier, name: normalized, updatedAt: Date.now() };
    });
    if (!found) throw new Error("找不到这个方向档案");
    await persistDossiers(next, activeId ?? id);
  });
}

export function deleteProfileDossier(id: string): Promise<void> {
  return withDossiers(async () => {
    const { dossiers, activeId } = await readDossiers();
    if (dossiers.length <= 1) throw new Error("至少保留一个方向档案");
    const next = dossiers.filter((dossier) => dossier.id !== id);
    if (next.length === dossiers.length) throw new Error("找不到这个方向档案");
    const nextActive = activeId === id ? (next[0]?.id ?? "") : (activeId ?? next[0]?.id ?? "");
    await persistDossiers(next, nextActive);
  });
}

/* --------------------------------------------------------- reparse backup */

export function saveReparseBackup(profile: Profile, dossierId: string | undefined): Promise<void> {
  return write(KEYS.reparseBackup, {
    at: Date.now(),
    ...(dossierId ? { dossierId } : {}),
    profile,
  } satisfies ReparseBackupRecord);
}

/** Restore the one-deep snapshot taken before the last re-parse. */
export function restoreReparseBackup(): Promise<Profile> {
  return withDossiers(async () => {
    const backup = await read<ReparseBackupRecord | undefined>(KEYS.reparseBackup, undefined);
    if (!backup?.profile) throw new Error("没有可撤销的重新解析记录");

    const { dossiers, activeId } = await readDossiers();
    const targetId =
      backup.dossierId && dossiers.some((dossier) => dossier.id === backup.dossierId)
        ? backup.dossierId
        : (activeId ?? dossiers[0]?.id);

    if (!targetId) throw new Error("没有可恢复的方向档案");

    const now = Date.now();
    const restored: Profile = { ...backup.profile, id: targetId, updatedAt: now };
    const list = dossiers.some((dossier) => dossier.id === targetId)
      ? dossiers.map((dossier) =>
          dossier.id === targetId ? { ...dossier, profile: restored, updatedAt: now } : dossier,
        )
      : [
          ...dossiers,
          {
            id: targetId,
            name: DEFAULT_DOSSIER_NAME,
            profile: restored,
            createdAt: now,
            updatedAt: now,
          },
        ];

    await persistDossiers(list, targetId);
    await chrome.storage.local.remove(KEYS.reparseBackup);
    return restored;
  });
}

export function clearReparseBackup(): Promise<void> {
  return chrome.storage.local.remove(KEYS.reparseBackup);
}

export async function saveSettings(settings: Settings): Promise<Settings> {
  await write(KEYS.settings, settings);
  return settings;
}

/* -------------------------------------------------------------- diagnostics */

/**
 * Diagnostics are written from message handlers that can overlap (a scan
 * finishing while a fill logs its result). Serialising read-modify-write on a
 * single promise keeps one event from clobbering another.
 */
let diagnosticsQueue: Promise<void> = Promise.resolve();

export async function loadDiagnostics(): Promise<DiagnosticsState> {
  return read<DiagnosticsState>(KEYS.diagnostics, { events: [] });
}

export function appendDiagnosticEvent(event: DiagnosticEvent): Promise<void> {
  diagnosticsQueue = diagnosticsQueue
    .then(async () => {
      const state = await read<DiagnosticsState>(KEYS.diagnostics, { events: [] });
      const events = compactDiagnosticEvents(
        appendEventEntry(state.events, event, DIAGNOSTIC_EVENT_LIMIT),
        DIAGNOSTIC_BYTE_LIMIT,
        DIAGNOSTIC_EVENT_LIMIT,
      );
      await write(KEYS.diagnostics, { ...state, events });
    })
    .catch(() => {
      // Diagnostics must never become a failure mode of their own.
    });
  return diagnosticsQueue;
}

export function saveDiagnosticSnapshot(snapshot: DiagnosticSnapshot): Promise<void> {
  diagnosticsQueue = diagnosticsQueue
    .then(async () => {
      const state = await read<DiagnosticsState>(KEYS.diagnostics, { events: [] });
      await write(KEYS.diagnostics, { ...state, snapshot });
    })
    .catch(() => {});
  return diagnosticsQueue;
}

export async function clearDiagnostics(): Promise<void> {
  diagnosticsQueue = diagnosticsQueue
    .then(() => chrome.storage.local.remove(KEYS.diagnostics))
    .catch(() => {});
  await diagnosticsQueue;
}

/* --------------------------------------------------------------- documents */

export async function addDocument(document: Omit<DocumentRecord, "id" | "uploadedAt"> & { id?: string }): Promise<DocumentRecord> {
  const documents = await read<DocumentRecord[]>(KEYS.documents, []);
  const record: DocumentRecord = {
    id: document.id ?? `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    kind: document.kind,
    fileName: document.fileName,
    mimeType: document.mimeType,
    // Trim before storing: an 80-page PDF would blow the quota.
    text: document.text.slice(0, MAX_TEXT_LENGTH),
    ...(document.parsedProfileId ? { parsedProfileId: document.parsedProfileId } : {}),
    ...(document.editedAt ? { editedAt: document.editedAt } : {}),
    ...(document.extractionMethod ? { extractionMethod: document.extractionMethod } : {}),
    uploadedAt: Date.now(),
  };
  // Newest first, oldest evicted.
  const next = [record, ...documents].slice(0, MAX_DOCUMENTS);
  await write(KEYS.documents, next);
  return record;
}

export async function removeDocument(id: string): Promise<void> {
  const documents = await read<DocumentRecord[]>(KEYS.documents, []);
  await write(
    KEYS.documents,
    documents.filter((document) => document.id !== id),
  );
}

export async function getDocument(id: string): Promise<DocumentRecord | undefined> {
  const documents = await read<DocumentRecord[]>(KEYS.documents, []);
  return documents.find((document) => document.id === id);
}

/* ------------------------------------------------------------------ memory */

export async function getMemory(): Promise<MemoryEntry[]> {
  return read<MemoryEntry[]>(KEYS.memory, []);
}

/**
 * Insert or replace a memory entry, then compact. Compaction matters because
 * every fill session can create entries, and the list is what the resolver
 * scans on every field — unbounded growth would slow every page.
 */
export async function upsertMemory(entry: MemoryEntry): Promise<MemoryEntry[]> {
  const memory = await read<MemoryEntry[]>(KEYS.memory, []);
  const index = memory.findIndex((existing) => existing.id === entry.id);
  const next = index >= 0 ? memory.map((existing) => (existing.id === entry.id ? entry : existing)) : [entry, ...memory];
  const compacted = compactMemory(next).slice(0, 600);
  await write(KEYS.memory, compacted);
  return compacted;
}

export async function deleteMemory(id: string): Promise<MemoryEntry[]> {
  const memory = await read<MemoryEntry[]>(KEYS.memory, []);
  const next = memory.filter((entry) => entry.id !== id);
  await write(KEYS.memory, next);
  return next;
}

export async function clearMemory(): Promise<void> {
  await write(KEYS.memory, []);
}

/* ------------------------------------------------------------------ tailor */

export async function saveAnalysis(analysis: JdAnalysis): Promise<JdAnalysis> {
  const analyses = await read<JdAnalysis[]>(KEYS.analyses, []);
  const next = [analysis, ...analyses.filter((item) => item.id !== analysis.id)].slice(0, MAX_ANALYSES);
  await write(KEYS.analyses, next);
  return analysis;
}

export async function saveReport(report: TailorReport): Promise<TailorReport> {
  const reports = await read<TailorReport[]>(KEYS.reports, []);
  const next = [report, ...reports.filter((item) => item.id !== report.id)].slice(0, MAX_REPORTS);
  await write(KEYS.reports, next);
  return report;
}

/* ------------------------------------------------------------------ ledger */

export async function getRecords(): Promise<ApplicationRecord[]> {
  return read<ApplicationRecord[]>(KEYS.records, []);
}

export async function saveRecord(record: ApplicationRecord): Promise<ApplicationRecord[]> {
  const records = await read<ApplicationRecord[]>(KEYS.records, []);
  const index = records.findIndex((existing) => existing.id === record.id);
  const next = index >= 0
    ? records.map((existing) => (existing.id === record.id ? record : existing))
    : [record, ...records];
  await write(KEYS.records, next);
  return next;
}

export async function deleteRecord(id: string): Promise<ApplicationRecord[]> {
  const records = await read<ApplicationRecord[]>(KEYS.records, []);
  const next = records.filter((record) => record.id !== id);
  await write(KEYS.records, next);
  return next;
}

/* ------------------------------------------------------------------- panel */

export interface PanelState {
  collapsed: boolean;
  x: number;
  y: number;
  /** Sites where the person asked the panel to stay hidden. */
  hiddenSites: string[];
}

const DEFAULT_PANEL: PanelState = { collapsed: false, x: 0, y: 96, hiddenSites: [] };

export async function getPanelState(): Promise<PanelState> {
  const state = await read<PanelState>(KEYS.panel, DEFAULT_PANEL);
  return { ...DEFAULT_PANEL, ...state };
}

export async function savePanelState(state: Partial<PanelState>): Promise<PanelState> {
  const current = await getPanelState();
  const next = { ...current, ...state };
  await write(KEYS.panel, next);
  return next;
}

export async function hideSite(siteKey: string): Promise<PanelState> {
  const current = await getPanelState();
  const hiddenSites = Array.from(new Set([...current.hiddenSites, siteKey])).slice(-200);
  return savePanelState({ hiddenSites });
}

export async function unhideSite(siteKey: string): Promise<PanelState> {
  const current = await getPanelState();
  return savePanelState({ hiddenSites: current.hiddenSites.filter((site) => site !== siteKey) });
}

/* ----------------------------------------------------------------- export */

/** A portable snapshot the person can keep, with no secrets beyond their own. */
export async function exportAll(): Promise<string> {
  const state = await loadState();
  const { dossiers, activeId } = await readDossiers();
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      version: 2,
      profile: state.profile,
      profiles: dossiers,
      activeProfileId: activeId,
      memory: state.memory,
      analyses: state.analyses,
      reports: state.reports,
      records: state.records,
      settings: state.settings,
    },
    null,
    2,
  );
}

export async function importAll(json: string): Promise<void> {
  const parsed = JSON.parse(json) as Partial<ExtensionState> & {
    version?: number;
    profiles?: ProfileDossier[];
  };
  /*
   * A version-1 export has one `profile` and no dossiers. Writing only the
   * legacy key is enough: `resolveDossiers` migrates it on the next read.
   */
  if (Array.isArray(parsed.profiles) && parsed.profiles.length > 0) {
    await write(KEYS.profiles, parsed.profiles);
    if (parsed.activeProfileId) await write(KEYS.activeProfile, parsed.activeProfileId);
  } else if (parsed.profile) {
    await chrome.storage.local.remove(KEYS.profiles);
    await write(KEYS.profile, parsed.profile);
  }
  if (parsed.memory) await write(KEYS.memory, parsed.memory);
  if (parsed.analyses) await write(KEYS.analyses, parsed.analyses);
  if (parsed.reports) await write(KEYS.reports, parsed.reports);
  if (parsed.records) await write(KEYS.records, parsed.records);
  if (parsed.settings) await write(KEYS.settings, { ...DEFAULT_SETTINGS, ...parsed.settings });
}

/** Wipe everything. Kept explicit so the UI can name exactly what it erases. */
export async function eraseAll(): Promise<void> {
  await chrome.storage.local.remove(Object.values(KEYS));
}
