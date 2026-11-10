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

import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import {
  DEFAULT_MODEL_CONFIG,
  PROJECT_CATEGORY_LABELS,
  analyzeJd,
  customModelReady,
  createRecord,
  detectJobRole,
  matchDossierForJob,
  type GapItem,
  type JdAnalysis,
  type Profile,
  type ProfileDossier,
  type TailorReport,
  type TailoredSection,
} from "@quill/core";
import { useWorkbench } from "../state.js";
import { getStore } from "../data/store.js";
import { analyzeJdWithUserModel } from "../data/userModel.js";
import { copyText } from "../data/format.js";
import { relativeTime } from "../data/format.js";
import {
  Check,
  CheckCircle,
  ChevronRight,
  Compass,
  Copy,
  Info,
  Sparkle,
  Table,
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
  const { state, reload } = useWorkbench();
  const [text, setText] = useState("");
  const [role, setRole] = useState("");
  const [roleEdited, setRoleEdited] = useState(false);
  const [company, setCompany] = useState("");
  const [busy, setBusy] = useState<string | undefined>();
  const [activeAnalysis, setActiveAnalysis] = useState<string | undefined>();
  const [activeReport, setActiveReport] = useState<string | undefined>();
  const [dossiers, setDossiers] = useState<ProfileDossier[]>([]);

  const hasProfile =
    dossiers.some((dossier) => hasResumeContent(dossier.profile)) ||
    Boolean(state.profile && hasResumeContent(state.profile));
  const customModel = state.settings?.model ?? DEFAULT_MODEL_CONFIG;
  const userModelReady = customModelReady(customModel);

  const onPasteJobText = useCallback((value: string) => {
    setText(value);
    if (roleEdited) return;
    const detected = detectJobRole(value);
    setRole(detected?.value ?? "");
  }, [roleEdited]);

  useEffect(() => {
    let cancelled = false;
    void getStore()
      .loadProfileDossiers()
      .then((items) => {
        if (!cancelled) setDossiers(items);
      })
      .catch(() => {
        // A missing dossier collection falls back to the workbench's current profile.
      });
    return () => {
      cancelled = true;
    };
  }, [state.profile?.updatedAt, state.profiles.length, state.activeProfileId]);

  const jobTextFor = useCallback(
    (analysis: JdAnalysis): string =>
      [
        analysis.role,
        ...analysis.requirements.map((item) => item.text),
        ...analysis.keywords,
        ...analysis.sections.map((section) => section.body),
      ].join("\n"),
    [],
  );

  /** Analyse the pasted posting. */
  const runAnalysis = useCallback(async () => {
    if (!text.trim()) return;
    setBusy(userModelReady ? "正在用自定义模型解析…" : "正在解析岗位描述…");
    const meta = {
      ...(company ? { company } : {}),
      ...(role.trim() ? { role: role.trim() } : {}),
    };
    let notice: string | undefined;
    try {
      let analysis: JdAnalysis;
      if (userModelReady) {
        try {
          analysis = await analyzeJdWithUserModel(text, meta, customModel);
        } catch (error) {
          notice = error instanceof Error ? error.message : "自定义模型解析失败";
          analysis = analyzeJd(text, meta);
        }
      } else {
        analysis = analyzeJd(text, meta);
      }
      const saved = await getStore().saveAnalysisResult(analysis);
      await reload();
      setActiveAnalysis(saved.id);
      setText("");
      setRole("");
      setRoleEdited(false);
      onToast(
        notice
          ? `自定义模型没有完成解析（${notice}），已改用本机规则`
          : userModelReady
            ? `已用自定义模型解析：${saved.role}`
            : `已解析：${saved.role}`,
        notice ? "neutral" : "success",
      );
    } catch (error) {
      onToast(error instanceof Error ? error.message : "解析失败", "error");
    } finally {
      setBusy(undefined);
    }
  }, [company, customModel, onToast, reload, role, text, userModelReady]);

  /** Produce the tailored report from the direction that best matches the job. */
  const runTailor = useCallback(
    async (analysis: JdAnalysis) => {
      if (!hasProfile && !state.profile) {
        onToast("请先上传简历", "error");
        return;
      }
      setBusy("正在匹配方向简历并生成建议…");
      try {
        const report = await getStore().tailor(analysis.id);
        await reload();
        setActiveReport(report.id);
        onToast(
          report.dossierName
            ? `已按岗位匹配「${report.dossierName}」方向简历`
            : "已生成针对性建议",
          "success",
        );
      } catch (error) {
        onToast(error instanceof Error ? error.message : "生成失败", "error");
      } finally {
        setBusy(undefined);
      }
    },
    [hasProfile, onToast, reload, state.profile],
  );

  /** Persist a person-selected experience swap in this tailored report only. */
  const updateReport = useCallback(
    async (report: TailorReport) => {
      try {
        await getStore().saveReport(report);
        await reload();
        onToast("已更新简历建议；资料库与求职信草稿未改动", "success");
      } catch (error) {
        onToast(error instanceof Error ? `保存替换结果失败：${error.message}` : "保存替换结果失败", "error");
        throw error;
      }
    },
    [onToast, reload],
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

  const activeReportData = useMemo(
    () => state.reports.find((item) => item.id === activeReport),
    [activeReport, state.reports],
  );

  return (
    <div className="q-page">
      <header className="q-page-head q-reveal">
        <h1 className="q-page-title">针对一个具体岗位，重写最匹配的那份简历。</h1>
        <p className="q-page-lead">
          粘贴岗位描述后，Quill 会按岗位名称和任职要求，从各方向简历中选出最相关的一份来生成建议；
          每条改写都保留原文与理由，不会添加你没有的经历。
        </p>
      </header>

      {!hasProfile && (
        <div className="q-insight" data-kind="warning" style={{ marginBottom: "var(--s-6)" }}>
          <Warning size={16} />
          <div>
            <div className="q-insight-title">需要先有一份简历</div>
            <div className="q-insight-detail">
              每个方向有自己的简历。可以先解析岗位，但生成建议前需要上传至少一份方向简历。
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
              onChange={(event) => onPasteJobText(event.target.value)}
            />
            <span className="q-hint">
              保留原本的分段与编号，识别会更准确。共 {text.length} 字。
            </span>
          </div>
          <div className="q-field-group" style={{ marginBottom: "var(--s-4)" }}>
            <span className="q-label">岗位名称</span>
            <input
              className="q-input q-job-name-input"
              value={role}
              maxLength={40}
              placeholder="例如：高级后端开发工程师 / 产品经理实习生"
              onChange={(event) => {
                setRole(event.target.value);
                setRoleEdited(Boolean(event.target.value.trim()));
              }}
            />
            <span className="q-hint">
              粘贴上方岗位描述时，若其中有「岗位名称 / 招聘职位」或职位标题，会自动填到这里；也可以手动修改。
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
          {userModelReady && (
            <p className="q-hint" style={{ marginTop: "var(--s-3)" }}>
              岗位描述会发送到你配置的自定义模型 {endpointHost(customModel.baseUrl)} 解析；API Key
              只保存在本机。模型不可用时会自动退回本机规则。
            </p>
          )}
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
              const match = matchForAnalysis(analysis, dossiers, state.activeProfileId, jobTextFor(analysis));
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
                        {match.dossier ? ` · 匹配方向：${match.dossier.name}` : ""}
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
                      {match.dossier ? (
                        <p className="q-hint" style={{ marginBottom: "var(--s-4)" }}>
                          将按岗位自动使用「{match.dossier.name}」方向的简历生成建议；不会改动工作台当前编辑的方向。
                        </p>
                      ) : (
                        <p className="q-hint" style={{ marginBottom: "var(--s-4)" }}>
                          暂无可匹配的方向简历，请先在工作台上传至少一份方向简历。
                        </p>
                      )}

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
                      {report.dossierName ? `${report.dossierName}方向 · ` : ""}
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
          key={activeReportData.id}
          report={activeReportData}
          profile={profileForReport(activeReportData, dossiers, state.profile)}
          analysis={state.analyses.find((item) => item.id === activeReportData.jdAnalysisId)}
          onClose={() => setActiveReport(undefined)}
          onUpdate={updateReport}
          onCopy={(report) => void exportReport(report)}
        />
      )}
    </div>
  );
}

/* ----------------------------------------------------------- components */

function profileForReport(
  report: TailorReport,
  dossiers: ProfileDossier[],
  current: Profile | undefined,
): Profile | undefined {
  return (
    dossiers.find((dossier) => dossier.id === report.dossierId)?.profile ??
    dossiers.find((dossier) => dossier.profile.id === report.profileId)?.profile ??
    current
  );
}

function hasResumeContent(profile: Profile): boolean {
  return Boolean(
    profile.identity.fullName ||
      profile.contact.email ||
      profile.education.length > 0 ||
      profile.experience.length > 0 ||
      profile.projects.length > 0,
  );
}

function matchForAnalysis(
  analysis: JdAnalysis,
  dossiers: ProfileDossier[],
  activeProfileId: string | undefined,
  jobText: string,
): ReturnType<typeof matchDossierForJob> {
  return matchDossierForJob(dossiers, activeProfileId, {
    jobRole: analysis.role,
    jobText,
  });
}

function endpointHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

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
  profile,
  analysis,
  onClose,
  onUpdate,
  onCopy,
}: {
  report: TailorReport;
  profile?: Profile;
  analysis: JdAnalysis | undefined;
  onClose: () => void;
  onUpdate: (report: TailorReport) => Promise<void>;
  onCopy: (report: TailorReport) => void;
}): JSX.Element {
  const [tab, setTab] = useState<"resume" | "gaps" | "letter" | "interview">("resume");
  const [workingReport, setWorkingReport] = useState(report);
  const [candidatePool] = useState(report.sections);
  const [swapPending, setSwapPending] = useState(false);

  const replaceSection = async (sectionIndex: number, replacement: TailoredSection): Promise<void> => {
    if (swapPending) return;
    const replacementIndex = candidatePool.findIndex(
      (section) => section.entityId && section.entityId === replacement.entityId,
    );
    const current = workingReport.sections[sectionIndex];
    if (!current || replacementIndex < 0 || current.entityId === replacement.entityId) return;

    // Swap the selected entry into this position and remove its previous copy
    // so the tailored output does not list the same experience twice.
    const sections = [...workingReport.sections];
    const currentIndex = sections.findIndex((section) => section.entityId === current.entityId);
    if (currentIndex < 0) return;
    const candidate = candidatePool[replacementIndex];
    if (!candidate) return;
    const removeCandidateAt = sections.findIndex((section) => section.entityId === candidate.entityId);
    if (removeCandidateAt < 0) return;

    sections.splice(removeCandidateAt, 1);
    const adjustedCurrentIndex = removeCandidateAt < currentIndex ? currentIndex - 1 : currentIndex;
    sections.splice(adjustedCurrentIndex, 1, candidate);

    const next = { ...workingReport, sections };
    setSwapPending(true);
    try {
      await onUpdate(next);
      setWorkingReport(next);
    } catch {
      // The parent reports the persistence error; keep the displayed report.
    } finally {
      setSwapPending(false);
    }
  };

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
              {analysis?.company ? `${analysis.company} · ` : ""}
              {workingReport.dossierName ? `${workingReport.dossierName}方向 · ` : ""}
              覆盖 {Math.round(workingReport.coverage * 100)}%
            </div>
          </div>
          <button type="button" className="q-icon-btn" onClick={() => onCopy(workingReport)} aria-label="复制文本">
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
              {workingReport.headline}
            </p>
            <p className="q-sub" style={{ marginTop: "var(--s-3)" }}>
              {workingReport.summary}
            </p>
          </div>

          <div className="q-segmented" style={{ marginBottom: "var(--s-5)" }}>
            {(
              [
                ["resume", "简历建议"],
                ["gaps", `缺口 ${workingReport.gaps.filter((gap) => gap.verdict !== "matched").length}`],
                ["letter", "求职信"],
                ["interview", "面试准备"],
              ] as const
            ).map(([id, label]) => (
              <button key={id} type="button" aria-pressed={tab === id} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </div>

          {tab === "resume" && (
            <TailoredSections
              sections={workingReport.sections}
              candidatePool={candidatePool}
              profile={profile}
              onReplace={replaceSection}
              disabled={swapPending}
            />
          )}
          {tab === "gaps" && <GapList gaps={workingReport.gaps} />}
          {tab === "letter" && (
            <div className="q-prose" style={{ whiteSpace: "pre-wrap" }}>
              {workingReport.coverLetter}
              <button
                type="button"
                className="q-btn q-btn-outline"
                style={{ marginTop: "var(--s-5)" }}
                onClick={() => void copyText(workingReport.coverLetter)}
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
                {workingReport.interviewPrompts.map((prompt, index) => (
                  <li className="q-bullet" key={index} style={{ display: "flex", gap: "var(--s-3)" }}>
                    <span className="q-step-num">{String(index + 1).padStart(2, "0")}</span>
                    <span>{prompt}</span>
                  </li>
                ))}
                {workingReport.interviewPrompts.length === 0 && <li className="q-sub">没有发现明显的缺口。</li>}
              </ol>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

interface SectionAlternative {
  section: TailoredSection;
  kindLabel: string;
  matchedKeywords: string[];
  evidence: string;
}

function sectionAlternatives(
  current: TailoredSection,
  candidatePool: TailoredSection[],
  visibleSections: TailoredSection[],
  profile: Profile | undefined,
  minKeywordCount: number,
): SectionAlternative[] {
  if (!profile || !current.entityId) return [];
  const visibleIds = new Set(visibleSections.map((section) => section.entityId).filter(Boolean));

  return candidatePool
    .filter(
      (section) =>
        section.entityId &&
        section.entityId !== current.entityId &&
        visibleIds.has(section.entityId),
    )
    .map((section): SectionAlternative | undefined => {
      const experience = profile.experience.find((item) => item.id === section.entityId);
      const project = profile.projects.find((item) => item.id === section.entityId);
      if (!experience && !project) return undefined;

      const matchedBullets = section.bullets
        .filter((bullet) => bullet.answers.length > 0)
        .sort((left, right) => right.answers.length - left.answers.length);
      const matchedKeywords = [...new Set(matchedBullets.flatMap((bullet) => bullet.answers))];
      const evidence = matchedBullets[0]?.text;
      if (matchedKeywords.length <= minKeywordCount || !evidence) return undefined;

      let kindLabel = "工作经历";
      if (project) {
        kindLabel = project.category
          ? `${PROJECT_CATEGORY_LABELS[project.category]}`
          : "项目经历";
      } else if (
        /实习|intern/i.test(`${experience?.employmentType ?? ""} ${experience?.title ?? ""}`)
      ) {
        kindLabel = "实习经历";
      }

      return { section, kindLabel, matchedKeywords, evidence };
    })
    .filter((item): item is SectionAlternative => item !== undefined)
    .sort(
      (left, right) =>
        right.matchedKeywords.length - left.matchedKeywords.length ||
        right.section.bullets.reduce((sum, bullet) => sum + bullet.answers.length, 0) -
          left.section.bullets.reduce((sum, bullet) => sum + bullet.answers.length, 0),
    )
    .slice(0, 3);
}

function TailoredSections({
  sections,
  candidatePool,
  profile,
  onReplace,
  disabled,
}: {
  sections: TailoredSection[];
  candidatePool: TailoredSection[];
  profile?: Profile;
  onReplace: (index: number, replacement: TailoredSection) => void;
  disabled: boolean;
}): JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-6)" }}>
      {sections.map((section, index) => {
        const isExperienceOrProject = Boolean(
          profile?.experience.some((item) => item.id === section.entityId) ||
            profile?.projects.some((item) => item.id === section.entityId),
        );
        const lowMatchCount = section.bullets.filter((bullet) => bullet.answers.length === 0).length;
        const matchedKeywordCount = new Set(section.bullets.flatMap((bullet) => bullet.answers)).size;
        const hasAnyMatch = matchedKeywordCount > 0;
        const alternatives =
          isExperienceOrProject && lowMatchCount > 0
            ? sectionAlternatives(
                section,
                candidatePool,
                sections,
                profile,
                matchedKeywordCount,
              )
            : [];

        return (
          <section key={`${section.entityId ?? section.heading}-${index}`}>
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

            {isExperienceOrProject && lowMatchCount > 0 && (
              <div className="q-insight" data-kind="warning" style={{ marginTop: "var(--s-4)" }}>
                <Info size={16} />
                <div className="q-grow">
                  <div className="q-insight-title">
                    {hasAnyMatch ? "这段经历有内容与岗位关键词重合度低" : "这段经历与岗位关键词重合度低"}
                  </div>
                  <div className="q-insight-detail">
                    {lowMatchCount} 条内容没有直接命中岗位关键词，{hasAnyMatch ? `另有 ${matchedKeywordCount} 个岗位词命中` : "当前先保留原文"}。
                    {alternatives.length > 0
                      ? " 可以参考下面命中更多岗位词的真实经历。换入会替换本次建议里的整段经历，不会改动资料库或求职信草稿。"
                      : " 目前没有找到命中岗位词更多的其他工作、实习或项目经历，可以核对岗位要求或继续保留原文。"}
                  </div>

                  {alternatives.length > 0 && (
                    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)", marginTop: "var(--s-3)" }}>
                      {alternatives.map((alternative) => (
                        <div
                          key={alternative.section.entityId}
                          style={{
                            display: "flex",
                            alignItems: "flex-start",
                            gap: "var(--s-3)",
                            flexWrap: "wrap",
                            padding: "var(--s-3)",
                            borderRadius: "var(--r-md)",
                            background: "var(--bg-sunken)",
                          }}
                        >
                          <div className="q-grow" style={{ minWidth: "12rem" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: "var(--s-2)", flexWrap: "wrap" }}>
                              <span className="q-chip q-chip-accent">{alternative.kindLabel}</span>
                              <span className="q-strong">{alternative.section.heading}</span>
                            </div>
                            <div className="q-cap" style={{ marginTop: "var(--s-2)" }}>
                              {alternative.evidence}
                            </div>
                            <div className="q-cap" style={{ marginTop: "var(--s-1)" }}>
                              命中：{alternative.matchedKeywords.slice(0, 4).join("、")}
                            </div>
                          </div>
                          <button
                            type="button"
                            className="q-btn q-btn-outline q-btn-sm"
                            disabled={disabled}
                            onClick={() => onReplace(index, alternative.section)}
                          >
                            {disabled ? "正在替换…" : "换入并替换此段"}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </section>
        );
      })}
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
