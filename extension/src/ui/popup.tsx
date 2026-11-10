/**
 * The toolbar popup.
 *
 * Scope, deliberately narrow: it is what you reach for while looking at a job
 * page. It answers four questions and then gets out of the way —
 *   · is this page a form I can help with?
 *   · what am I about to do here?
 *   · what did I already do?
 *   · where is everything else?
 *
 * The full workspace lives in the workbench; the popup links to it rather than
 * duplicating it.
 */

import { useCallback, useMemo, useState, type JSX } from "react";
import { createRoot } from "react-dom/client";
import { STAGE_LABELS } from "@quill/core";
import type { ExtensionResponse } from "../shared/protocol.js";
import { useExtensionState, useToast } from "./hooks.js";
import { relativeTime, send } from "./shared.js";
import {
  ArrowRight,
  Book,
  CheckCircle,
  ChevronRight,
  Compass,
  QuillMark,
  Settings,
  Sparkle,
  Table,
  Upload,
  Warning,
} from "./icons.js";

function Popup(): JSX.Element {
  const { state, loading, error, reload } = useExtensionState();
  const { toast, show } = useToast();
  const [scanning, setScanning] = useState(false);

  const profile = state?.profile;
  const hasProfile = Boolean(profile?.identity.fullName || profile?.contact.email);

  /** Ask the active tab to scan, then open the panel there. */
  const scanActiveTab = useCallback(async () => {
    setScanning(true);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id === undefined) throw new Error("找不到当前标签页");
      const tabId = tab.id;

      // The content script listens for a DOM event; sending a tab message is
      // more reliable because it survives the script being injected late.
      const request = async (): Promise<ExtensionResponse | undefined> =>
        (await chrome.tabs.sendMessage(tabId, { type: "scan" })) as ExtensionResponse | undefined;

      let response: ExtensionResponse | undefined;
      try {
        response = await request();
      } catch {
        /*
         * Edge withholds host access by default and offers “单击时”: until the
         * person clicks the action, no content script is running on the page.
         * The click that opened this popup grants activeTab, so inject the same
         * bundle now and retry once. The bundle has its own double-injection
         * guard, so this is safe even if another copy is already present.
         */
        try {
          await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
          response = await request();
        } catch {
          throw new Error(
            "无法在当前页面识别表单。如果是 Chrome 内置页面或 PDF，请换一个网页试试。",
          );
        }
      }
      if (!response || !response.ok) {
        throw new Error(
          "无法在当前页面识别表单。如果是 Chrome 内置页面或 PDF，请换一个网页试试。",
        );
      }
      // Bring the panel forward in that tab.
      await chrome.tabs.sendMessage(tabId, { type: "focus-panel" }).catch(() => {});
      window.close();
    } catch (cause) {
      show(cause instanceof Error ? cause.message : "识别失败", "error");
    } finally {
      setScanning(false);
    }
  }, [show]);

  const recent = useMemo(() => (state?.records ?? []).slice(0, 3), [state]);
  const memoryCount = state?.memory.length ?? 0;
  const reportCount = state?.reports.length ?? 0;

  const openWorkbench = (view?: string): void => {
    void chrome.tabs.create({
      url: chrome.runtime.getURL(`pages/workbench.html${view ? `#${view}` : ""}`),
    });
    window.close();
  };

  if (loading) {
    return (
      <div className="q-popup-root">
        <Head />
        <div className="q-popup-body">
          {[0, 1, 2].map((index) => (
            <div key={index} className="q-skeleton" style={{ height: "3rem", marginBottom: "0.5rem" }} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="q-popup-root">
      <Head onSettings={() => void chrome.runtime.openOptionsPage()} />

      <div className="q-popup-body quill-scroll">
        {error && (
          <div className="q-notice" data-tone="error">
            <Warning />
            <span>{error}</span>
          </div>
        )}

        {!hasProfile && (
          <button type="button" className="q-item" onClick={() => openWorkbench("resume")} style={{ width: "100%" }}>
            <span className="q-item-mark" data-tone="accent">
              <Upload size={14} />
            </span>
            <span className="q-item-body">
              <span className="q-item-title">先上传一份简历</span>
              <span className="q-item-meta">Quill 需要你的资料才能识别和填写网申表单</span>
            </span>
            <span className="q-item-trailing">
              <ChevronRight />
            </span>
          </button>
        )}

        {hasProfile && (
          <>
            <div className="q-stats">
              <Stat value={memoryCount} label="记住的填写" />
              <Stat value={reportCount} label="岗位分析" />
              <Stat value={state?.records.length ?? 0} label="投递记录" />
            </div>

            <button
              type="button"
              className="q-item"
              onClick={() => void scanActiveTab()}
              disabled={scanning}
              style={{ width: "100%" }}
            >
              <span className="q-item-mark" data-tone="accent">
                <Sparkle size={14} />
              </span>
              <span className="q-item-body">
                <span className="q-item-title">{scanning ? "正在识别当前页面…" : "识别当前页面的表单"}</span>
                <span className="q-item-meta">
                  {profile?.preference.position
                    ? `当前意向岗位：${profile.preference.position}`
                    : "扫描后会先给出方案，由你确认再填写"}
                </span>
              </span>
              <span className="q-item-trailing">
                <ArrowRight />
              </span>
            </button>

            <div className="q-divider" style={{ margin: "0.5rem 0" }} />

            <div className="q-list">
              <MenuItem
                icon={<Book size={14} />}
                tone="purple"
                title="工作台"
                meta="简历、岗位润色、投递台账"
                onClick={() => openWorkbench()}
              />
              <MenuItem
                icon={<Compass size={14} />}
                tone="accent"
                title="岗位分析"
                meta={reportCount > 0 ? `${reportCount} 份分析结果` : "粘贴 JD，生成针对性建议"}
                onClick={() => openWorkbench("tailor")}
              />
              <MenuItem
                icon={<Table size={14} />}
                tone="green"
                title="投递台账"
                meta={state?.records.length ? `${state.records.length} 条记录` : "还没有投递记录"}
                onClick={() => openWorkbench("ledger")}
              />
            </div>

            {recent.length > 0 && (
              <>
                <div className="q-divider" style={{ margin: "0.5rem 0" }} />
                <div className="q-section-head" style={{ padding: "0.25rem 0.75rem" }}>
                  <span className="q-section-title">最近投递</span>
                </div>
                <div className="q-list">
                  {recent.map((record) => (
                    <div className="q-item" key={record.id}>
                      <span className="q-item-mark">{record.company.slice(0, 1)}</span>
                      <span className="q-item-body">
                        <span className="q-item-title">
                          {record.company} · {record.role}
                        </span>
                        <span className="q-item-meta">
                          {STAGE_LABELS[record.stage]} · {relativeTime(record.updatedAt)}
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>

      {toast && (
        <div className="q-toast-region">
          <div className="q-toast">{toast.text}</div>
        </div>
      )}
    </div>
  );
}

function Head({ onSettings }: { onSettings?: () => void }): JSX.Element {
  return (
    <div className="q-popup-head">
      <div className="q-brand">
        <span className="q-brand-mark">
          <QuillMark size={15} />
        </span>
        <span className="q-brand-name">Quill</span>
      </div>
      <div className="q-grow" />
      {onSettings && (
        <button type="button" className="q-icon-btn" onClick={onSettings} aria-label="打开设置">
          <Settings size={15} />
        </button>
      )}
    </div>
  );
}

function Stat({ value, label }: { value: number; label: string }): JSX.Element {
  return (
    <div className="q-stat">
      <div className="q-stat-value">{value}</div>
      <div className="q-stat-label">{label}</div>
    </div>
  );
}

function MenuItem({
  icon,
  tone,
  title,
  meta,
  onClick,
}: {
  icon: JSX.Element;
  tone: string;
  title: string;
  meta: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button type="button" className="q-item" onClick={onClick}>
      <span className="q-item-mark" data-tone={tone}>
        {icon}
      </span>
      <span className="q-item-body">
        <span className="q-item-title">{title}</span>
        <span className="q-item-meta">{meta}</span>
      </span>
      <span className="q-item-trailing">
        <ChevronRight />
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------- mount */

const container = document.getElementById("root");
if (container) createRoot(container).render(<Popup />);
