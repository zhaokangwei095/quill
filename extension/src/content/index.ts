/**
 * The content script.
 *
 * Responsibilities, in order of importance:
 *  1. Mount the panel into a shadow root so no page style can reach it.
 *  2. Answer `scan` and `apply-plan` requests from the panel.
 *  3. Watch for hand-typed answers and report them for learning.
 *
 * Everything else — deciding, persisting — happens in the service worker.
 */

import {
  buildPlan,
  planSummary,
  selectDecisions,
  tallyDecisions,
  type Decision,
  type FieldDescriptor,
  type FillPlan,
  type PageScan,
} from "@quill/core";
import type { ExtensionRequest, ExtensionResponse, FillReport } from "../shared/protocol.js";
import { applyDecision, locateField, markFilled, readValue } from "./fill.js";
import { detectCompany, detectPageRole, scanPage, siteKey } from "./scan.js";
import { mountPanel, type PanelApi } from "../ui/panel-mount.js";
import { startLearningWatcher } from "./observe.js";

/* --------------------------------------------------------------- lifecycle */

/**
 * Guard against double injection. Chrome re-runs `content_scripts` after an
 * extension reload, and two panels on one page is confusing.
 */
const GUARD = "__quillContentScript";
interface QuillWindow extends Window {
  [GUARD]?: boolean;
}

if (!(window as QuillWindow)[GUARD]) {
  (window as QuillWindow)[GUARD] = true;
  main();
}

function main(): void {
  /** Live elements from the most recent scan, keyed by descriptor ref. */
  let lastElements = new Map<string, HTMLElement>();
  let lastScan: PageScan | undefined;
  let lastPlan: FillPlan | undefined;
  /** Values we proposed for each ref, so we never "learn" our own output. */
  const proposed = new Map<string, string[]>();

  /**
   * True while we are writing into the page.
   *
   * The filler dispatches real `input`/`change`/`blur` events because that is
   * what React and Vue listen for, and the learning watcher listens for the same
   * events. This flag is a coarse guard; the precise guard is `proposed`, which
   * records each value *before* it is written so the watcher can recognise our
   * own output by value rather than by timing.
   */
  let filling = false;

  /*
   * Panel API is created synchronously by the mount below, but the message
   * listener is registered after it so `respond` is always available.
   */
  let panel: PanelApi;

  function doScan(): PageScan {
    const result = scanPage();
    lastScan = result.scan;
    lastElements = result.elements;
    return result.scan;
  }

  /** Turn a plan into work, writing into the page. */
  async function applyPlan(plan: FillPlan, refs?: string[]): Promise<FillReport> {
    const decisions = selectDecisions(plan, {
      includeReady: true,
      includeReview: true,
      ...(refs ? { refs } : {}),
    });
    const outcomes: FillReport["outcomes"] = [];

    filling = true;
    try {
      await applyAll(decisions, outcomes);
    } finally {
      /*
       * Released immediately. An earlier version held this flag for 700ms to
       * catch the debounced events, which also swallowed any genuine edit the
       * person made in the first moment after a fill — exactly the moment they
       * are most likely to correct something. The value-based check below has no
       * such window.
       */
      filling = false;
    }

    const report: FillReport = {
      filled: outcomes.filter((outcome) => outcome.ok).length,
      failed: outcomes.filter((outcome) => !outcome.ok).length,
      skipped: plan.decisions.length - decisions.length,
      outcomes,
    };
    panel.setReport(report);
    return report;
  }

  async function applyAll(
    decisions: ReturnType<typeof selectDecisions>,
    outcomes: FillReport["outcomes"],
  ): Promise<void> {
    for (const decision of decisions) {
      /*
       * Resolve the element from the scan's own map, never by position.
       *
       * `buildPlan` sorts decisions so that selects are written before
       * textareas and identity before essays — that ordering is about what to
       * fill first. It destroys any correspondence between a decision's
       * position and an element's position, and an earlier version used the
       * plan's index against a fresh `querySelectorAll`, which shifted every
       * value onto the neighbouring field. The map removes the question: the
       * element is the one the descriptor was read from.
       */
      const element = resolveElement(decision.ref);

      if (!element) {
        outcomes.push({ ref: decision.ref, ok: false, label: decision.label, reason: "页面上找不到该字段" });
        continue;
      }

      /*
       * Record the value as proposed *before* writing it.
       *
       * The write dispatches real events, and the learning watcher may observe
       * them before this loop resumes. Registering the value first means the
       * watcher's "don't learn our own output" check matches by value, with no
       * timing dependency at all.
       */
      if (decision.value?.text) {
        const previous = proposed.get(decision.ref) ?? [];
        proposed.set(decision.ref, [...previous, decision.value.text]);
      }

      const outcome = await applyDecision(decision, element);
      outcomes.push({
        ref: decision.ref,
        ok: outcome.ok,
        label: decision.label,
        ...(outcome.actual ? { actual: outcome.actual } : {}),
        ...(outcome.reason ? { reason: outcome.reason } : {}),
      });

      if (outcome.ok) {
        markFilled(element, true);
      } else {
        markFilled(element, false);
      }
    }
  }

  /**
   * Find the live element for a ref.
   *
   * Preference order: the element captured at scan time (fast, exact), then a
   * fresh lookup for frameworks that replaced the node, then a label search as a
   * last resort. `locateField` handles the latter two.
   */
  function resolveElement(ref: string): HTMLElement | undefined {
    const captured = lastElements.get(ref);
    if (captured && document.contains(captured)) return captured;
    const recovered = locateField(ref, -1, [], "");
    if (recovered) {
      lastElements.set(ref, recovered);
      return recovered;
    }
    return undefined;
  }

  /* ------------------------------------------------------------- messaging */

  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!isRequest(message)) return false;
    void respond(message, sendResponse);
    return true;
  });

  async function respond(
    request: ExtensionRequest,
    sendResponse: (response: ExtensionResponse) => void,
  ): Promise<void> {
    try {
      switch (request.type) {
        case "scan": {
          const scan = doScan();
          sendResponse({ ok: true, type: "scan", scan });
          return;
        }

        case "build-plan": {
          const plan = await buildPlanViaWorker(request.scan);
          sendResponse({ ok: true, type: "build-plan", plan });
          return;
        }

        case "apply-plan": {
          const report = await applyPlan(request.plan, request.refs);
          sendResponse({ ok: true, type: "apply-plan", report });
          return;
        }

        case "get-state":
        case "save-profile":
        case "import-document":
        case "save-memory":
        case "delete-memory":
        case "save-settings":
        case "analyze-jd":
        case "tailor":
        case "save-record":
        case "delete-record":
        case "record-submission":
        case "observe":
        case "set-position":
          // These belong to the worker; forward and relay.
          sendResponse((await chrome.runtime.sendMessage(request)) as ExtensionResponse);
          return;

        default:
          sendResponse({ ok: false, error: "不支持的消息类型" });
      }
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : "未知错误" });
    }
  }

  async function buildPlanViaWorker(scan: PageScan): Promise<FillPlan> {
    const response = (await chrome.runtime.sendMessage({
      type: "build-plan",
      scan,
      pageRole: detectPageRole(),
      company: detectCompany(),
    } satisfies ExtensionRequest)) as ExtensionResponse;

    if (!response.ok || response.type !== "build-plan") {
      throw new Error(response.ok ? "意外的响应类型" : response.error);
    }
    return response.plan;
  }

  /** The panel asked for a fresh plan (the common path). */
  async function refreshPlan(): Promise<FillPlan> {
    const scan = doScan();
    const plan = await buildPlanViaWorker(scan);
    lastPlan = plan;
    return plan;
  }

  /* ----------------------------------------------------------------- panel */

  panel = mountPanel({
    stylesheetUrl: chrome.runtime.getURL("styles/content.css"),
    siteKey: siteKey(),
    title: document.title,
    onRefresh: async () => {
      const plan = await refreshPlan();
      return { plan, summary: planSummary(plan) };
    },
    onApply: async (refs) => {
      const plan = lastPlan ?? (await refreshPlan());
      return applyPlan(plan, refs);
    },
    onRecord: async () => {
      const plan = lastPlan;
      if (!plan) return { ok: false };
      const response = (await chrome.runtime.sendMessage({
        type: "record-submission",
        plan,
        company: detectCompany(),
        role: detectPageRole(),
        url: window.location.href,
      } satisfies ExtensionRequest)) as ExtensionResponse;
      return { ok: response.ok };
    },
    onLearn: async (decision: Decision, value: string) => {
      // The person corrected a value in the panel; remember it as confirmed.
      const field = lastScan?.fields.find((item) => item.ref === decision.ref);
      if (!field) return { ok: false };
      const response = (await chrome.runtime.sendMessage({
        type: "observe",
        field,
        value,
        proposedValues: proposed.get(decision.ref) ?? [],
      } satisfies ExtensionRequest)) as ExtensionResponse;
      return { ok: response.ok && response.type === "observe" && response.learned };
    },
  });

  /* ------------------------------------------------------------- learning */

  startLearningWatcher({
    getScan: () => lastScan,
    getProposed: (ref) => proposed.get(ref) ?? [],
    isFilling: () => filling,
    isEnabled: async () => {
      const response = (await chrome.runtime.sendMessage({ type: "get-state" } satisfies ExtensionRequest)) as ExtensionResponse;
      return response.ok && response.type === "get-state" ? response.state.settings.learnFromUserInput : false;
    },
    onObserved: async (field: FieldDescriptor, value: string) => {
      await chrome.runtime.sendMessage({
        type: "observe",
        field,
        value,
        proposedValues: proposed.get(field.ref) ?? [],
      } satisfies ExtensionRequest);
    },
  });

  /* Keyboard shortcut from the worker. */
  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (typeof message === "object" && message !== null && (message as { type?: string }).type === "scan-requested") {
      void panel.open();
      void refreshPlan().then((plan) => panel.setPlan(plan, planSummary(plan)));
    }
    return false;
  });

  /* Expose a tiny hook for the popup, which asks the active tab to scan. */
  void (async () => {
    const response = (await chrome.runtime.sendMessage({ type: "get-state" } satisfies ExtensionRequest)) as ExtensionResponse;
    if (response.ok && response.type === "get-state" && response.state.settings.autoScan) {
      // A short delay lets client-rendered forms finish hydrating.
      window.setTimeout(() => {
        void refreshPlan()
          .then((plan) => panel.setPlan(plan, planSummary(plan)))
          .catch(() => {
            // No profile yet, or the page has no form: stay quiet.
          });
      }, 900);
    }
  })();

  // Re-scan when the DOM changes structurally (SPA step transitions).
  let mutationTimer: number | undefined;
  const observer = new MutationObserver((records) => {
    const structural = records.some((record) => {
      if (record.type !== "childList") return false;
      const target = record.target;
      if (!(target instanceof Element)) return false;
      // Ignore our own panel.
      if (target.closest("quill-panel")) return false;
      return target.querySelector("input,select,textarea,[contenteditable]") !== null;
    });
    if (!structural) return;
    window.clearTimeout(mutationTimer);
    mutationTimer = window.setTimeout(() => {
      void refreshPlan()
        .then((plan) => panel.setPlan(plan, planSummary(plan)))
        .catch(() => {});
    }, 700);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Exposed for the popup's "扫描当前页面" button through a DOM event.
  document.addEventListener("quill:scan", () => {
    void panel.open();
    void refreshPlan().then((plan) => {
      panel.setPlan(plan, planSummary(plan));
      panel.setTally(tallyDecisions(plan.decisions));
    });
  });

}

function isRequest(value: unknown): value is ExtensionRequest {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

export type { Decision, FieldDescriptor };
