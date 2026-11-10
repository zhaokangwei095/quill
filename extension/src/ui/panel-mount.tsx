/**
 * Mounting the panel into a host page.
 *
 * The panel lives in a **closed-over open shadow root** attached to a custom
 * element. Three reasons:
  1. Style isolation. A job site's `* { box-sizing: content-box }` or its own
     `.title` rule must not be able to reach the panel, and the panel's rules
     must not leak out and restyle the form we are helping fill.
  2. `z-index` safety. The host element is a normal element in the page, so no
     `!important` contest is needed; a very high z-index on one element wins.
  3. It survives SPA re-renders of the page body, because the host is appended
     to `<html>` rather than to a framework-managed container.
 *
 * Drag behaviour is intentionally asymmetric: a pointer drag moves the panel on
 * desktop, and on touch devices the panel is a fixed bottom sheet that cannot be
 * dragged — dragging a floating card with a thumb is hostile.
 */

import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import type { Decision, FillPlan, PageScan } from "@quill/core";
import type { FillReport, SectionPlanItem } from "../shared/protocol.js";
import { captureException } from "../shared/logger.js";
import { Panel, type FocusFieldResult } from "./panel.js";

export interface PanelApi {
  setPlan: (plan: FillPlan, summary: string) => void;
  setScan: (scan: PageScan) => void;
  setTally: (tally: Record<string, number>) => void;
  setReport: (report: FillReport) => void;
  setSections: (sections: SectionPlanItem[]) => void;
  setBusy: (busy: boolean) => void;
  setError: (error: string | undefined) => void;
  open: () => Promise<void>;
  close: () => void;
  destroy: () => void;
}

export interface MountOptions {
  /** chrome-extension:// URL of the panel stylesheet. */
  stylesheetUrl: string;
  siteKey: string;
  title: string;
  onRefresh: () => Promise<{ plan: FillPlan; summary: string }>;
  onApply: (refs?: string[]) => Promise<FillReport>;
  onRecord: () => Promise<{ ok: boolean }>;
  onDiagnostics: () => Promise<{ ok: boolean; message?: string }>;
  onLearn: (decision: Decision, value: string) => Promise<{ ok: boolean }>;
  /** Write one hand-typed answer straight into the page. */
  onFillField: (decision: Decision, value: string) => Promise<{ ok: boolean; reason?: string }>;
  /** Current manifest version, so the active content script is visible. */
  version: string;
  /** Scroll, focus and temporarily mark the source-page field. */
  onFocusField: (decision: Decision) => FocusFieldResult;
}

const HOST_TAG = "quill-panel";
const EDGE_MARGIN = 20;

/** The panel's own width. Kept in sync with `--q-panel-width` in panel.css. */
const PANEL_WIDTH = 376;

/**
 * The tallest the panel will grow, matching `max-height` in panel.css.
 *
 * Both numbers are duplicated from CSS because the drag clamp needs them
 * synchronously, before layout. Measuring the element would mean rendering,
 * measuring, then re-rendering on every pointer move.
 */
const PANEL_MAX_HEIGHT = 704;

export function mountPanel(options: MountOptions): PanelApi {
  // Reuse an existing host if the script somehow ran twice.
  const existing = document.querySelector<HTMLElement>(HOST_TAG);
  const host = existing ?? document.createElement(HOST_TAG);
  if (!existing) {
    host.style.cssText = "all:initial;position:fixed;inset:0;width:0;height:0;pointer-events:none;z-index:2147483000;";
    document.documentElement.appendChild(host);
  }

  const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });

  // The stylesheet is fetched as a <link> inside the shadow root, which keeps
  // the extension's CSP intact and avoids injecting a <style> string.
  if (!shadow.querySelector("link[data-quill-styles]")) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = options.stylesheetUrl;
    link.dataset.quillStyles = "true";
    shadow.appendChild(link);
  }

  const container = document.createElement("div");
  container.style.cssText = "position:fixed;inset:0;pointer-events:none;";
  shadow.appendChild(container);

  const root: Root = createRoot(container);

  /* --------------------------------------------------------------- layout */

  const isTouch = window.matchMedia("(pointer: coarse)").matches;
  const initial = defaultPosition();
  let position = { ...initial };
  let dragged = false;
  let dragOffset = { x: 0, y: 0 };

  /** Dock to the right edge, vertically centred, with a safe-area inset. */
  function defaultPosition(): { x: number; y: number } {
    return {
      x: Math.max(EDGE_MARGIN, window.innerWidth - PANEL_WIDTH - EDGE_MARGIN),
      y: Math.max(EDGE_MARGIN, Math.round(window.innerHeight * 0.12)),
    };
  }

  function clamp(next: { x: number; y: number }): { x: number; y: number } {
    /*
     * Clamp so the whole panel stays inside the viewport. On a narrow window the
     * available width can be less than the panel's width; `Math.max` then pins it
     * to the left edge rather than allowing a negative range, which would push the
     * panel off-screen and make it unreachable.
     *
     * Note the order: the *upper* bound is computed first as
     * `max(margin, innerWidth - width - margin)`, so when the viewport is too
     * narrow the lower bound (margin) wins.
     */
    const availableWidth = Math.max(EDGE_MARGIN, window.innerWidth - PANEL_WIDTH - EDGE_MARGIN);
    const availableHeight = Math.max(
      EDGE_MARGIN,
      window.innerHeight - Math.min(PANEL_MAX_HEIGHT, window.innerHeight - EDGE_MARGIN * 2) - EDGE_MARGIN,
    );
    return {
      x: Math.min(Math.max(next.x, EDGE_MARGIN), availableWidth),
      y: Math.min(Math.max(next.y, EDGE_MARGIN), availableHeight),
    };
  }

  /* ----------------------------------------------------------------- state */

  let state = {
    plan: undefined as FillPlan | undefined,
    scan: undefined as PageScan | undefined,
    summary: "",
    report: undefined as FillReport | undefined,
    sections: [] as SectionPlanItem[],
    busy: false,
    error: undefined as string | undefined,
    collapsed: false,
    ignored: new Set<string>(),
  };

  function render(): void {
    root.render(
      createElement(Panel, {
        plan: state.plan,
        scan: state.scan,
        summary: state.summary,
        report: state.report,
        sections: state.sections,
        version: options.version,
        busy: state.busy,
        error: state.error,
        collapsed: state.collapsed,
        position,
        ignored: state.ignored,
        onRefresh: () => {
          void refresh();
        },
        onApply: (refs) => {
          void apply(refs);
        },
        onLearn: (decision, value) => {
          void learn(decision, value);
        },
        onFocusField: (decision) => options.onFocusField(decision),
        onRecord: () => options.onRecord(),
        onDiagnostics: () => options.onDiagnostics(),
        onCollapse: (collapsed) => {
          state = { ...state, collapsed };
          render();
        },
        onClose: () => {
          // Closing hides the panel for this page view only; a reload brings it
          // back, and "在此网站不再显示" is the persistent option.
          host.remove();
          root.unmount();
        },
        onHide: () => {
          void chrome.runtime.sendMessage({ type: "hide-site", siteKey: options.siteKey });
          host.remove();
          root.unmount();
        },
        onOpenWorkbench: () => {
          void chrome.runtime.sendMessage({ type: "open-workbench" });
        },
        onDragStart: isTouch ? () => {} : beginDrag,
        onToggleIgnore: (decision) => {
          const next = new Set(state.ignored);
          if (next.has(decision.key)) next.delete(decision.key);
          else next.add(decision.key);
          state = { ...state, ignored: next };
          render();
        },
      }),
    );
  }

  /* ---------------------------------------------------------------- actions */

  async function refresh(): Promise<void> {
    state = { ...state, busy: true, error: undefined };
    render();
    try {
      const { plan, summary } = await options.onRefresh();
      state = { ...state, plan, summary, busy: false };
    } catch (error) {
      captureException("panel", "panel.refresh.failed", error);
      state = {
        ...state,
        busy: false,
        error: error instanceof Error ? error.message : "识别失败",
      };
    }
    render();
  }

  async function apply(refs?: string[]): Promise<void> {
    state = { ...state, busy: true, error: undefined, report: undefined };
    render();
    try {
      const report = await options.onApply(refs);
      state = { ...state, busy: false, report };
    } catch (error) {
      captureException("panel", "panel.apply.failed", error);
      state = { ...state, busy: false, error: error instanceof Error ? error.message : "填写失败" };
    }
    render();
  }

  async function learn(decision: Decision, value: string): Promise<void> {
    /*
     * Typing an answer for a field the profile does not cover is a request to
     * answer that field, not merely to store it. So the whole operation is:
     * remember it, write it into the page, then re-scan so the panel reflects
     * the page and the new memory entry.
     *
     * Remembering comes first: if the page has re-rendered and the field is
     * temporarily unreachable, the answer the person just typed should still
     * survive.
     */
    state = { ...state, busy: true, error: undefined };
    render();

    let remembered = false;
    try {
      remembered = (await options.onLearn(decision, value)).ok;
    } catch {
      // Remembering is best-effort; filling the page is the immediate intent.
    }

    const filled = await options.onFillField(decision, value).catch((error: unknown) => {
      captureException("panel", "panel.fillField.failed", error, { label: decision.label });
      return { ok: false, reason: "没能写入页面，可以手动填写这一项" };
    });

    /*
     * Reflect the value locally before the re-scan. This keeps the row stable
     * if learning is switched off — a scan has no source for a value that was
     * deliberately not stored, and would flip the row back to “missing”.
     */
    if (state.plan) {
      const decisions = state.plan.decisions.map((item) =>
        item.ref === decision.ref
          ? {
              ...item,
              status: "ready" as const,
              value: { text: value },
              confidence: 1,
              evidence: {
                source: "memory" as const,
                detail: remembered ? "已填入页面，并记住这条内容" : "已填入页面",
              },
              rationale: remembered ? "已记住你填写的内容" : "使用你刚刚输入的内容",
            }
          : item,
      );
      state = { ...state, plan: { ...state.plan, decisions } };
    }

    if (!filled.ok) {
      state = { ...state, busy: false, error: filled.reason ?? "没能写入页面，可以手动填写这一项" };
      render();
      return;
    }

    try {
      const { plan, summary } = await options.onRefresh();
      state = { ...state, plan, summary, busy: false };
    } catch {
      // The value is already in the page and reflected locally; scanning is best-effort.
      state = { ...state, busy: false };
    }
    render();
  }

  /* ------------------------------------------------------------------ drag */

  function beginDrag(event: React.PointerEvent): void {
    // Don't start a drag from a button inside the header.
    const target = event.target as HTMLElement;
    if (target.closest("button")) return;
    dragged = false;
    dragOffset = { x: event.clientX - position.x, y: event.clientY - position.y };

    const onMove = (moveEvent: PointerEvent): void => {
      const dx = Math.abs(moveEvent.clientX - (dragOffset.x + position.x));
      const dy = Math.abs(moveEvent.clientY - (dragOffset.y + position.y));
      if (dx > 3 || dy > 3) dragged = true;
      position = clamp({
        x: moveEvent.clientX - dragOffset.x,
        y: moveEvent.clientY - dragOffset.y,
      });
      render();
    };

    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      // Persist the position so the panel appears where the person put it.
      void chrome.runtime.sendMessage({ type: "set-position", x: position.x, y: position.y });
      if (!dragged) {
        // A click on the header (not a drag) toggles collapse.
        state = { ...state, collapsed: true };
        render();
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    event.preventDefault();
  }

  /* ------------------------------------------------------------- lifecycle */

  const onResize = (): void => {
    position = clamp(position);
    render();
  };
  window.addEventListener("resize", onResize);

  render();

  return {
    setPlan(plan, summary) {
      state = { ...state, plan, summary };
      render();
    },
    setScan(scan) {
      state = { ...state, scan };
      render();
    },
    setTally() {
      render();
    },
    setReport(report) {
      state = { ...state, report };
      render();
    },
    setSections(sections) {
      state = { ...state, sections };
      render();
    },
    setBusy(busy) {
      state = { ...state, busy };
      render();
    },
    setError(error) {
      state = { ...state, error };
      render();
    },
    async open() {
      state = { ...state, collapsed: false };
      render();
    },
    close() {
      host.remove();
      root.unmount();
    },
    destroy() {
      window.removeEventListener("resize", onResize);
      root.unmount();
      host.remove();
    },
  };
}
