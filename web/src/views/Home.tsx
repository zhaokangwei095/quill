/**
 * The overview.
 *
 * Answers one question — "what should I do right now?" — in the order the work
 * actually happens: get a resume in, target a role, then track what came back.
 * Metrics are shown only once there is something to measure; an empty dashboard
 * with four zeroes is worse than a short list of next steps.
 */

import { useMemo, type JSX } from "react";
import {
  formatRelative,
  ledgerInsights,
  nextSteps,
  upcomingDeadlines,
} from "@quill/core";
import { useWorkbench } from "../state.js";
import {
  ArrowRight,
  Book,
  Chart,
  CheckCircle,
  Clock,
  Compass,
  Info,
  Sparkle,
  Table,
  Upload,
  Warning,
} from "../icons.js";

export function Home({ onNavigate }: { onNavigate: (route: string) => void }): JSX.Element {
  const { state } = useWorkbench();

  const steps = useMemo(
    () =>
      nextSteps({
        ...(state.profile ? { profile: state.profile } : {}),
        documents: state.documents,
        analyses: state.analyses,
        reports: state.reports,
        records: state.records,
        settings: state.settings,
        memoryCount: state.memory.length,
      }),
    [state],
  );

  const insights = useMemo(() => ledgerInsights(state.records), [state.records]);
  const deadlines = useMemo(() => upcomingDeadlines(state.records), [state.records]);

  const metrics = useMemo(() => {
    const submitted = state.records.filter((record) => record.appliedAt !== undefined).length;
    const active = state.records.filter(
      (record) => !["rejected", "withdrawn", "draft"].includes(record.stage),
    ).length;
    const interviews = state.records.filter((record) => record.stage.startsWith("interview")).length;
    return { submitted, active, interviews };
  }, [state.records]);

  const hasHistory = state.records.length > 0;

  return (
    <div className="q-page">
      <header className="q-page-head q-reveal" style={{ "--i": 0 } as React.CSSProperties}>
        <h1 className="q-page-title">
          {state.profile?.identity.fullName
            ? `${state.profile.identity.fullName}，今天从这里开始。`
            : "先把你的资料放进来。"}
        </h1>
        <p className="q-page-lead">
          Quill 把你的简历、目标岗位和投递进度放在一起。上传一次简历，之后每次网申都能直接取用。
        </p>
      </header>

      {steps.length > 0 && (
        <section className="q-block q-reveal" style={{ "--i": 1 } as React.CSSProperties}>
          <div className="q-block-head">
            <div>
              <h2 className="q-block-title">接下来</h2>
              <p className="q-block-sub">按这个顺序做，每一步都会解锁后面的功能。</p>
            </div>
          </div>
          <div className="q-grid-cards">
            {steps.slice(0, 4).map((step, index) => (
              <button
                key={step.title}
                type="button"
                className="q-card-lg q-reveal"
                style={{ textAlign: "left", "--i": index + 2 } as React.CSSProperties}
                onClick={() => onNavigate(routeForAction(step.action))}
              >
                <div className="q-between" style={{ marginBottom: "var(--s-3)" }}>
                  <span className="q-item-mark" data-tone={toneForAction(step.action)}>
                    {iconForAction(step.action)}
                  </span>
                  <ArrowRight size={15} style={{ color: "var(--ink-quaternary)" }} />
                </div>
                <div style={{ fontSize: "var(--text-title)", fontWeight: 600, letterSpacing: "-0.01em" }}>
                  {step.title}
                </div>
                <p className="q-sub" style={{ marginTop: "var(--s-2)", lineHeight: "var(--leading-sub)" }}>
                  {step.detail}
                </p>
              </button>
            ))}
          </div>
        </section>
      )}

      {hasHistory && (
        <section className="q-block q-reveal" style={{ "--i": 5 } as React.CSSProperties}>
          <div className="q-grid q-grid-3">
            <Metric value={metrics.submitted} label="已投递" />
            <Metric value={metrics.active} label="进行中" />
            <Metric value={metrics.interviews} label="面试阶段" />
          </div>
        </section>
      )}

      {insights.length > 0 && (
        <section className="q-block">
          <div className="q-block-head">
            <div>
              <h2 className="q-block-title">值得留意</h2>
              <p className="q-block-sub">根据你的投递记录整理出来的，不是建议而是事实。</p>
            </div>
          </div>
          <div className="q-grid">
            {insights.map((insight, index) => (
              <div className="q-insight q-reveal" data-kind={insight.kind} key={index} style={{ "--i": index } as React.CSSProperties}>
                {insight.kind === "warning" ? <Warning size={16} /> : insight.kind === "success" ? <CheckCircle size={16} /> : <Info size={16} />}
                <div>
                  <div className="q-insight-title">{insight.title}</div>
                  <div className="q-insight-detail">{insight.detail}</div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {deadlines.length > 0 && (
        <section className="q-block">
          <div className="q-block-head">
            <div>
              <h2 className="q-block-title">临近的待办</h2>
            </div>
            <button type="button" className="q-btn q-btn-ghost" onClick={() => onNavigate("ledger")}>
              查看台账
            </button>
          </div>
          <div className="q-group">
            {deadlines.slice(0, 4).map((record) => (
              <div className="q-group-row" key={record.id}>
                <Clock size={15} style={{ color: "var(--orange)", flex: "none" }} />
                <div className="q-grow">
                  <div className="q-strong">{record.nextAction?.what}</div>
                  <div className="q-cap">
                    {record.company} · {record.role}
                  </div>
                </div>
                <span className="q-chip q-chip-orange">
                  {record.nextAction?.dueAt ? formatRelative(record.nextAction.dueAt) : ""}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {state.reports.length > 0 && (
        <section className="q-block">
          <div className="q-block-head">
            <div>
              <h2 className="q-block-title">最近分析的岗位</h2>
            </div>
            <button type="button" className="q-btn q-btn-ghost" onClick={() => onNavigate("tailor")}>
              全部岗位
            </button>
          </div>
          <div className="q-group">
            {state.reports.slice(0, 5).map((report) => {
              const analysis = state.analyses.find((item) => item.id === report.jdAnalysisId);
              return (
                <button
                  type="button"
                  className="q-group-row q-group-row-interactive"
                  key={report.id}
                  onClick={() => onNavigate("tailor")}
                  style={{ width: "100%", textAlign: "left" }}
                >
                  <span className="q-item-mark" data-tone="accent">
                    <Compass size={14} />
                  </span>
                  <span className="q-grow">
                    <span className="q-strong" style={{ display: "block" }}>
                      {analysis?.role ?? "未命名岗位"}
                    </span>
                    <span className="q-cap">
                      {analysis?.company ? `${analysis.company} · ` : ""}
                      覆盖 {Math.round(report.coverage * 100)}%
                    </span>
                  </span>
                  <ArrowRight size={15} style={{ color: "var(--ink-quaternary)" }} />
                </button>
              );
            })}
          </div>
        </section>
      )}

      {!state.profile && (
        <section className="q-block">
          <div className="q-card-lg" style={{ display: "flex", gap: "var(--s-4)", alignItems: "flex-start" }}>
            <Info size={18} style={{ color: "var(--ink-tertiary)", flex: "none", marginTop: "0.125rem" }} />
            <div>
              <div style={{ fontWeight: 600 }}>Quill 需要安装浏览器扩展才能自动填写</div>
              <p className="q-sub" style={{ marginTop: "var(--s-2)", lineHeight: "var(--leading-sub)" }}>
                这个工作台负责整理你的资料和目标岗位。真正在网申页面识别与填写的是浏览器扩展，
                两边共享同一份数据，所以在这里改完简历，扩展里立刻生效。
              </p>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

function Metric({ value, label }: { value: number; label: string }): JSX.Element {
  return (
    <div className="q-metric">
      <div className="q-metric-value">{value}</div>
      <div className="q-metric-label">{label}</div>
    </div>
  );
}

function routeForAction(action: string): string {
  switch (action) {
    case "upload-resume":
    case "edit-profile":
      return "resume";
    case "new-analysis":
    case "tailor":
      return "tailor";
    case "ledger":
      return "ledger";
    case "memory":
      return "memory";
    default:
      return "resume";
  }
}

function toneForAction(action: string): string {
  switch (action) {
    case "upload-resume":
      return "accent";
    case "new-analysis":
    case "tailor":
      return "purple";
    case "ledger":
      return "green";
    case "memory":
      return "orange";
    default:
      return "neutral";
  }
}

function iconForAction(action: string): JSX.Element {
  switch (action) {
    case "upload-resume":
      return <Upload size={16} />;
    case "edit-profile":
      return <Book size={16} />;
    case "new-analysis":
    case "tailor":
      return <Sparkle size={16} />;
    case "ledger":
      return <Table size={16} />;
    case "memory":
      return <Chart size={16} />;
    default:
      return <Book size={16} />;
  }
}

