/**
 * The tailoring view.
 *
 * The interaction is a two-step pipeline shown as one screen: paste a posting,
 * get an analysis; then generate a tailored version of your resume against it.
 * The tailored output is presented as *suggestions with provenance* — every
 * rewritten bullet shows the original it came from and why it changed — because
 * a resume the person cannot defend in an interview is worse than an untailored
 * one.
 */

import { useCallback, useMemo, useState, type JSX } from "react";
import {
  analyzeJd,
  tailorResume,
  createRecord,
  type GapItem,
  type JdAnalysis,
  type TailorReport,
  type TailoredSection,
} from "@quill/core";
import { useWorkbench } from "../state.js";
import { getStore } from "../data/store.js";
import { copyText } from "../data/format.js";
import { relativeTime } from "../data/format.js";
import {
  ArrowRight,
  Check,
  CheckCircle,
  ChevronRight,
  Compass,
  Copy,
  Download,
  Info,
  Plus,
  Sparkle,
  Table,
  Trash,
  Warning,
  X,
} from "../icons.js";

type Toast = (text: string, tone?: "neutral" | "success" | "error") => void;

export function TailorView({
  onNavigate,
  onToast,
}: {
  onNavigate: (route: string) => void;
  onToast: Toast;
}): JSX.Element {
  const { state, reload, patch } = useWorkbench();
  const [text, setText] = useState("");
  const [company, setCompany] = useState("");
  const [busy, setBusy] = useState<string | undefined>();
  const [activeAnalysis, setActiveAnalysis] = useState<string | undefined>();
  const [activeReport, setActiveReport] = useState<string | undefined>();

  const hasProfile = Boolean(state.profile?.identity.fullName || state.profile?.contact.email);

  /** Analyse the pasted posting. */
  const runAnalysis = useCallback(async () => {
    if (!text.trim()) return;
    setBusy("正在解析岗位描述…");
    try {
      const analysis = await getStore().saveAnalysis(text, company ? { company } : {});
      await reload();
      setActiveAnalysis(analysis.id);
      setText("");
      onToast(`已解析：${analysis.role}`, "success");
    } catch (error) {
      onToast(error instanceof Error ? error.message : "解析失败", "error");
    } finally {
      setBusy(undefined);
    }
  }, [company, onToast, reload, text]);

  /** Produce the tailored report for an analysis. */
  const runTailor = useCallback(
    async (analysis: JdAnalysis) => {
      if (!state.profile) {
        onToast("请先上传简历", "error");
        return;
      }
      setBusy("正在对照岗位重写简历…");
      try {
        const report = tailorResume(state.profile, analysis, {
          ...(analysis.company ? { company: analysis.company } : {}),
          maxBullets: 3,
        });
        await getStore().saveReport(report);
        await reload();
        setActiveReport(report.id);
        onToast("已生成针对性建议", "success");
      } catch (error) {
        onToast(error instanceof Error ? error.message : "生成失败", "error");
      } finally {
        setBusy(undefined);
      }
    },
    [onToast, reload, state.profile],
  );

  /** Copy a plain-text resume built from the tailored sections. */
  const exportReport = useCallback(
    async (report: TailorReport) => {
      const analysis = state.analyses.find((item) => item.id === report.jdAnalysisId);
      const lines: string[] = [report.headline, ""];
      for (const section of report.sections) {
        lines.push(section.heading);
        if (section.meta) lines.push(section.meta);
        for (const bullet of section.bullets) lines.push(`· ${bullet.text}`);
        lines.push("");
      }
      if (analysis) {
        lines.push("—— 岗位要求对照 ——");
        for (const gap of report.gaps) lines.push(`[${gap.verdict}] ${gap.requirement}`);
      }
      const content = lines.join("\n");
      const ok = await copyText(content);
      onToast(ok ? "已复制到剪贴板，可直接粘贴到简历文档" : "复制失败，请手动选择", ok ? "success" : "error");
    },
    [onToast, state.analyses],
  );

  const activeAnalysisData = useMemo(
    () => state.analyses.find((item) => item.id === activeAnalysis),
    [activeAnalysis, state.analyses],
  );
  const activeReportData = useMemo(
    () => state.reports.find((item) => item.id === activeReport),
    [activeReport, state.reports],
  );

  return (
    <div className="q-page">
      <header className="q-page-head q-reveal">
        <h1 className="q-page-title">针对一个具体岗位，重写你的简历。</h1>
        <p className="q-page-lead">
          Quill 从岗位描述里提取要求，对照你的经历排出优先级，并给出可读的改写建议。
          它只重排与重述你已经写下的事实，不会替你添加任何没有的经历。
        </p>
      </header>

      {!hasProfile && (
        <div className="q-insight" data-kind="warning" style={{ marginBottom: "var(--s-6)" }}>
          <Warning size={16} />
          <div>
            <div className="q-insight-title">需要先有一份简历</div>
            <div className="q-insight-detail">
              岗位分析可以先做，但生成针对性建议需要简历资料。
              <button
                type="button"
                className="q-btn q-btn-ghost q-btn-sm"
                style={{ padding: "0 0.25rem", height: "auto" }}
                onClick={() => onNavigate("resume")}
              >
                去上传 →
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------ input */}
      <section className="q-block q-reveal" style={{ "--i": 1 } as React.CSSProperties}>
        <div className="q-card-lg">
          <div className="q-field-group" style={{ marginBottom: "var(--s-4)" }}>
            <span className="q-label">岗位描述</span>
            <textarea
              className="q-textarea"
              value={text}
              placeholder={"把招聘启事整段粘贴进来即可，包括岗位职责、任职要求、加分项。\n\n例如：\n任职要求\n1. 本科及以上学历，计算机相关专业\n2. 3 年以上后端开发经验，精通 Go 或 Java\n3. 熟悉 MySQL、Redis、Kafka 等常用中间件"}
              style={{ minHeight: "11rem" }}
              onChange={(event) => setText(event.target.value)}
            />
            <span className="q-hint">
              保留原本的分段与编号，识别会更准确。共 {text.length} 字。
            </span>
          </div>

          <div className="q-toolbar">
            <input
              className="q-input"
              style={{ maxWidth: "16rem" }}
              value={company}
              placeholder="公司名称（可选）"
              onChange={(event) => setCompany(event.target.value)}
            />
            <button
              type="button"
              className="q-btn q-btn-primary"
              onClick={() => void runAnalysis()}
              disabled={!text.trim() || Boolean(busy)}
            >
              <Sparkle size={15} />
              {busy ?? "解析这个岗位"}
            </button>
          </div>
        </div>
      </section>

      {/* --------------------------------------------------------- analyses */}
      {state.analyses.length > 0 && (
        <section className="q-block">
          <div className="q-block-head">
            <div>
              <h2 className="q-block-title">已解析的岗位</h2>
              <p className="q-block-sub">{state.analyses.length} 个岗位。点击任意一个可以查看要求或生成建议。</p>
            </div>
          </div>
          <div className="q-group">
            {state.analyses.map((analysis) => {
              const report = state.reports.find((item) => item.jdAnalysisId === analysis.id);
              const open = activeAnalysis === analysis.id;
              return (
                <div key={analysis.id}>
                  <button
                    type="button"
                    className="q-group-row q-group-row-interactive"
                    style={{ width: "100%", textAlign: "left" }}
                    onClick={() => setActiveAnalysis(open ? undefined : analysis.id)}
                    aria-expanded={open}
                  >
                    <span className="q-item-mark" data-tone="accent">
                      <Compass size={14} />
                    </span>
                    <span className="q-grow">
                      <span className="q-strong" style={{ display: "block" }}>
                        {analysis.role}
                      </span>
                      <span className="q-cap">
                        {analysis.company ? `${analysis.company} · ` : ""}
                        {analysis.requirements.length} 项要求 · {relativeTime(analysis.createdAt)}
                      </span>
                    </span>
                    {report ? (
                      <span className={`q-chip ${report.coverage > 0.6 ? "q-chip-green" : "q-chip-orange"}`}>
                        覆盖 {Math.round(report.coverage * 100)}%
                      </span>
                    ) : (
                      <span className="q-chip q-chip-neutral">未生成建议</span>
                    )}
                    <ChevronRight size={15} style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 200ms" }} />
                  </button>

                  {open && (
                    <div style={{ padding: "0 1rem 1rem 3.25rem" }}>
                      <div className="q-toolbar" style={{ marginBottom: "var(--s-4)" }}>
                        <button
                          type="button"
                          className="q-btn q-btn-primary q-btn-sm"
                          onClick={() => void runTailor(analysis)}
                          disabled={Boolean(busy) || !hasProfile}
                        >
                          <Sparkle size={14} />
                          {report ? "重新生成建议" : "生成针对性建议"}
                        </button>
                        {report && (
                          <>
                            <button type="button" className="q-btn q-btn-outline q-btn-sm" onClick={() => setActiveReport(report.id)}>
                              查看建议
                            </button>
                            <button type="button" className="q-btn q-btn-outline q-btn-sm" onClick={() => void exportReport(report)}>
                              <Copy size={14} />
                              复制文本
                            </button>
                            <button
                              type="button"
                              className="q-btn q-btn-outline q-btn-sm"
                              onClick={() =>
                                void getStore()
                                  .saveRecord(
                                    createRecord({
                                      company: analysis.company ?? company ?? "未填写公司",
                                      role: analysis.role,
                                      ...(analysis.city ? { city: analysis.city } : {}),
                                      source: "工作台",
                                      stage: "draft",
                                    }),
                                  )
                                  .then(() => reload())
                                  .then(() => onToast("已加入投递台账（草稿）", "success"))
                              }
                            >
                              <Table size={14} />
                              加入台账
                            </button>
                          </>
                        )}
                      </div>

                      <RequirementList analysis={analysis} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* ---------------------------------------------------------- reports */}
      {state.reports.length > 0 && (
        <section className="q-block">
          <div className="q-block-head">
            <div>
              <h2 className="q-block-title">针对性建议</h2>
              <p className="q-block-sub">每一条都保留了原文与改写理由，方便你自己判断。</p>
            </div>
          </div>
          <div className="q-group" style={{ marginBottom: "var(--s-4)" }}>
            {state.reports.map((report) => {
              const analysis = state.analyses.find((item) => item.id === report.jdAnalysisId);
              const open = activeReport === report.id;
              return (
                <button
                  type="button"
                  key={report.id}
                  className="q-group-row q-group-row-interactive"
                  style={{ width: "100%", textAlign: "left" }}
                  onClick={() => setActiveReport(open ? undefined : report.id)}
                  aria-expanded={open}
                >
                  <span className="q-item-mark" data-tone={report.coverage > 0.6 ? "green" : "orange"}>
                    {Math.round(report.coverage * 100)}
                  </span>
                  <span className="q-grow">
                    <span className="q-strong" style={{ display: "block" }}>
                      {analysis?.role ?? "未命名岗位"}
                    </span>
                    <span className="q-cap">
                      {analysis?.company ? `${analysis.company} · ` : ""}
                      {report.gaps.filter((gap) => gap.verdict === "gap").length} 项缺口 ·{" "}
                      {relativeTime(report.createdAt)}
                    </span>
                  </span>
                  <ChevronRight size={15} style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 200ms" }} />
                </button>
              );
            })}
          </div>
        </section>
      )}

      {state.analyses.length === 0 && (
        <div className="q-empty">
          <Compass size={22} style={{ color: "var(--ink-quaternary)" }} />
          <span className="q-empty-title">还没有解析过岗位</span>
          <p className="q-empty-body">
            把招聘启事粘贴到上面的输入框，Quill 会提取出要求、判断哪些是硬性条件，并告诉你简历里哪些内容值得放在最前面。
          </p>
        </div>
      )}

      {activeReportData && (
        <ReportSheet
          report={activeReportData}
          analysis={state.analyses.find((item) => item.id === activeReportData.jdAnalysisId)}
          onClose={() => setActiveReport(undefined)}
          onCopy={() => void exportReport(activeReportData)}
        />
      )}
    </div>
  );
}

/* ----------------------------------------------------------- components */

function RequirementList({ analysis }: { analysis: JdAnalysis }): JSX.Element {
  const must = analysis.requirements.filter((requirement) => requirement.mustHave);
  const nice = analysis.requirements.filter((requirement) => !requirement.mustHave && !requirement.soft);
  const soft = analysis.requirements.filter((requirement) => requirement.soft);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-4)" }}>
      {analysis.degrees.length > 0 && (
        <div className="q-toolbar">
          <span className="q-cap">学历要求</span>
          {analysis.degrees.map((degree) => (
            <span className="q-chip q-chip-accent" key={degree}>
              {degree}
            </span>
          ))}
          {analysis.minYears !== undefined && (
            <span className="q-chip q-chip-accent">{analysis.minYears} 年以上经验</span>
          )}
          {analysis.city && <span className="q-chip q-chip-neutral">{analysis.city}</span>}
        </div>
      )}

      {must.length > 0 && (
        <div>
          <div className="q-eyebrow" style={{ marginBottom: "var(--s-2)" }}>
            硬性要求 {must.length}
          </div>
          <ul style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)" }}>
            {must.map((requirement, index) => (
              <li key={index} style={{ display: "flex", gap: "var(--s-2)", fontSize: "var(--text-sub)", lineHeight: "var(--leading-sub)" }}>
                <span style={{ color: "var(--accent)", flex: "none" }}>·</span>
                <span>{requirement.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {nice.length > 0 && (
        <div>
          <div className="q-eyebrow" style={{ marginBottom: "var(--s-2)" }}>
            加分项 {nice.length}
          </div>
          <ul style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)" }}>
            {nice.map((requirement, index) => (
              <li key={index} style={{ display: "flex", gap: "var(--s-2)", fontSize: "var(--text-sub)", color: "var(--ink-secondary)" }}>
                <span style={{ flex: "none" }}>·</span>
                <span>{requirement.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {soft.length > 0 && (
        <div>
          <div className="q-eyebrow" style={{ marginBottom: "var(--s-2)" }}>
            软性要求 {soft.length}
          </div>
          <p className="q-cap">
            {soft.map((requirement) => requirement.text).join("；")}
            <br />
            这类要求无法从简历证明，面试中举例说明即可。
          </p>
        </div>
      )}
    </div>
  );
}

function ReportSheet({
  report,
  analysis,
  onClose,
  onCopy,
}: {
  report: TailorReport;
  analysis: JdAnalysis | undefined;
  onClose: () => void;
  onCopy: () => void;
}): JSX.Element {
  const [tab, setTab] = useState<"resume" | "gaps" | "letter" | "interview">("resume");

  return (
    <>
      <div className="q-scrim" onClick={onClose} />
      <aside className="q-sheet" role="dialog" aria-label="针对性简历建议">
        <header className="q-sheet-head">
          <div className="q-grow">
            <div style={{ fontSize: "var(--text-title)", fontWeight: 600, letterSpacing: "-0.01em" }}>
              {analysis?.role ?? "针对性建议"}
            </div>
            <div className="q-cap">
              {analysis?.company ? `${analysis.company} · ` : ""}覆盖 {Math.round(report.coverage * 100)}%
            </div>
          </div>
          <button type="button" className="q-icon-btn" onClick={onCopy} aria-label="复制文本">
            <Copy size={16} />
          </button>
          <button type="button" className="q-icon-btn" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </header>

        <div className="q-sheet-body quill-scroll">
          <div className="q-card-lg" style={{ marginBottom: "var(--s-5)" }}>
            <div className="q-eyebrow" style={{ marginBottom: "var(--s-2)" }}>
              一句话定位
            </div>
            <p style={{ fontSize: "var(--text-lead)", lineHeight: "var(--leading-lead)", letterSpacing: "var(--tracking-lead)" }}>
              {report.headline}
            </p>
            <p className="q-sub" style={{ marginTop: "var(--s-3)" }}>
              {report.summary}
            </p>
          </div>

          <div className="q-segmented" style={{ marginBottom: "var(--s-5)" }}>
            {(
              [
                ["resume", "简历建议"],
                ["gaps", `缺口 ${report.gaps.filter((gap) => gap.verdict !== "matched").length}`],
                ["letter", "求职信"],
                ["interview", "面试准备"],
              ] as const
            ).map(([id, label]) => (
              <button key={id} type="button" aria-pressed={tab === id} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </div>

          {tab === "resume" && <TailoredSections sections={report.sections} />}
          {tab === "gaps" && <GapList gaps={report.gaps} />}
          {tab === "letter" && (
            <div className="q-prose" style={{ whiteSpace: "pre-wrap" }}>
              {report.coverLetter}
              <button
                type="button"
                className="q-btn q-btn-outline"
                style={{ marginTop: "var(--s-5)" }}
                onClick={() => void copyText(report.coverLetter)}
              >
                <Copy size={15} />
                复制求职信
              </button>
            </div>
          )}
          {tab === "interview" && (
            <div>
              <p className="q-sub" style={{ marginBottom: "var(--s-4)" }}>
                这些问题来自你在岗位要求上的缺口，是面试中最可能被追问的部分。
              </p>
              <ol style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
                {report.interviewPrompts.map((prompt, index) => (
                  <li className="q-bullet" key={index} style={{ display: "flex", gap: "var(--s-3)" }}>
                    <span className="q-step-num">{String(index + 1).padStart(2, "0")}</span>
                    <span>{prompt}</span>
                  </li>
                ))}
                {report.interviewPrompts.length === 0 && <li className="q-sub">没有发现明显的缺口。</li>}
              </ol>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

function TailoredSections({ sections }: { sections: TailoredSection[] }): JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-6)" }}>
      {sections.map((section, index) => (
        <section key={`${section.heading}-${index}`}>
          <div style={{ marginBottom: "var(--s-3)" }}>
            <div style={{ fontSize: "var(--text-title)", fontWeight: 600, letterSpacing: "-0.01em" }}>
              {section.heading}
            </div>
            {section.meta && <div className="q-cap">{section.meta}</div>}
          </div>
          <div>
            {section.bullets.map((bullet, bulletIndex) => (
              <div className="q-bullet" key={bulletIndex}>
                {bullet.source && bullet.source !== bullet.text && (
                  <>
                    <div className="q-bullet-source">
                      <span>原文</span>
                    </div>
                    <div className="q-bullet-original">{bullet.source}</div>
                  </>
                )}
                <div className="q-bullet-tailored">{bullet.text}</div>
                <div className="q-bullet-note">
                  <Check size={11} style={{ verticalAlign: "-1px", marginRight: "0.25rem" }} />
                  {bullet.note}
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function GapList({ gaps }: { gaps: GapItem[] }): JSX.Element {
  return (
    <div>
      <p className="q-sub" style={{ marginBottom: "var(--s-4)" }}>
        这是这份简历与岗位要求之间的真实差距。Quill 不会替你掩盖它们——投递前先知道自己缺什么，比投出去再被淘汰好。
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)" }}>
        {gaps.map((gap, index) => (
          <div className="q-gap" data-verdict={gap.verdict} key={index}>
            <div style={{ flex: "none", marginTop: "0.125rem" }}>
              {gap.verdict === "matched" ? (
                <CheckCircle size={16} style={{ color: "var(--green)" }} />
              ) : gap.verdict === "partial" ? (
                <Info size={16} style={{ color: "var(--orange)" }} />
              ) : (
                <Warning size={16} style={{ color: "var(--red)" }} />
              )}
            </div>
            <div className="q-grow">
              <div className="q-strong" style={{ fontSize: "var(--text-sub)" }}>
                {gap.requirement}
              </div>
              {gap.closest && (
                <div className="q-cap" style={{ marginTop: "0.25rem" }}>
                  简历中的对应内容：{gap.closest}
                </div>
              )}
              <div className="q-cap" style={{ marginTop: "0.25rem", color: "var(--ink-secondary)" }}>
                {gap.suggestion}
              </div>
            </div>
          </div>
        ))}
        {gaps.length === 0 && <p className="q-sub">没有发现明显缺口。</p>}
      </div>
    </div>
  );
}
