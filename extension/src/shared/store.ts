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
  compactMemory,
  DEFAULT_SETTINGS,
  type ApplicationRecord,
  type DocumentRecord,
  type JdAnalysis,
  type MemoryEntry,
  type Profile,
  type Settings,
  type TailorReport,
} from "@quill/core";
import type { ExtensionState } from "./protocol.js";

const KEYS = {
  profile: "quill.profile",
  documents: "quill.documents",
  memory: "quill.memory",
  analyses: "quill.analyses",
  reports: "quill.reports",
  records: "quill.records",
  settings: "quill.settings",
  panel: "quill.panel",
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

/* ------------------------------------------------------------------- state */

export async function loadState(): Promise<ExtensionState> {
  const [profile, documents, memory, analyses, reports, records, settings] = await Promise.all([
    read<Profile | undefined>(KEYS.profile, undefined),
    read<DocumentRecord[]>(KEYS.documents, []),
    read<MemoryEntry[]>(KEYS.memory, []),
    read<JdAnalysis[]>(KEYS.analyses, []),
    read<TailorReport[]>(KEYS.reports, []),
    read<ApplicationRecord[]>(KEYS.records, []),
    read<Settings>(KEYS.settings, DEFAULT_SETTINGS),
  ]);
  return {
    ...(profile ? { profile } : {}),
    documents,
    memory,
    analyses,
    reports,
    records,
    // Merge with defaults so a new setting does not read as undefined.
    settings: { ...DEFAULT_SETTINGS, ...settings },
  };
}

export async function saveProfile(profile: Profile): Promise<Profile> {
  const next = { ...profile, updatedAt: Date.now() };
  await write(KEYS.profile, next);
  return next;
}

export async function saveSettings(settings: Settings): Promise<Settings> {
  await write(KEYS.settings, settings);
  return settings;
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
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      version: 1,
      profile: state.profile,
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
  const parsed = JSON.parse(json) as Partial<ExtensionState> & { version?: number };
  if (parsed.profile) await write(KEYS.profile, parsed.profile);
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
