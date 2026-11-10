/**
 * The service worker.
 *
 * It owns three things and nothing else:
 *  - the plan-building pipeline (scan → classify → decide),
 *  - persistence, so the content script never writes to storage directly,
 *  - the "record this application" step, which is the only place a submission
 *    becomes permanent.
 *
 * Keeping the engine here rather than in the content script means a page can be
 * reloaded mid-review without losing the plan, and the same code serves the
 * workbench.
 */

import {
  analyzeJd,
  applyReparse,
  buildDiagnosticBundle,
  buildPlan,
  considerObservation,
  createDiagnosticEvent,
  createRecord,
  diagnosticId,
  effectiveHiringTrack,
  experiencesForTrack,
  enrichJobTextFromAnalyses,
  matchDossierForJob,
  parseResume,
  previewReparse,
  tailorResume,
  type ApplicationRecord,
  type MemoryEntry,
} from "@quill/core";
import type { ExtensionRequest, ExtensionResponse, FillReport } from "./shared/protocol.js";
import * as store from "./shared/store.js";

/**
 * Chrome MV3 workers are torn down between events, so anything held in a
 * module-level variable can vanish. This map is a best-effort cache only — the
 * plan is also returned to the caller, which is what actually matters.
 */
const lastPlanByTab = new Map<number, { plan: unknown; at: number }>();

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    void chrome.tabs.create({ url: chrome.runtime.getURL("pages/welcome.html") });
  }
});

/**
 * Route messages. Errors are caught per-request so a failure in one handler
 * cannot take down the worker and silently break every later message.
 */
chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!isRequest(message)) return false;

  handle(message, sender)
    .then((response) => sendResponse(response))
    .catch((error: unknown) => {
      const text = error instanceof Error ? error.message : String(error);
      console.error("[quill] request failed", message.type, text);
      /*
       * Keep the failure in the diagnostic buffer as well as the console. The
       * console is erased when the worker restarts; a person reporting a bug is
       * usually several page reloads past the point where it mattered.
       */
      void store.appendDiagnosticEvent(
        createDiagnosticEvent({
          scope: "worker",
          level: "error",
          event: "request.failed",
          data: {
            request: message.type,
            message: error instanceof Error ? error.message : String(error),
            ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
          },
        }),
      );
      sendResponse({ ok: false, error: text } satisfies ExtensionResponse);
    });

  // Returning true keeps the channel open for the async response.
  return true;
});

function isRequest(value: unknown): value is ExtensionRequest {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

async function handle(
  request: ExtensionRequest,
  sender: chrome.runtime.MessageSender,
): Promise<ExtensionResponse> {
  switch (request.type) {
    /* ------------------------------------------------------------- engine */

    case "build-plan": {
      const [state, dossierState] = await Promise.all([store.loadState(), store.loadProfileDossiers()]);
      const jobText = enrichJobTextFromAnalyses(
        request.pageRole,
        request.company,
        request.scan.jobContext,
        state.analyses,
      );
      const match = matchDossierForJob(dossierState.dossiers, dossierState.activeId, {
        jobRole: request.pageRole,
        jobText,
        hiringTrack: request.scan.hiringTrack,
      });
      const profile = match.dossier?.profile ?? state.profile;
      if (!profile) {
        return { ok: false, error: "还没有简历资料，请先在工作台上传简历" };
      }
      const matchNotes = dossierMatchNotes(match, dossierState.dossiers.length, request.pageRole);
      const plan = buildPlan(request.scan, {
        profile,
        memory: state.memory,
        siteKey: request.scan.siteKey,
        ...(request.pageRole ? { pageRole: request.pageRole } : {}),
        ...(request.company ? { company: request.company } : {}),
        composeEssays: state.settings.composeEssays,
        preserveExisting: state.settings.preserveExisting,
        autoApplyThreshold: state.settings.autoApplyConfident ? 0.6 : 0.85,
        notes: [
          ...(request.scan.ats ? [`检测到 ${request.scan.ats} 表单，已启用对应的填写方式`] : []),
          ...matchNotes,
        ],
      });
      if (sender.tab?.id !== undefined) {
        lastPlanByTab.set(sender.tab.id, { plan, at: Date.now() });
      }
      return { ok: true, type: "build-plan", plan };
    }

    case "apply-plan": {
      /*
       * Filling happens inside the page, because only there can we reach the
       * DOM and dispatch the real events frameworks listen for. This branch
       * exists so the protocol stays exhaustive; the content script handles
       * `apply-plan` itself and never forwards it here.
       */
      return { ok: false, error: "填写必须由页面内的内容脚本执行" };
    }

    /* ------------------------------------------------------------ learning */

    case "observe": {
      const state = await store.loadState();
      if (!state.settings.learnFromUserInput) {
        return { ok: true, type: "observe", learned: false, reason: "已关闭自动学习" };
      }
      const siteKey = currentSiteKey(sender);
      const decision = considerObservation(
        {
          field: request.field,
          value: request.value,
          proposedValues: request.proposedValues,
          siteKey,
          at: Date.now(),
        },
        state.memory,
        { confirmLearned: state.settings.confirmLearned },
      );

      if (decision.action === "skip" || !decision.entry) {
        return { ok: true, type: "observe", learned: false, reason: decision.reason };
      }

      await store.upsertMemory(decision.entry);
      await broadcastStateChanged();

      // Tell the page so the panel can show a quiet "remembered" confirmation.
      if (sender.tab?.id !== undefined) {
        void chrome.tabs
          .sendMessage(sender.tab.id, {
            type: "learned",
            label: decision.entry.labelSnapshot,
            value: decision.entry.value,
            key: decision.entry.key,
          })
          .catch(() => {
            // No panel listening; nothing to do.
          });
      }
      return { ok: true, type: "observe", learned: true, reason: decision.reason };
    }

    /* --------------------------------------------------------------- state */

    case "get-profile-dossiers": {
      const { dossiers } = await store.loadProfileDossiers();
      return { ok: true, type: "get-profile-dossiers", dossiers };
    }

    case "get-state":
      return { ok: true, type: "get-state", state: await store.loadState() };

    case "section-targets": {
      /*
       * Only the counts cross the process boundary. The content script already
       * knows which sections the page rendered; it needs to know how many rows
       * the person's profile can justify opening.
       */
      const [state, dossierState] = await Promise.all([store.loadState(), store.loadProfileDossiers()]);
      const jobText = enrichJobTextFromAnalyses(
        request.pageRole,
        request.company,
        request.jobContext,
        state.analyses,
      );
      const match = matchDossierForJob(dossierState.dossiers, dossierState.activeId, {
        jobRole: request.pageRole,
        jobText,
        hiringTrack: request.hiringTrack,
      });
      const profile = match.dossier?.profile ?? state.profile;
      const track = effectiveHiringTrack(request.hiringTrack, profile?.preference.targetTrack);
      return {
        ok: true,
        type: "section-targets",
        targets: {
          education: profile?.education.length ?? 0,
          experience: profile
            ? experiencesForTrack(profile.experience, track, request.experienceKind).length
            : 0,
          experienceTotal: profile?.experience.length ?? 0,
          projects: profile?.projects.length ?? 0,
        },
      };
    }

    /* --------------------------------------------------------- diagnostics */

    case "log-event": {
      await store.appendDiagnosticEvent(request.event);
      return { ok: true, type: "log-event" };
    }

    case "diagnostics-snapshot": {
      await store.saveDiagnosticSnapshot(request.snapshot);
      return { ok: true, type: "diagnostics-snapshot" };
    }

    case "diagnostics-export": {
      const diagnostics = await store.loadDiagnostics();
      const bundle = buildDiagnosticBundle({
        reportId: diagnosticId("diag"),
        createdAt: Date.now(),
        ...(request.description ? { description: request.description } : {}),
        environment: {
          browser: navigator.userAgent,
          platform: navigator.platform || "unknown",
          language: navigator.language || "unknown",
          extensionVersion: chrome.runtime.getManifest().version,
        },
        snapshot: diagnostics.snapshot ?? {},
        events: diagnostics.events,
      });
      return { ok: true, type: "diagnostics-export", bundle };
    }

    case "diagnostics-clear": {
      await store.clearDiagnostics();
      return { ok: true, type: "diagnostics-clear" };
    }

    case "save-profile": {
      const profile = await store.saveProfile(request.profile);
      await broadcastStateChanged();
      return { ok: true, type: "save-profile", profile };
    }

    case "import-document": {
      const before = await store.loadState();
      const document = await store.addDocument(request.document);
      /*
       * Importing a resume is the one action that should also update the
       * profile, because the whole product depends on having one. We parse here
       * rather than in the workbench so both entry points behave identically.
       *
       * When a profile already exists the import updates the *active direction*
       * rather than creating a second dossier: the person explicitly chose
       * “重新上传” on that direction.
       */
      if (request.document.kind === "resume") {
        const profile = request.profile
          ? {
              ...request.profile,
              id: before.profile?.id ?? "profile-1",
              sourceDocumentId: document.id,
              updatedAt: Date.now(),
            }
          : parseResume(document.text, {
              profileId: before.profile?.id ?? "profile-1",
              sourceDocumentId: document.id,
            }).profile;
        // Re-uploading is just as destructive as re-parsing: keep the same
        // one-deep snapshot so “撤销上次替换” covers both paths.
        if (before.profile) {
          await store.saveReparseBackup(before.profile, before.activeProfileId);
        }
        await store.saveProfile(profile);
      }
      const state = await store.loadState();
      await broadcastStateChanged();
      return { ok: true, type: "import-document", state };
    }

    case "preview-reparse": {
      const { before, parsed, sourceChars } = await reparseProfile();
      return {
        ok: true,
        type: "preview-reparse",
        preview: previewReparse(before, parsed, sourceChars),
      };
    }

    case "reparse-resume": {
      const { before, parsed } = await reparseProfile();
      const next = applyReparse(before, parsed, request.mode);
      // Snapshot first: a failed write must not leave the old profile replaced.
      await store.saveReparseBackup(before, (await store.loadState()).activeProfileId);
      await store.saveProfile(next);
      await broadcastStateChanged();
      return { ok: true, type: "reparse-resume", state: await store.loadState() };
    }

    case "undo-reparse": {
      await store.restoreReparseBackup();
      await broadcastStateChanged();
      return { ok: true, type: "undo-reparse", state: await store.loadState() };
    }

    case "create-profile": {
      await store.createProfileDossier(request.name);
      await broadcastStateChanged();
      return { ok: true, type: "create-profile", state: await store.loadState() };
    }

    case "switch-profile": {
      await store.switchProfileDossier(request.id);
      await broadcastStateChanged();
      return { ok: true, type: "switch-profile", state: await store.loadState() };
    }

    case "rename-profile": {
      await store.renameProfileDossier(request.id, request.name);
      await broadcastStateChanged();
      return { ok: true, type: "rename-profile", state: await store.loadState() };
    }

    case "delete-profile": {
      await store.deleteProfileDossier(request.id);
      await broadcastStateChanged();
      return { ok: true, type: "delete-profile", state: await store.loadState() };
    }

    case "save-memory":
      await store.upsertMemory(request.entry);
      await broadcastStateChanged();
      return { ok: true, type: "save-memory", state: await store.loadState() };

    case "delete-memory":
      await store.deleteMemory(request.id);
      await broadcastStateChanged();
      return { ok: true, type: "delete-memory", state: await store.loadState() };

    case "save-settings": {
      const settings = await store.saveSettings(request.settings);
      await broadcastStateChanged();
      return { ok: true, type: "save-settings", settings };
    }

    /* -------------------------------------------------------------- tailor */

    case "analyze-jd": {
      const analysis = analyzeJd(request.text, request.meta ?? {});
      await store.saveAnalysis(analysis);
      await broadcastStateChanged();
      return { ok: true, type: "analyze-jd", analysis };
    }

    case "save-analysis-result": {
      await store.saveAnalysis(request.analysis);
      await broadcastStateChanged();
      return { ok: true, type: "save-analysis-result", analysis: request.analysis };
    }

    case "tailor": {
      const [state, { dossiers, activeId }] = await Promise.all([
        store.loadState(),
        store.loadProfileDossiers(),
      ]);
      const analysis = state.analyses.find((item) => item.id === request.jdAnalysisId);
      if (!analysis) return { ok: false, error: "找不到该岗位分析结果，请重新解析" };
      const match = request.dossierId
        ? { dossier: dossiers.find((item) => item.id === request.dossierId) }
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
      if (!profile) return { ok: false, error: "请先上传简历" };
      const report = tailorResume(profile, analysis, {
        ...request.options,
        ...(match.dossier ? { dossierId: match.dossier.id, dossierName: match.dossier.name } : {}),
      });
      await store.saveReport(report);
      await broadcastStateChanged();
      return { ok: true, type: "tailor", report };
    }

    /* -------------------------------------------------------------- ledger */

    case "save-record": {
      const records = await store.saveRecord(request.record);
      await broadcastStateChanged();
      return { ok: true, type: "save-record", records };
    }

    case "delete-record": {
      const records = await store.deleteRecord(request.id);
      await broadcastStateChanged();
      return { ok: true, type: "delete-record", records };
    }

    case "record-submission": {
      const record = createRecord({
        company: request.company || "未填写公司",
        role: request.role || "未填写岗位",
        url: request.url,
        stage: "submitted",
        submittedFields: request.plan.decisions
          .filter((decision) => decision.value && decision.status === "ready")
          .map((decision) => ({ label: decision.label, value: decision.value?.text ?? "" })),
      });
      await store.saveRecord(record);
      await broadcastStateChanged();
      return { ok: true, type: "record-submission", record };
    }

    case "set-position":
      return { ok: true, type: "set-position" };

    case "hide-site": {
      const panel = await store.hideSite(request.siteKey);
      return { ok: true, type: "hide-site", hiddenSites: panel.hiddenSites };
    }

    case "unhide-site": {
      const panel = await store.unhideSite(request.siteKey);
      return { ok: true, type: "unhide-site", hiddenSites: panel.hiddenSites };
    }

    case "open-workbench": {
      const url = chrome.runtime.getURL(`pages/workbench.html${request.view ? `#${request.view}` : ""}`);
      await chrome.tabs.create({ url });
      return { ok: true, type: "open-workbench" };
    }

    default:
      return { ok: false, error: `未知的请求类型 ${(request as { type: string }).type}` };
  }
}

/**
 * The text source for re-parsing: the verbatim text saved with the profile,
 * falling back to the newest resume document for profiles created before that
 * field existed.
 */
async function reparseProfile(): Promise<{
  before: NonNullable<Awaited<ReturnType<typeof store.loadState>>["profile"]>;
  parsed: NonNullable<Awaited<ReturnType<typeof store.loadState>>["profile"]>;
  sourceChars: number;
}> {
  const state = await store.loadState();
  const before = state.profile;
  if (!before) throw new Error("还没有简历资料，请先上传简历");

  const text = before.rawText ?? state.documents.find((document) => document.kind === "resume")?.text;
  if (!text) throw new Error("没有可重新解析的简历文字，请重新上传简历");

  const { profile: parsed } = parseResume(text, {
    profileId: before.id,
    ...(before.sourceDocumentId ? { sourceDocumentId: before.sourceDocumentId } : {}),
  });
  return { before, parsed, sourceChars: text.length };
}

function dossierMatchNotes(
  match: ReturnType<typeof matchDossierForJob>,
  dossierCount: number,
  jobRole: string | undefined,
): string[] {
  if (dossierCount <= 1 || !match.dossier) return [];
  if (match.matchedByJob && (match.score ?? 0) >= 0.12) {
    const role = jobRole?.trim();
    return [
      `已按${role ? `岗位「${role.slice(0, 48)}」` : "岗位信息"}自动选择「${match.dossier.name}」简历。`,
    ];
  }
  if (match.matchedByJob) {
    return [`已识别岗位信息，但现有方向简历没有明显匹配信号，暂用「${match.dossier.name}」简历；请确认。`];
  }
  return [`页面未识别到岗位信息，暂用工作台当前的「${match.dossier.name}」简历；请确认方向。`];
}

function currentSiteKey(sender: chrome.runtime.MessageSender): string {
  const url = sender.tab?.url ?? sender.url ?? "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

/**
 * Notify every extension page (popup, options, workbench) that state changed.
 * Failures are ignored because a closed popup is the normal case.
 */
async function broadcastStateChanged(): Promise<void> {
  const state = await store.loadState();
  try {
    await chrome.runtime.sendMessage({ type: "state-changed", state });
  } catch {
    // No listener open.
  }
}

/* --------------------------------------------------------------- commands */

chrome.commands?.onCommand.addListener((command) => {
  if (command === "scan-page") {
    void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab?.id !== undefined) {
        void chrome.tabs.sendMessage(tab.id, { type: "scan-requested" }).catch(() => {
          // The page has no content script (e.g. a Chrome internal page).
        });
      }
    });
  }
});

/* --------------------------------------------------------- context menu */

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus?.removeAll(() => {
    chrome.contextMenus?.create({
      id: "quill-fill",
      title: "用 Quill 识别此页面的表单",
      contexts: ["page", "frame"],
    });
  });
});

chrome.contextMenus?.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "quill-fill" || tab?.id === undefined) return;
  void chrome.tabs.sendMessage(tab.id, { type: "scan-requested" }).catch(() => {});
});

/* --------------------------------------------------------------- cleanup */

chrome.tabs.onRemoved.addListener((tabId) => {
  lastPlanByTab.delete(tabId);
});

export type { MemoryEntry, ApplicationRecord, FillReport };
