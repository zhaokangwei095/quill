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
  experienceKindFromLabel,
  planSummary,
  sanitizePageUrl,
  selectDecisions,
  tallyDecisions,
  type Decision,
  type DiagnosticPage,
  type DiagnosticSnapshot,
  type FieldDescriptor,
  type FillPlan,
  type PageScan,
} from "@quill/core";
import type {
  ExtensionRequest,
  ExtensionResponse,
  FillReport,
  SectionPlanItem,
} from "../shared/protocol.js";
import { applyDecision, locateField, markFilled, readValue } from "./fill.js";
import { detectCompany, detectPageRole, scanPage, siteKey } from "./scan.js";
import { addSectionRows, findSections, hasUserContent, MAX_ROWS_PER_SECTION } from "./sections.js";
import {
  captureException,
  exportDiagnostics,
  installGlobalErrorCapture,
  logSoon,
  newOperationId,
  saveDiagnosticSnapshot,
} from "../shared/logger.js";
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
  installGlobalErrorCapture("content");

  /** Live elements from the most recent scan, keyed by descriptor ref. */
  let lastElements = new Map<string, HTMLElement>();
  let lastScan: PageScan | undefined;
  let lastPlan: FillPlan | undefined;
  let lastReport: FillReport | undefined;
  let lastAddedSections: Array<{ label: string; rows: number }> = [];
  /**
   * Empty sections this page can open, with the number of profile entries that
   * justify each one. Recomputed after every scan; consumed only on “填写”.
   */
  let sectionPlan: SectionPlanItem[] = [];
  /** Suppresses the structural re-scan while rows are being opened. */
  let preparingSections = false;
  /** Values we proposed for each ref, so we never "learn" our own output. */
  const proposed = new Map<string, string[]>();
  const focusTimers = new WeakMap<HTMLElement, number>();
  const focusStyles = new WeakMap<HTMLElement, {
    outline: { value: string; priority: string };
    outlineOffset: { value: string; priority: string };
    transition: { value: string; priority: string };
  }>();

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

  /**
   * A value-free picture of the last operation.
   *
   * This is what makes a diagnostic bundle reproducible: the developer can run
   * the same labels, keys and confidences through `buildPlan` offline. Values
   * are deliberately absent — not redacted after the fact, never collected.
   */
  function diagnosticSnapshot(): DiagnosticSnapshot {
    const page = sanitizePageUrl(window.location.href);
    return {
      page: {
        siteKey: page.siteKey || lastScan?.siteKey || siteKey(),
        url: page.url,
        title: document.title.slice(0, 120),
      },
      ...(lastScan
        ? {
            scan: {
              fieldCount: lastScan.fields.length,
              ...(lastScan.ats ? { ats: lastScan.ats } : {}),
              fields: lastScan.fields.slice(0, 200).map((field) => ({
                label: field.label.slice(0, 120),
                ...(field.key ? { key: field.key } : {}),
                ...(field.keyConfidence !== undefined ? { confidence: field.keyConfidence } : {}),
                labelSource: field.labelSource,
                section: field.section,
                kind: field.kind,
                ...(field.framework ? { framework: field.framework } : {}),
                required: field.required,
                ...(field.repeatIndex !== undefined ? { repeatIndex: field.repeatIndex } : {}),
              })),
            },
          }
        : {}),
      ...(lastPlan
        ? {
            plan: {
              tally: { ...lastPlan.tally } as Record<string, number>,
              notes: lastPlan.notes.slice(0, 30).map((note) => note.slice(0, 240)),
              decisions: lastPlan.decisions.slice(0, 300).map((decision) => ({
                label: decision.label.slice(0, 120),
                key: decision.key,
                status: decision.status,
                confidence: decision.confidence,
                evidence: decision.evidence.source,
              })),
            },
          }
        : {}),
      ...(sectionPlan.length > 0 || lastAddedSections.length > 0
        ? {
            sections: {
              empty: sectionPlan.map((item) => ({
                key: item.key,
                label: item.label,
                existing: item.existing,
                toAdd: item.toAdd,
              })),
              added: lastAddedSections,
            },
          }
        : {}),
      ...(lastReport
        ? {
            fill: {
              filled: lastReport.filled,
              failed: lastReport.failed,
              skipped: lastReport.skipped,
              outcomes: lastReport.outcomes.slice(0, 200).map((outcome) => ({
                label: outcome.label,
                ok: outcome.ok,
                ...(outcome.reason ? { reason: outcome.reason } : {}),
              })),
              ...(lastReport.prepared ? { prepared: lastReport.prepared } : {}),
            },
          }
        : {}),
    };
  }

  /** Turn a plan into work, writing into the page. */
  async function applyPlan(
    plan: FillPlan,
    refs?: string[],
    prepared: Array<{ label: string; rows: number }> = [],
  ): Promise<FillReport> {
    const decisions = selectDecisions(plan, {
      includeReady: true,
      includeReview: true,
      ...(refs ? { refs } : {}),
    });
    const outcomes: FillReport["outcomes"] = [];
    const opId = newOperationId("fill");
    const siteKey = lastScan?.siteKey;

    logSoon(
      "content",
      "info",
      "fill.started",
      { decisions: decisions.length, prepared: prepared.length },
      { opId, ...(siteKey ? { siteKey } : {}) },
    );

    filling = true;
    try {
      await applyAll(decisions, outcomes);
    } catch (error) {
      captureException("content", "fill.failed", error, { decisions: decisions.length }, { opId, ...(siteKey ? { siteKey } : {}) });
      throw error;
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
      ...(prepared.length > 0 ? { prepared } : {}),
    };
    lastReport = report;
    logSoon(
      "content",
      report.failed > 0 ? "warn" : "info",
      "fill.completed",
      {
        filled: report.filled,
        failed: report.failed,
        skipped: report.skipped,
        ...(prepared.length > 0 ? { prepared } : {}),
      },
      { opId, ...(siteKey ? { siteKey } : {}) },
    );
    void saveDiagnosticSnapshot(diagnosticSnapshot());
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

  /** Bring a source-page field into view and mark it briefly. */
  function focusField(decision: Decision): { ok: boolean; message: string } {
    const started = performance.now();
    const element = resolveElement(decision.ref);
    const resolvedAt = performance.now();
    if (!element) {
      const message = "找不到网页上的这个字段，请先重新识别";
      panel.setError(message);
      return { ok: false, message };
    }
    if ((element as HTMLInputElement).disabled || element.getAttribute("aria-disabled") === "true") {
      const message = "网页上的这个字段当前不可操作";
      panel.setError(message);
      return { ok: false, message };
    }

    // A manual answer should arrive at the target immediately; smooth scrolling
    // made the action feel delayed and could leave the panel over the target.
    element.scrollIntoView({ behavior: "instant", block: "center", inline: "nearest" });
    const scrolledAt = performance.now();
    try {
      element.focus({ preventScroll: true });
    } catch {
      element.focus();
    }
    const focusedAt = performance.now();

    const message =
      decision.kind === "select" || decision.kind === "combobox" || decision.kind === "radio-group" ||
      decision.kind === "checkbox" || decision.kind === "checkbox-group"
        ? "已定位到网页控件，请直接在页面中选择。"
        : decision.kind === "file"
          ? "已定位到网页中的文件控件，请在页面中选择文件。"
          : "已定位到网页输入框，请直接在页面中填写。";
    let original = focusStyles.get(element);
    if (!original) {
      original = {
        outline: {
          value: element.style.getPropertyValue("outline"),
          priority: element.style.getPropertyPriority("outline"),
        },
        outlineOffset: {
          value: element.style.getPropertyValue("outline-offset"),
          priority: element.style.getPropertyPriority("outline-offset"),
        },
        transition: {
          value: element.style.getPropertyValue("transition"),
          priority: element.style.getPropertyPriority("transition"),
        },
      };
      focusStyles.set(element, original);
    }

    const activeTimer = focusTimers.get(element);
    if (activeTimer !== undefined) window.clearTimeout(activeTimer);
    element.style.setProperty("outline", "3px solid #0071e3", "important");
    element.style.setProperty("outline-offset", "3px", "important");
    element.style.setProperty("transition", "outline-color 160ms ease-out, outline-offset 160ms ease-out", "important");
    element.dataset.quillFocusTarget = "true";

    const timer = window.setTimeout(() => {
      const restore = (property: "outline" | "outline-offset" | "transition", previous: { value: string; priority: string }) => {
        if (previous.value) element.style.setProperty(property, previous.value, previous.priority);
        else element.style.removeProperty(property);
      };
      restore("outline", original.outline);
      restore("outline-offset", original.outlineOffset);
      restore("transition", original.transition);
      delete element.dataset.quillFocusTarget;
      focusStyles.delete(element);
      focusTimers.delete(element);
    }, 2_200);
    focusTimers.set(element, timer);
    const markedAt = performance.now();
    logSoon("content", "info", "manual-focus.completed", {
      resolveMs: Math.round((resolvedAt - started) * 10) / 10,
      scrollMs: Math.round((scrolledAt - resolvedAt) * 10) / 10,
      focusMs: Math.round((focusedAt - scrolledAt) * 10) / 10,
      highlightMs: Math.round((markedAt - focusedAt) * 10) / 10,
      totalMs: Math.round((markedAt - started) * 10) / 10,
      kind: decision.kind,
    });
    return { ok: true, message };
  }

  /**
   * Write one value the person typed into the panel into the live page.
   *
   * The decision may be `missing`, so it has no value of its own; the caller
   * supplies the text. Recording it in `proposed` before the write keeps the
   * learning watcher from mistaking this for an independent user edit — the
   * answer is already being stored explicitly by the caller.
   */
  async function fillField(
    decision: Decision,
    value: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    const element = resolveElement(decision.ref);
    if (!element) {
      return { ok: false, reason: "页面上找不到这个字段，请点「重新识别」后再试" };
    }

    const previous = proposed.get(decision.ref) ?? [];
    proposed.set(decision.ref, [...previous, value]);

    filling = true;
    let outcome;
    try {
      outcome = await applyDecision({ ...decision, status: "ready", value: { text: value } }, element);
    } finally {
      filling = false;
    }
    markFilled(element, outcome.ok);

    if (!outcome.ok) {
      return { ok: false, reason: outcome.reason ?? "没能写入这个字段，可以手动填写" };
    }

    logSoon("content", "info", "field.filled", {
      label: decision.label.slice(0, 120),
      key: decision.key,
      source: "panel",
    });
    return { ok: true };
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

        case "get-profile-dossiers":
        case "get-state":
        case "section-targets":
        case "log-event":
        case "diagnostics-snapshot":
        case "diagnostics-export":
        case "diagnostics-clear":
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
      captureException(
        "content",
        "message.failed",
        error,
        { request: request.type },
        { ...(lastScan?.siteKey ? { siteKey: lastScan.siteKey } : {}) },
      );
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
    const started = performance.now();
    const scan = doScan();
    const plan = await buildPlanViaWorker(scan);
    lastPlan = plan;
    await updateSectionPlan();

    logSoon(
      "content",
      "info",
      "scan.completed",
      {
        fieldCount: scan.fields.length,
        durationMs: Math.round(performance.now() - started),
        ...(scan.ats ? { ats: scan.ats } : {}),
        emptySections: sectionPlan.length,
      },
      { siteKey: scan.siteKey },
    );
    logSoon(
      "content",
      "info",
      "plan.built",
      { tally: plan.tally, notes: plan.notes.length },
      { siteKey: scan.siteKey },
    );
    void saveDiagnosticSnapshot(diagnosticSnapshot());
    return plan;
  }

  /**
   * Notice which repeatable sections are empty and could be opened.
   *
   * This is a read-only step: it asks the worker for profile counts and tells
   * the panel what “填写” would add. No click happens here.
   */
  async function updateSectionPlan(): Promise<void> {
    try {
      /*
       * Find every repeatable section with an add control, not only the empty
       * ones. A page can already show one blank row and still need more (the
       * résumé may hold four projects); treating “has one row” as “complete”
       * left three projects unfillable.
       */
      const sections = findSections();
      if (sections.length === 0) {
        sectionPlan = [];
        panel.setSections([]);
        return;
      }

      const experienceSection = sections.find((section) => section.key === "experience");
      const experienceKind = experienceSection ? experienceKindFromLabel(experienceSection.label) : undefined;
      const response = (await chrome.runtime.sendMessage({
        type: "section-targets",
        hiringTrack: lastScan?.hiringTrack,
        ...(experienceKind ? { experienceKind } : {}),
        pageRole: detectPageRole(),
        company: detectCompany(),
        ...(lastScan?.jobContext ? { jobContext: lastScan.jobContext } : {}),
      } satisfies ExtensionRequest)) as ExtensionResponse;

      if (!response.ok || response.type !== "section-targets") {
        sectionPlan = [];
        panel.setSections([]);
        return;
      }

      const targets = response.targets;
      const scan = lastScan;
      sectionPlan = sections
        .map((section) => {
          const existing = existingRows(scan, section.key);
          const desired = desiredRows(section.key, existing, targets, scan?.educationPolicy);
          /*
           * Never add rows on top of content the person already entered. A
           * blank placeholder row is fine; a filled row is an explicit answer
           * and appending profile rows would duplicate it.
           */
          const blocked = hasUserContent(section.container);
          const toAdd = blocked ? 0 : Math.max(0, Math.min(desired, MAX_ROWS_PER_SECTION) - existing);
          const experienceKindMismatch =
            section.key === "experience" && targets.experienceTotal > 0 && targets.experience === 0;
          return {
            key: section.key,
            label: section.label,
            desired: Math.min(desired, MAX_ROWS_PER_SECTION),
            existing,
            toAdd,
            ...(experienceKindMismatch ? { reason: "experience-kind-mismatch" as const } : {}),
          };
        })
        /*
         * Keep sections the profile cannot fill (`desired: 0`) so the panel can
         * name them instead of silently looking complete. Drop a section that is
         * already satisfied — there is nothing to tell the person.
         */
        .filter((item) => item.toAdd > 0 || item.desired === 0);
      panel.setSections(sectionPlan);
    } catch {
      // Section discovery is an enhancement; never let it break a scan.
      sectionPlan = [];
      panel.setSections([]);
    }
  }

  /**
   * How many rows the page already renders for a section.
   *
   * `repeatIndex` is the scanner's count of identical fields in a repeatable
   * section: one blank row has index 1 (or no index), four rows reach 4.
   * Boolean controls such as “无实习经历” and “至今” are not row fields and
   * must not be counted, or a page with only the “none” checkbox would look
   * like it already had a row.
   */
  function existingRows(scan: PageScan | undefined, key: "education" | "experience" | "projects"): number {
    if (!scan) return 0;
    const section = key === "projects" ? "project" : key;
    const rowFields = scan.fields.filter(
      (field) =>
        field.section === section &&
        field.kind !== "checkbox" &&
        field.kind !== "radio-group",
    );
    if (rowFields.length === 0) return 0;
    return Math.max(1, ...rowFields.map((field) => field.repeatIndex ?? 1));
  }

  /**
   * How many rows the page should end up with.
   *
   * Education is the one section where more is not always better. Tencent asks
   * for the current/highest record in a single block and offers “添加学历” only
   * for a dual degree; opening a bachelor's row there is wrong. A page that
   * explicitly asks for the full history gets every record; an ambiguous page
   * fills only the rows already on screen.
   */
  function desiredRows(
    key: "education" | "experience" | "projects",
    existing: number,
    targets: Record<"education" | "experience" | "projects", number>,
    policy: PageScan["educationPolicy"],
  ): number {
    const wanted = targets[key] ?? 0;
    if (key !== "education") return wanted;

    if (policy === "current-only") return wanted > 0 ? 1 : 0;
    if (policy === "full-history") return wanted;
    // Unknown: fill the rows that exist; open one only when the section is
    // completely empty, so the highest record still gets a place.
    if (existing > 0) return Math.min(wanted, existing);
    return wanted > 0 ? 1 : 0;
  }

  /**
   * Open the sections the person was told about, then rebuild the plan.
   *
   * Rebuilding matters: the new rows contain fields the previous scan never
   * saw, so reusing the old plan would fill the old four fields and leave the
   * freshly opened ones empty.
   */
  async function prepareSections(): Promise<Array<{ label: string; rows: number }>> {
    // `desired: 0` and already-satisfied items are explanatory only; there is
    // nothing to click.
    const planned = sectionPlan.filter((item) => item.toAdd > 0);
    if (planned.length === 0) return [];
    const prepared: Array<{ label: string; rows: number }> = [];
    const opId = newOperationId("sections");
    const siteKey = lastScan?.siteKey;
    lastAddedSections = [];
    logSoon(
      "content",
      "info",
      "sections.prepare.started",
      { planned: planned.map((item) => ({ label: item.label, rows: item.toAdd })) },
      { opId, ...(siteKey ? { siteKey } : {}) },
    );

    preparingSections = true;
    try {
      for (const item of planned) {
        const rows = await addSectionRows(item.key, item.toAdd);
        if (rows > 0) {
          prepared.push({ label: item.label, rows });
          logSoon(
            "content",
            "info",
            "sections.added",
            { label: item.label, rows },
            { opId, ...(siteKey ? { siteKey } : {}) },
          );
        }
      }
      lastAddedSections = prepared;

      if (prepared.length > 0) {
        // Give the framework a beat to mount the last row before reading the DOM.
        await new Promise((resolve) => window.setTimeout(resolve, 250));
        /*
         * Keep the guard set through the rebuild: the mutations caused by the
         * added rows are still arriving, and a concurrent observer refresh
         * would race this one and could hand `onApply` an older plan.
         */
        await refreshPlan();
      }
    } catch (error) {
      captureException(
        "content",
        "sections.prepare.failed",
        error,
        { planned: planned.map((item) => item.label) },
        { opId, ...(siteKey ? { siteKey } : {}) },
      );
      throw error;
    } finally {
      preparingSections = false;
    }

    return prepared;
  }

  /* ----------------------------------------------------------- diagnostics */

  /**
   * Copy a redacted diagnostic bundle for a bug report.
   *
   * The bundle is built in the worker so it includes events from every context,
   * then copied here because the click happened on this page. Clipboard access
   * can fail on insecure origins, so the fallback is a hidden textarea and
   * `execCommand`, which still works in more places than the async API.
   */
  async function copyDiagnosticBundle(): Promise<{ ok: boolean; message?: string }> {
    const bundle = await exportDiagnostics();
    if (!bundle) {
      return { ok: false, message: "生成诊断信息失败。可以到工作台「设置 → 诊断与日志」重试。" };
    }

    const text = JSON.stringify(bundle, null, 2);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        logSoon("content", "info", "diagnostics.copied", { events: bundle.events.length, bytes: text.length });
        return { ok: true };
      }
    } catch {
      // Fall through to the legacy path.
    }

    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0;";
      document.body.appendChild(area);
      area.select();
      const copied = document.execCommand("copy");
      area.remove();
      if (copied) {
        logSoon("content", "info", "diagnostics.copied", { events: bundle.events.length, bytes: text.length });
        return { ok: true };
      }
    } catch {
      // Fall through to the failure message.
    }

    return { ok: false, message: "剪贴板不可用。请到工作台「设置 → 诊断与日志」导出诊断包。" };
  }

  /* ----------------------------------------------------------------- panel */

  panel = mountPanel({
    stylesheetUrl: chrome.runtime.getURL("styles/content.css"),
    siteKey: siteKey(),
    title: document.title,
    version: chrome.runtime.getManifest().version,
    onFocusField: focusField,
    onRefresh: async () => {
      const plan = await refreshPlan();
      return { plan, summary: planSummary(plan) };
    },
    onApply: async (refs) => {
      /*
       * Opening empty sections belongs to a full fill, not to a per-row “填这项”.
       * The person asked to fill everything; adding the rows first is how the
       * fields they expect to exist come into being. It still happens only
       * after an explicit click, never during a scan.
       */
      const prepared = refs ? [] : await prepareSections();
      const plan = lastPlan ?? (await refreshPlan());
      return applyPlan(plan, refs, prepared);
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
    onDiagnostics: copyDiagnosticBundle,
    onFillField: fillField,
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
    onFieldCommitted: async (field, value) => {
      try {
        const refreshed = await refreshPlan();
        const decisions = refreshed.decisions.map((decision) =>
          decision.ref === field.ref && decision.status === "missing"
            ? {
                ...decision,
                status: "ready" as const,
                value: { text: value },
                confidence: 1,
                evidence: { source: "none" as const, detail: "网页当前已填写；本次未写入资料库" },
                rationale: "保留你刚才在网页中填写的内容",
              }
            : decision,
        );
        const plan = { ...refreshed, decisions, tally: tallyDecisions(decisions) };
        lastPlan = plan;
        panel.setPlan(plan, planSummary(plan));
      } catch {
        // Scanning after a page edit is best-effort; it must not block typing.
      }
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
    // Our own row clicks cause exactly the kind of mutation this observer
    // watches for; refreshing mid-preparation would race the fill.
    if (!structural || preparingSections) return;
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
