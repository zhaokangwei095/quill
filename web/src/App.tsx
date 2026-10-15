/**
 * The workbench shell.
 *
 * Navigation is a hash route rather than a router library: there are five
 * views, the extension opens them by hash, and nothing here needs nested
 * layouts or data loaders. A dependency that size has to earn its place.
 */

import { useCallback, useEffect, useState, type JSX } from "react";
import { ledgerInsights } from "@quill/core";
import { useAppearance, useToastQueue, useWorkbench } from "./state.js";
import { Home } from "./views/Home.js";
import { ResumeView } from "./views/Resume.js";
import { TailorView } from "./views/Tailor.js";
import { LedgerView } from "./views/Ledger.js";
import { MemoryView } from "./views/Memory.js";
import { SettingsView } from "./views/Settings.js";
import {
  Book,
  Brain,
  Chart,
  Lock,
  QuillMark,
  Settings as SettingsIcon,
  Sparkle,
  Table,
  Warning,
} from "./icons.js";

/** The five destinations, in the order a person uses them. */
const ROUTES = [
  { id: "home", label: "总览", icon: Chart },
  { id: "resume", label: "简历", icon: Book },
  { id: "tailor", label: "岗位", icon: Sparkle },
  { id: "ledger", label: "台账", icon: Table },
  { id: "memory", label: "记忆", icon: Brain },
] as const;

type RouteId = (typeof ROUTES)[number]["id"] | "settings";

function currentRoute(): RouteId {
  const hash = window.location.hash.replace(/^#\/?/, "").split("/")[0] ?? "";
  if (hash === "settings") return "settings";
  const match = ROUTES.find((route) => route.id === hash);
  return match?.id ?? "home";
}

export function App(): JSX.Element {
  const [route, setRoute] = useState<RouteId>(currentRoute);
  const { state, loading, error, setPending } = useWorkbench();
  const { toast, show } = useToastQueue();
  useAppearance();
  void setPending;

  useEffect(() => {
    const onHash = (): void => setRoute(currentRoute());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const navigate = useCallback((next: RouteId) => {
    window.location.hash = `#/${next}`;
    setRoute(next);
  }, []);

  const insights = ledgerInsights(state.records);
  const activeApplications = state.records.filter(
    (record) => record.stage !== "rejected" && record.stage !== "withdrawn",
  ).length;

  return (
    <div className="q-app">
      <nav className="q-rail" aria-label="主导航">
        <div className="q-rail-mark" title="Quill">
          <QuillMark />
        </div>

        {ROUTES.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              className="q-rail-item"
              aria-current={route === item.id ? "page" : undefined}
              onClick={() => navigate(item.id)}
            >
              <span className="q-rail-icon">
                <Icon size={18} />
              </span>
              <span className="q-rail-label">{item.label}</span>
              {item.id === "ledger" && activeApplications > 0 && (
                <span className="q-rail-badge">{activeApplications}</span>
              )}
            </button>
          );
        })}

        <div className="q-rail-spacer" />

        <button
          type="button"
          className="q-rail-item"
          aria-current={route === "settings" ? "page" : undefined}
          onClick={() => navigate("settings")}
        >
          <span className="q-rail-icon">
            <SettingsIcon size={18} />
          </span>
          <span className="q-rail-label">设置</span>
        </button>
      </nav>

      <main className="q-main">
        <TopBar
          route={route}
          company={state.profile?.preference.position}
          insights={insights.length}
        />

        <div className="q-scroll">
          {error && (
            <div className="q-page" style={{ paddingBottom: 0 }}>
              <div className="q-insight" data-kind="warning">
                <Warning size={16} />
                <div>
                  <div className="q-insight-title">读取本地数据时出错</div>
                  <div className="q-insight-detail">{error}</div>
                </div>
              </div>
            </div>
          )}

          {loading ? (
            <div className="q-page">
              {[0, 1, 2].map((index) => (
                <div
                  key={index}
                  className="q-skeleton"
                  style={{ height: "6rem", marginBottom: "var(--s-4)" }}
                />
              ))}
            </div>
          ) : (
            <>
              {route === "home" && <Home onNavigate={(next) => navigate(next as RouteId)} />}
              {route === "resume" && <ResumeView onNavigate={(next) => navigate(next as RouteId)} onToast={show} />}
              {route === "tailor" && <TailorView onNavigate={(next) => navigate(next as RouteId)} onToast={show} />}
              {route === "ledger" && <LedgerView onToast={show} />}
              {route === "memory" && <MemoryView onToast={show} />}
              {route === "settings" && <SettingsView onToast={show} />}
            </>
          )}
        </div>
      </main>

      {toast && (
        <div className="q-toast-region">
          <div className="q-toast">{toast.text}</div>
        </div>
      )}
    </div>
  );
}

function TopBar({
  route,
  company,
  insights,
}: {
  route: RouteId;
  company?: string;
  insights: number;
}): JSX.Element {
  const { state } = useWorkbench();
  const subtitle =
    route === "home"
      ? "今天可以从这里开始"
      : route === "resume"
        ? state.profile?.identity.fullName
          ? `${state.profile.identity.fullName} 的资料`
          : "还没有上传简历"
        : route === "tailor"
          ? state.analyses.length > 0
            ? `${state.analyses.length} 个岗位已分析`
            : "粘贴一份岗位描述"
          : route === "ledger"
            ? state.records.length > 0
              ? `${state.records.length} 条投递记录`
              : "还没有投递记录"
            : route === "memory"
              ? state.memory.length > 0
                ? `${state.memory.length} 条记忆`
                : "还没有记下任何内容"
              : "偏好与数据";

  return (
    <header className="q-topbar">
      <div>
        <div className="q-topbar-title">
          {route === "home"
            ? "工作台"
            : route === "resume"
              ? "简历"
              : route === "tailor"
                ? "岗位匹配"
                : route === "ledger"
                  ? "投递台账"
                  : route === "memory"
                    ? "记忆库"
                    : "设置"}
        </div>
        <div className="q-topbar-sub">{subtitle}</div>
      </div>
      <div className="q-grow" />
      {company && (
        <span className="q-chip q-chip-accent" title="当前简历的意向岗位">
          意向：{company}
        </span>
      )}
      {insights > 0 && route !== "home" && (
        <span className="q-chip q-chip-orange" title="台账中有需要留意的事项">
          {insights} 项提醒
        </span>
      )}
      <span className="q-chip q-chip-neutral" title="所有数据都保存在本设备">
        <Lock size={11} />
        本地保存
      </span>
    </header>
  );
}

