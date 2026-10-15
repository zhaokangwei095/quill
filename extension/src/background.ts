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
  buildPlan,
  considerObservation,
  createRecord,
  parseResume,
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
      const state = await store.loadState();
      const profile = state.profile;
      if (!profile) {
        return { ok: false, error: "还没有简历资料，请先在工作台上传简历" };
      }
      const plan = buildPlan(request.scan, {
        profile,
        memory: state.memory,
        siteKey: request.scan.siteKey,
        ...(request.pageRole ? { pageRole: request.pageRole } : {}),
        ...(request.company ? { company: request.company } : {}),
        composeEssays: state.settings.composeEssays,
        preserveExisting: state.settings.preserveExisting,
        autoApplyThreshold: state.settings.autoApplyConfident ? 0.6 : 0.85,
        notes: request.scan.ats ? [`检测到 ${request.scan.ats} 表单，已启用对应的填写方式`] : [],
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

    case "get-state":
      return { ok: true, type: "get-state", state: await store.loadState() };

    case "save-profile": {
      const profile = await store.saveProfile(request.profile);
      await broadcastStateChanged();
      return { ok: true, type: "save-profile", profile };
    }

    case "import-document": {
      const document = await store.addDocument(request.document);
      /*
       * Importing a resume is the one action that should also update the
       * profile, because the whole product depends on having one. We parse here
       * rather than in the workbench so both entry points behave identically.
       */
      if (request.document.kind === "resume") {
        const { profile } = parseResume(document.text, {
          profileId: "profile-1",
          sourceDocumentId: document.id,
        });
        await store.saveProfile(profile);
      }
      const state = await store.loadState();
      await broadcastStateChanged();
      return { ok: true, type: "import-document", state };
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

    case "tailor": {
      const state = await store.loadState();
      if (!state.profile) return { ok: false, error: "请先上传简历" };
      const analysis = state.analyses.find((item) => item.id === request.jdAnalysisId);
      if (!analysis) return { ok: false, error: "找不到该岗位分析结果，请重新解析" };
      const report = tailorResume(state.profile, analysis, request.options ?? {});
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
