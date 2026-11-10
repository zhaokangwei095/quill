/**
 * The in-page panel.
 *
 * Design intent: this is a piece of system UI that happens to be injected into
 * someone else's page. It should feel like it belongs to the browser, not to the
 * site — hence the glass material, the hairline rules, the single accent colour,
 * and a total absence of decorative imagery.
 *
 * Information hierarchy, in order:
 *   1. How many fields can I fill?          → the hero count
 *   2. Which ones need me?                  → the grouped list, worst first
 *   3. Why does it think that?              → the evidence line under each value
 *   4. Do it                                → one primary button, always in reach
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from "react";
import {
  ESSAY_KEYS,
  tallyDecisions,
  type Decision,
  type DecisionStatus,
  type FillPlan,
  type PageScan,
} from "@quill/core";
import type { FillReport, SectionPlanItem } from "../shared/protocol.js";
import {
  Check,
  CheckCircle,
  ChevronDown,
  Eye,
  Info,
  Locate,
  Minus,
  Plus,
  Question,
  QuillMark,
  Refresh,
  Sparkle,
  Warning,
  X,
} from "./icons.js";

/* ------------------------------------------------------------------ types */

export interface FocusFieldResult {
  ok: boolean;
  message: string;
}

interface PanelProps {
  plan?: FillPlan;
  scan?: PageScan;
  summary: string;
  report?: FillReport;
  /** Empty sections that a full “填写” would open first. */
  sections?: SectionPlanItem[];
  busy: boolean;
  error?: string;
  collapsed: boolean;
  /** Current extension build, shown so a reload is easy to verify. */
  version: string;
  position: { x: number; y: number };
  onRefresh: () => void;
  onApply: (refs?: string[]) => void;
  onLearn: (decision: Decision, value: string) => void;
  onFocusField: (decision: Decision) => FocusFieldResult;
  /** Add this fill to the application ledger. */
  onRecord?: () => Promise<{ ok: boolean }>;
  /** Copy a redacted diagnostic bundle for a bug report. */
  onDiagnostics?: () => Promise<{ ok: boolean; message?: string }>;
  onCollapse: (collapsed: boolean) => void;
  onClose: () => void;
  onHide: () => void;
  onOpenWorkbench: () => void;
  onDragStart: (event: React.PointerEvent) => void;
  /** Which keys this person has chosen to always review by hand. */
  ignored?: Set<string>;
  onToggleIgnore?: (decision: Decision) => void;
}

/* -------------------------------------------------------------- utilities */

/** Group ordering: what blocks the person comes first. */
const GROUP_ORDER: Array<{ status: DecisionStatus; title: string }> = [
  { status: "missing", title: "暂缺资料" },
  { status: "choice", title: "需你选择" },
  { status: "review", title: "待你确认" },
  { status: "ready", title: "可直接填写" },
];

const STATUS_LABEL: Record<DecisionStatus, string> = {
  ready: "就绪",
  review: "待确认",
  choice: "需选择",
  missing: "缺资料",
};

const STATUS_TONE: Record<DecisionStatus, string> = {
  ready: "green",
  review: "accent",
  choice: "orange",
  missing: "neutral",
};

function isLongForm(decision: Decision): boolean {
  return (
    decision.kind === "textarea" ||
    decision.kind === "contenteditable" ||
    ESSAY_KEYS.has(decision.key) ||
    (decision.value?.text.length ?? 0) > 120
  );
}

/**
 * What to print when a field has no value.
 *
 * The distinction matters to the person: "we have nothing for this" is an
 * invitation to fill it in, whereas a captcha or a consent checkbox is
 * something we are *deliberately* not touching. Saying "资料库中没有这一项" about
 * a privacy-policy checkbox is both wrong and mildly alarming.
 */
function emptyLabel(decision: Decision): string {
  if (HANDS_OFF_KEYS.has(decision.key)) return "需要你本人操作";
  if (decision.status === "missing") return "资料库中没有这一项";
  return "—";
}

/** Keys the extension must never fill, mirroring `NEVER_AUTOFILL_KEYS`. */
const HANDS_OFF_KEYS = new Set(["meta.captcha", "meta.agreement", "meta.submit", "meta.search"]);

/* ------------------------------------------------------------------ panel */

export function Panel(props: PanelProps): JSX.Element {
  const {
    plan,
    summary,
    report,
    sections,
    busy,
    error,
    collapsed,
    position,
    onRefresh,
    onApply,
    onLearn,
    onRecord,
    onDiagnostics,
    onFocusField,
    version,
    onCollapse,
    onClose,
    onHide,
    onOpenWorkbench,
    onDragStart,
    ignored,
    onToggleIgnore,
  } = props;

  const [editing, setEditing] = useState<string | undefined>();
  const [draft, setDraft] = useState("");
  const [focusMessages, setFocusMessages] = useState<Record<string, FocusFieldResult>>({});
  const [collapsedGroups, setCollapsedGroups] = useState<Set<DecisionStatus>>(() => new Set());
  const [diagnosticState, setDiagnosticState] = useState<"idle" | "busy" | "done" | "failed">("idle");
  const [diagnosticMessage, setDiagnosticMessage] = useState("");

  const reportProblem = async (): Promise<void> => {
    if (!onDiagnostics || diagnosticState === "busy") return;
    setDiagnosticState("busy");
    try {
      const result = await onDiagnostics();
      setDiagnosticState(result.ok ? "done" : "failed");
      setDiagnosticMessage(result.message ?? "");
    } catch {
      setDiagnosticState("failed");
      setDiagnosticMessage("");
    }
  };

  const tally = useMemo(() => (plan ? tallyDecisions(plan.decisions) : { ready: 0, review: 0, choice: 0, missing: 0 }), [plan]);

  const applyable = useMemo(() => {
    if (!plan) return [];
    return plan.decisions.filter((decision) => decision.value && decision.status !== "missing");
  }, [plan]);

  const groups = useMemo(() => {
    if (!plan) return [];
    return GROUP_ORDER.map((group) => ({
      ...group,
      items: plan.decisions.filter((decision) => decision.status === group.status),
    })).filter((group) => group.items.length > 0);
  }, [plan]);

  const beginEdit = useCallback((decision: Decision, initial: string) => {
    setEditing(decision.ref);
    setDraft(initial);
  }, []);

  const commitEdit = useCallback(
    (decision: Decision) => {
      const value = draft.trim();
      setEditing(undefined);
      if (!value) return;
      onLearn(decision, value);
    },
    [draft, onLearn],
  );

  if (collapsed) {
    return (
      <button
        type="button"
        className="q-pill"
        style={{ left: position.x, top: position.y }}
        onPointerDown={onDragStart}
        onClick={() => onCollapse(false)}
        aria-label="展开 Quill 面板"
      >
        <span className="q-pill-mark">
          <QuillMark size={12} />
        </span>
        <span className="q-pill-text">{summary || "识别页面字段"}</span>
        <span className="q-field-status" style={{ color: "var(--ink-quaternary)" }}>
          <ChevronDown size={12} />
        </span>
      </button>
    );
  }

  return (
    <section
      className="q-panel"
      style={{ left: position.x, top: position.y }}
      aria-label="Quill 网申助手"
    >
      <header className="q-head" onPointerDown={onDragStart}>
        <span className="q-head-mark">
          <QuillMark size={13} />
        </span>
        <div className="q-grow" style={{ minWidth: 0 }}>
          <div className="q-head-title">
            Quill <span className="q-version">v{version}</span>
          </div>
          <div className="q-head-sub q-truncate">{summary || "正在识别当前页面…"}</div>
        </div>
        <div className="q-head-actions" onPointerDown={(event) => event.stopPropagation()}>
          <button type="button" className="q-hbtn" onClick={onRefresh} disabled={busy} aria-label="重新识别" title="重新识别">
            <Refresh style={busy ? { animation: "q-spin 900ms linear infinite" } : undefined} />
          </button>
          <button
            type="button"
            className="q-hbtn"
            onClick={() => void reportProblem()}
            disabled={diagnosticState === "busy"}
            aria-label="报告问题"
            title="报告问题（复制诊断信息）"
          >
            <Question />
          </button>
          <button type="button" className="q-hbtn" onClick={() => onCollapse(true)} aria-label="收起面板" title="收起">
            <Minus />
          </button>
          <button type="button" className="q-hbtn" onClick={onClose} aria-label="关闭面板" title="关闭">
            <X />
          </button>
        </div>
      </header>

      <div className="q-body quill-scroll">
        {diagnosticState === "done" && (
          <div className="q-notice" data-tone="success">
            <CheckCircle />
            <div>诊断信息已复制到剪贴板。把它发给开发者，就能定位这次的问题。</div>
          </div>
        )}
        {diagnosticState === "failed" && (
          <div className="q-notice" data-tone="warning">
            <Warning />
            <div>
              {diagnosticMessage || "复制失败。可以到工作台「设置 → 诊断与日志」导出诊断包。"}
            </div>
          </div>
        )}

        {error && (
          <div className="q-notice" data-tone="error">
            <Warning />
            <span>{error}</span>
          </div>
        )}

        {report && <ReportNotice report={report} onRecord={onRecord} />}

        {sections && sections.length > 0 && <SectionNotice sections={sections} />}

        {!plan && !error && <LoadingState />}

        {plan && (
          <>
            <Hero tally={tally} total={plan.decisions.length} notes={plan.notes} />

            {groups.map((group, index) => {
              const isCollapsed = collapsedGroups.has(group.status);
              const rowsId = `q-group-${group.status}`;
              return (
                <section className="q-section q-reveal" key={group.status} style={{ "--i": index } as CSSProperties}>
                  <button
                    type="button"
                    className="q-section-head q-section-toggle"
                    aria-expanded={!isCollapsed}
                    aria-controls={rowsId}
                    onClick={() => {
                      setCollapsedGroups((current) => {
                        const next = new Set(current);
                        if (next.has(group.status)) next.delete(group.status);
                        else next.add(group.status);
                        return next;
                      });
                    }}
                  >
                    <span className="q-section-title">{group.title}</span>
                    <span className="q-section-count">{group.items.length}</span>
                    <ChevronDown className={`q-section-chevron${isCollapsed ? " is-collapsed" : ""}`} size={13} />
                  </button>
                  <div id={rowsId} className="q-section-rows" hidden={isCollapsed}>
                    {group.items.map((decision, itemIndex) => (
                      <FieldRow
                        key={decision.ref}
                        decision={decision}
                        index={itemIndex}
                        editing={editing === decision.ref}
                        draft={draft}
                        ignored={ignored?.has(decision.key) ?? false}
                        onDraft={setDraft}
                        onBeginEdit={beginEdit}
                        onCommit={commitEdit}
                        onCancel={() => setEditing(undefined)}
                        onApplyOne={() => onApply([decision.ref])}
                        onUseCandidate={(value) => onLearn(decision, value)}
                        focusMessage={focusMessages[decision.ref]?.message}
                        onFocusField={() => {
                          const result = onFocusField(decision);
                          setFocusMessages((current) => ({ ...current, [decision.ref]: result }));
                        }}
                        onToggleIgnore={onToggleIgnore ? () => onToggleIgnore(decision) : undefined}
                      />
                    ))}
                  </div>
                </section>
              );
            })}

            {plan.decisions.length === 0 && (
              <div className="q-empty">
                <span className="q-empty-title">这个页面没有可填写的字段</span>
                <p className="q-empty-body">
                  可能是信息展示页，或者表单在 iframe 中。可以点右上角重新识别。
                </p>
              </div>
            )}
          </>
        )}
      </div>

      <footer className="q-foot">
        <button
          type="button"
          className="q-cta"
          onClick={() => onApply()}
          disabled={busy || applyable.length === 0}
        >
          <Sparkle />
          {busy ? "正在填写…" : applyable.length > 0 ? `填写 ${applyable.length} 项` : "暂无可填内容"}
        </button>
        <button
          type="button"
          className="q-cta q-cta-ghost"
          onClick={onOpenWorkbench}
          title="打开工作台"
          aria-label="打开工作台"
        >
          <Eye />
        </button>
        <button
          type="button"
          className="q-cta q-cta-ghost"
          onClick={onHide}
          title="在此网站不再显示"
          aria-label="在此网站不再显示面板"
        >
          <X />
        </button>
      </footer>
    </section>
  );
}

/* -------------------------------------------------------------------- hero */

function Hero({
  tally,
  total,
  notes,
}: {
  tally: Record<DecisionStatus, number>;
  total: number;
  notes: string[];
}): JSX.Element {
  const fillable = tally.ready + tally.review + tally.choice;
  const segments: DecisionStatus[] = [];
  for (const [status, count] of Object.entries(tally) as Array<[DecisionStatus, number]>) {
    for (let i = 0; i < count; i += 1) segments.push(status);
  }

  /*
   * Say the same thing the button says. The button fills every field that has a
   * value (`fillable`), so describing only the confident subset here made the two
   * numbers disagree on screen — "其中 26 项可放心填写" next to "填写 29 项" — and
   * the person has no way to tell which is right.
   *
   * Rendered as a small legend rather than one long sentence: a single line of
   * four comma-separated clauses wraps to three lines in a 376px panel and is
   * hard to scan.
   */
  const legend: Array<{ status: DecisionStatus; label: string; count: number }> = [];
  if (tally.ready > 0) legend.push({ status: "ready", label: "可直接填写", count: tally.ready });
  if (tally.review > 0) legend.push({ status: "review", label: "待你确认", count: tally.review });
  if (tally.choice > 0) legend.push({ status: "choice", label: "需你选择", count: tally.choice });
  if (tally.missing > 0) legend.push({ status: "missing", label: "暂缺资料", count: tally.missing });

  return (
    <div className="q-hero">
      <div className="q-hero-top">
        <div>
          <div className="q-hero-count">
            {fillable}
            <span className="q-hero-of"> / {total}</span>
          </div>
          <div className="q-hero-label">本页共 {total} 个字段</div>
        </div>
      </div>

      {segments.length > 0 && (
        <div className="q-bar" role="img" aria-label={`共 ${total} 项：${tally.ready} 项就绪、${tally.review} 项待确认、${tally.choice} 项需选择、${tally.missing} 项缺资料`}>
          {segments.map((status, index) => (
            <span key={index} className="q-bar-seg" data-state={status} />
          ))}
        </div>
      )}

      {legend.length > 0 && (
        <ul className="q-legend">
          {legend.map((entry) => (
            <li className="q-legend-item" key={entry.status}>
              <span className="q-legend-dot" data-state={entry.status} />
              <span className="q-legend-count">{entry.count}</span>
              <span>{entry.label}</span>
            </li>
          ))}
        </ul>
      )}

      {notes.length > 0 && (
        <div className="q-hero-note">
          {notes.slice(0, 4).map((note, index) => (
            <div className="q-hero-note-item" key={index}>
              <Info />
              <span>{note}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- field row */

interface FieldRowProps {
  decision: Decision;
  index: number;
  editing: boolean;
  draft: string;
  ignored: boolean;
  onDraft: (value: string) => void;
  onBeginEdit: (decision: Decision, initial: string) => void;
  onCommit: (decision: Decision) => void;
  onCancel: () => void;
  onApplyOne: () => void;
  onUseCandidate: (value: string) => void;
  focusMessage?: string;
  onFocusField: () => void;
  onToggleIgnore?: () => void;
}

function FieldRow({
  decision,
  index,
  editing,
  draft,
  ignored,
  onDraft,
  onBeginEdit,
  onCommit,
  onCancel,
  onApplyOne,
  onUseCandidate,
  focusMessage,
  onFocusField,
  onToggleIgnore,
}: FieldRowProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const long = isLongForm(decision);
  const value = decision.value?.text;

  return (
    <div
      className="q-field q-reveal"
      data-status={decision.status}
      style={{ "--i": Math.min(index, 8) } as CSSProperties}
    >
      <div className="q-field-label">
        <button
          type="button"
          className="q-field-label-text q-field-label-target"
          title={`定位到网页中的${decision.label}`}
          aria-label={`定位到网页中的${decision.label}`}
          onClick={onFocusField}
        >
          <span>{decision.label}</span>
          <Locate size={11} />
        </button>
        {decision.required && <span className="q-field-req">必填</span>}
      </div>

      <div className="q-field-status">
        {decision.status === "ready" ? (
          <CheckCircle size={12} style={{ color: "var(--green)" }} />
        ) : decision.status === "choice" ? (
          <Question size={12} style={{ color: "var(--orange)" }} />
        ) : decision.status === "missing" ? (
          <Warning size={12} style={{ color: "var(--ink-quaternary)" }} />
        ) : (
          <Sparkle size={12} style={{ color: "var(--accent)" }} />
        )}
        <span>{STATUS_LABEL[decision.status]}</span>
      </div>

      {editing ? (
        <div className="q-edit">
          {long ? (
            <textarea
              ref={inputRef as React.Ref<HTMLTextAreaElement>}
              value={draft}
              onChange={(event) => onDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") onCancel();
                // Cmd/Ctrl+Enter commits a long answer; Enter alone must insert
                // a newline in a multi-line field.
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) onCommit(decision);
              }}
              aria-label={`填写 ${decision.label}`}
            />
          ) : (
            <input
              ref={inputRef as React.Ref<HTMLInputElement>}
              value={draft}
              onChange={(event) => onDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") onCommit(decision);
                if (event.key === "Escape") onCancel();
              }}
              aria-label={`填写 ${decision.label}`}
            />
          )}
          <button type="button" className="q-mini q-mini-accent" onClick={() => onCommit(decision)}>
            <Check />
            填入页面
          </button>
        </div>
      ) : (
        <div className={`q-field-value${long ? " is-multiline" : ""}${value ? "" : " is-empty"}`}>
          {value ?? emptyLabel(decision)}
        </div>
      )}

      {/* Evidence: always visible, because "why" is the product. */}
      {!editing && (
        <div className="q-field-why">
          <Info />
          <span className="q-field-why-text">
            {decision.evidence.detail}
            {decision.evidence.quote && <span className="q-field-quote">{decision.evidence.quote}</span>}
            {decision.caution && <div className="q-field-caution">{decision.caution}</div>}
          </span>
        </div>
      )}

      {!editing && decision.status === "choice" && decision.candidates && (
        <div className="q-choices">
          {decision.candidates.map((candidate, candidateIndex) => (
            <button
              type="button"
              className="q-choice"
              key={candidateIndex}
              onClick={() => onUseCandidate(candidate.value.text)}
              title={candidate.evidence.detail}
            >
              <span className="q-choice-label">{candidate.value.text}</span>
            </button>
          ))}
        </div>
      )}

      {!editing && focusMessage && (
        <div className="q-field-why" role="status" aria-live="polite">
          <Info />
          <span className="q-field-why-text">{focusMessage}</span>
        </div>
      )}

      {!editing && (
        <div className="q-field-actions">
          {(decision.status === "review" || decision.status === "choice") && decision.value && (
            <button type="button" className="q-mini q-mini-accent" onClick={onApplyOne}>
              <Check />
              就用这个
            </button>
          )}
          <button
            type="button"
            className="q-mini"
            onClick={() => {
              if (decision.status === "missing") onFocusField();
              else onBeginEdit(decision, decision.value?.text ?? "");
            }}
            title={
              decision.status === "missing"
                ? `定位网页中的${decision.label}，然后直接在该字段输入`
                : undefined
            }
          >
            {decision.status === "missing" ? "我来填写" : "改一下"}
          </button>
          {onToggleIgnore && (
            <button type="button" className="q-mini" onClick={onToggleIgnore} title="以后这个字段都交给我自己填">
              {ignored ? "取消忽略" : "忽略此字段"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ states */

function LoadingState(): JSX.Element {
  return (
    <div style={{ padding: "0.5rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      {[0, 1, 2, 3].map((index) => (
        <div
          key={index}
          style={{
            padding: "0.5rem",
            display: "flex",
            flexDirection: "column",
            gap: "0.5rem",
          }}
        >
          <div className="q-skeleton" style={{ height: "0.75rem", width: `${7 - index}rem` }} />
          <div className="q-skeleton" style={{ height: "0.5rem", width: "100%" }} />
        </div>
      ))}
    </div>
  );
}

/**
 * Tell the person, before they click, what “填写” will do with empty sections.
 *
 * Two different situations used to look identical — silence:
 *  - the section is empty and the profile has entries, so filling opens rows;
 *  - the section is empty and the profile has no entries, so filling must skip it.
 *
 * The second one is not a failure, but leaving it unmentioned makes the panel
 * look like it missed the section. Naming it turns a silent gap into a clear
 * next step.
 */
function SectionNotice({ sections }: { sections: SectionPlanItem[] }): JSX.Element {
  const openable = sections.filter((section) => section.toAdd > 0);
  const mismatched = sections.filter((section) => section.reason === "experience-kind-mismatch");
  const missing = sections.filter((section) => section.desired === 0 && !section.reason);

  const openableNames = openable.map((section) => `「${section.label}」`).join("、");
  const rows = openable
    .map((section) =>
      section.existing > 0
        ? `${section.label}（已有 ${section.existing} 行，再添加 ${section.toAdd} 行）`
        : `${section.label} ${section.toAdd} 行`,
    )
    .join("、");
  const missingNames = missing.map((section) => `「${section.label}」`).join("、");
  const missingHasRows = missing.some((section) => section.existing > 0);

  return (
    <>
      {openable.length > 0 && (
        <div className="q-notice">
          <Plus />
          <div className="q-grow">
            <div>
              {openable.some((section) => section.existing > 0)
                ? `页面里的${openableNames}已有空白行，简历里的记录更多。`
                : `页面里的${openableNames}还是空的，简历里有对应内容。`}
            </div>
            <div style={{ marginTop: "0.125rem", opacity: 0.8 }}>
              点「填写」时会先自动添加 {rows}，再填入资料。
            </div>
          </div>
        </div>
      )}
      {missing.length > 0 && (
        <div className="q-notice">
          <Info />
          <div className="q-grow">
            <div>
              页面里的{missingNames}
              {missingHasRows ? "有空白行" : "还是空的"}，你的资料里还没有对应记录。
            </div>
            <div style={{ marginTop: "0.125rem", opacity: 0.8 }}>
              这一栏不会自动添加，需要你手动填写；也可以先在工作台补充资料，再点「重新识别」。
            </div>
          </div>
        </div>
      )}
      {mismatched.length > 0 && (
        <div className="q-notice">
          <Info />
          <div className="q-grow">
            <div>
              资料库里有其他类别的经历，但与页面里的{mismatched.map((section) => `「${section.label}」`).join("、")}不匹配。
            </div>
            <div style={{ marginTop: "0.125rem", opacity: 0.8 }}>
              Quill 不会用其他类别的经历代替。请在工作台核对经历性质，或在页面添加对应经历后手动填写。
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function ReportNotice({
  report,
  onRecord,
}: {
  report: FillReport;
  onRecord?: () => Promise<{ ok: boolean }>;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [recordState, setRecordState] = useState<"idle" | "busy" | "done" | "failed">("idle");
  const failures = report.outcomes.filter((outcome) => !outcome.ok);

  /*
   * A new report means a new fill. Reset the record control, or a second fill in
   * the same page view would keep showing "已记入投递台账" from the first one.
   */
  useEffect(() => {
    setRecordState("idle");
  }, [report]);

  const canRecord = Boolean(onRecord) && report.filled > 0;

  const record = async (): Promise<void> => {
    if (!onRecord || recordState === "busy" || recordState === "done") return;
    setRecordState("busy");
    try {
      const result = await onRecord();
      setRecordState(result.ok ? "done" : "failed");
    } catch {
      setRecordState("failed");
    }
  };

  return (
    <div className="q-notice" data-tone={report.failed > 0 ? "warning" : "success"}>
      {report.failed > 0 ? <Warning /> : <CheckCircle />}
      <div className="q-grow">
        <div>
          已填写 {report.filled} 项
          {report.failed > 0 && `，${report.failed} 项未能填写`}
          {report.skipped > 0 && `，跳过 ${report.skipped} 项`}
        </div>
        {report.prepared && report.prepared.length > 0 && (
          <div style={{ marginTop: "0.125rem", opacity: 0.8 }}>
            已自动添加 {report.prepared.map((item) => `${item.label} ${item.rows} 行`).join("、")}
          </div>
        )}
        {canRecord && (
          <button
            type="button"
            className="q-mini"
            style={{ marginTop: "0.375rem" }}
            data-state={recordState}
            disabled={recordState === "busy" || recordState === "done"}
            onClick={() => void record()}
          >
            {recordState === "done"
              ? "已记入投递台账"
              : recordState === "failed"
                ? "记录失败，点击重试"
                : recordState === "busy"
                  ? "正在记录…"
                  : "记入投递台账"}
          </button>
        )}
        {failures.length > 0 && (
          <>
            <button
              type="button"
              className="q-mini"
              style={{ marginTop: "0.375rem", marginLeft: canRecord ? "0.375rem" : undefined }}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? "收起" : "查看原因"}
            </button>
            {expanded && (
              <ul style={{ marginTop: "0.375rem", display: "flex", flexDirection: "column", gap: "0.1875rem" }}>
                {failures.map((failure, index) => (
                  <li key={index}>
                    <span className="q-strong">{failure.label}</span>
                    {" — "}
                    {failure.reason ?? "未知原因"}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}
