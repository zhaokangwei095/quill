/**
 * The application ledger.
 *
 * The problem this view solves: after thirty applications you cannot remember
 * which company asked for what, or when you last heard from anyone. So the
 * table is organised around *what needs attention*, not around the data model —
 * stale applications surface first, and a row opens into its full history.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import {
  addNote,
  advanceStage,
  ledgerInsights,
  ledgerStats,
  ledgerToCsv,
  setNextAction,
  sortRecords,
  STAGE_LABELS,
  filterRecords,
  isClosed,
  type ApplicationRecord,
  type ApplicationStage,
  type LedgerSort,
} from "@quill/core";
import { useWorkbench } from "../state.js";
import { getStore } from "../data/store.js";
import { deadlineLabel, downloadFile, formatDate, relativeTime } from "../data/format.js";
import {
  Check,
  ChevronRight,
  Clock,
  Download,
  External,
  Info,
  Plus,
  Search,
  Table,
  Trash,
  Warning,
  X,
} from "../icons.js";

type Toast = (text: string, tone?: "neutral" | "success" | "error") => void;

const FILTERS: Array<{ id: string; label: string; stages?: ApplicationStage[] }> = [
  { id: "all", label: "全部" },
  { id: "active", label: "进行中", stages: ["submitted", "screening", "assessment", "interview-1", "interview-2", "interview-3"] },
  { id: "interview", label: "面试", stages: ["interview-1", "interview-2", "interview-3"] },
  { id: "closed", label: "已结束", stages: ["offer", "rejected", "withdrawn"] },
];

export function LedgerView({ onToast }: { onToast: Toast }): JSX.Element {
  const { state, reload } = useWorkbench();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState<LedgerSort>("urgency");
  const [openId, setOpenId] = useState<string | undefined>();

  const visible = useMemo(() => {
    const active = FILTERS.find((item) => item.id === filter);
    return sortRecords(filterRecords(state.records, query, active?.stages), sort);
  }, [filter, query, sort, state.records]);

  const stats = useMemo(() => ledgerStats(state.records), [state.records]);
  const insights = useMemo(() => ledgerInsights(state.records), [state.records]);
  const open = state.records.find((record) => record.id === openId);

  const exportCsv = useCallback(() => {
    // A BOM makes Excel on Windows read the file as UTF-8 rather than GBK.
    downloadFile(
      `quill-投递台账-${formatDate(Date.now())}.csv`,
      `\uFEFF${ledgerToCsv(state.records)}`,
      "text/csv;charset=utf-8",
    );
    onToast("已导出 CSV", "success");
  }, [onToast, state.records]);

  return (
    <div className="q-page">
      <header className="q-page-head q-reveal">
        <div className="q-between" style={{ alignItems: "flex-start", gap: "var(--s-4)", flexWrap: "wrap" }}>
          <div>
            <h1 className="q-page-title">每一次投递，都有据可查。</h1>
            <p className="q-page-lead">
              记录公司、岗位、进度与下一步行动。面试前打开这里，就知道当时提交了什么、对方问了什么。
            </p>
          </div>
          <div className="q-toolbar">
            <button type="button" className="q-btn q-btn-outline" onClick={exportCsv} disabled={state.records.length === 0}>
              <Download size={15} />
              导出 CSV
            </button>
            <button
              type="button"
              className="q-btn q-btn-primary"
              onClick={() => {
                void getStore()
                  .saveRecord({
                    id: `app-${Date.now().toString(36)}`,
                    company: "",
                    role: "",
                    stage: "draft",
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    timeline: [{ at: Date.now(), note: "手动创建记录" }],
                  })
                  .then((records) => {
                    const created = records.find((record) => !state.records.some((item) => item.id === record.id));
                    if (created) setOpenId(created.id);
                    return reload();
                  });
              }}
            >
              <Plus size={15} />
              新增记录
            </button>
          </div>
        </div>
      </header>

      {state.records.length > 0 && (
        <section className="q-block q-reveal" style={{ "--i": 1 } as React.CSSProperties}>
          <div className="q-grid q-grid-3">
            <Metric value={stats.total} label="总投递" />
            <Metric value={stats.active} label="进行中" />
            <Metric
              value={Math.round(stats.responseRate * 100)}
              label="回复率 %"
              hint={stats.total > 0 ? `${Math.round(stats.responseRate * 100)}% 的投递进入了后续流程` : undefined}
            />
          </div>
        </section>
      )}

      {insights.length > 0 && (
        <section className="q-block">
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)" }}>
            {insights.map((insight, index) => (
              <div className="q-insight" data-kind={insight.kind} key={index}>
                {insight.kind === "warning" ? <Warning size={16} /> : <Info size={16} />}
                <div>
                  <div className="q-insight-title">{insight.title}</div>
                  <div className="q-insight-detail">{insight.detail}</div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {state.records.length === 0 ? (
        <div className="q-empty">
          <Table size={22} style={{ color: "var(--ink-quaternary)" }} />
          <span className="q-empty-title">台账还是空的</span>
          <p className="q-empty-body">
            在网申页面点击“填写”之后，Quill 会询问是否记录这次投递。你也可以在这里手动新增一条。
          </p>
        </div>
      ) : (
        <>
          <div className="q-toolbar" style={{ marginBottom: "var(--s-4)" }}>
            <label className="q-search">
              <Search size={15} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索公司、岗位或备注"
                aria-label="搜索投递记录"
              />
              {query && (
                <button type="button" className="q-icon-btn" onClick={() => setQuery("")} aria-label="清除搜索">
                  <X size={13} />
                </button>
              )}
            </label>

            <div className="q-segmented">
              {FILTERS.map((item) => (
                <button key={item.id} type="button" aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>
                  {item.label}
                </button>
              ))}
            </div>

            <div className="q-segmented">
              {(
                [
                  ["urgency", "按待办"],
                  ["recent", "按最近"],
                  ["stage", "按阶段"],
                ] as const
              ).map(([id, label]) => (
                <button key={id} type="button" aria-pressed={sort === id} onClick={() => setSort(id)}>
                  {label}
                </button>
              ))}
            </div>

            <span className="q-cap" style={{ marginLeft: "auto" }}>
              {visible.length} / {state.records.length} 条
            </span>
          </div>

          <div style={{ overflowX: "auto" }}>
            <table className="q-table">
              <thead>
                <tr>
                  <th>公司</th>
                  <th>岗位</th>
                  <th>阶段</th>
                  <th>投递日期</th>
                  <th>下一步</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {visible.map((record, index) => (
                  <tr key={record.id} onClick={() => setOpenId(record.id)} style={{ cursor: "pointer" }}>
                    <td data-label="公司">
                      <span className="q-strong">{record.company || "未填写"}</span>
                      {record.city && <span className="q-cap" style={{ marginLeft: "0.5rem" }}>{record.city}</span>}
                    </td>
                    <td data-label="岗位">{record.role || "未填写"}</td>
                    <td data-label="阶段">
                      <StageChip stage={record.stage} />
                    </td>
                    <td data-label="投递日期" className="q-num">
                      {record.appliedAt ? formatDate(record.appliedAt) : "—"}
                    </td>
                    <td data-label="下一步">
                      {record.nextAction ? (
                        <span className={record.nextAction.dueAt && record.nextAction.dueAt < Date.now() ? "q-chip q-chip-orange" : "q-sub"}>
                          {record.nextAction.what}
                          {record.nextAction.dueAt ? ` · ${deadlineLabel(record.nextAction.dueAt)}` : ""}
                        </span>
                      ) : (
                        <span className="q-cap">—</span>
                      )}
                    </td>
                    <td style={{ width: "2rem" }}>
                      <ChevronRight size={15} style={{ color: "var(--ink-quaternary)" }} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {visible.length === 0 && (
            <div className="q-empty">
              <span className="q-empty-body">没有匹配的记录。试试清空搜索条件。</span>
            </div>
          )}
        </>
      )}

      {open && (
        <RecordSheet
          key={open.id}
          record={open}
          onClose={() => setOpenId(undefined)}
          onToast={onToast}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------ components */

function Metric({ value, label, hint }: { value: number; label: string; hint?: string }): JSX.Element {
  return (
    <div className="q-metric">
      <div className="q-metric-value">{value}</div>
      <div className="q-metric-label">{label}</div>
      {hint && <div className="q-cap">{hint}</div>}
    </div>
  );
}

function StageChip({ stage }: { stage: ApplicationStage }): JSX.Element {
  const tone =
    stage === "offer"
      ? "q-chip-green"
      : stage === "rejected" || stage === "withdrawn"
        ? "q-chip-neutral"
        : stage.startsWith("interview")
          ? "q-chip-purple"
          : stage === "assessment"
            ? "q-chip-teal"
            : stage === "draft"
              ? "q-chip-neutral"
              : "q-chip-accent";
  return <span className={`q-chip ${tone}`}>{STAGE_LABELS[stage]}</span>;
}

interface BasicsDraft {
  company: string;
  role: string;
  city: string;
  salary: string;
}

function basicsOf(record: ApplicationRecord): BasicsDraft {
  return {
    company: record.company,
    role: record.role,
    city: record.city ?? "",
    salary: record.salary ?? "",
  };
}

function RecordSheet({
  record,
  onClose,
  onToast,
}: {
  record: ApplicationRecord;
  onClose: () => void;
  onToast: Toast;
}): JSX.Element {
  const { reload } = useWorkbench();
  const [note, setNote] = useState("");
  const [action, setAction] = useState("");

  /*
   * The basics are edited locally and persisted on a short debounce (and on
   * blur). Writing to the store on every keystroke re-rendered the controlled
   * inputs while a Chinese IME was still composing, which committed the pinyin
   * ("tengxun") and swallowed characters. Keeping a synchronous local draft
   * fixes that; merging the draft into every other update means a stage click
   * cannot overwrite half-typed text with the stale record.
   */
  const [basics, setBasics] = useState<BasicsDraft>(() => basicsOf(record));
  const basicsRef = useRef(basics);
  const committedRef = useRef(basics);
  const recordRef = useRef(record);
  const saveTimer = useRef<number | undefined>(undefined);
  recordRef.current = record;

  const update = useCallback(
    async (next: ApplicationRecord) => {
      await getStore().saveRecord(next);
      await reload();
    },
    [reload],
  );

  const mergeBasics = useCallback((base: ApplicationRecord): ApplicationRecord => {
    const draft = basicsRef.current;
    return {
      ...base,
      company: draft.company,
      role: draft.role,
      city: draft.city || undefined,
      salary: draft.salary || undefined,
      updatedAt: Date.now(),
    };
  }, []);

  const saveNow = useCallback(
    (base: ApplicationRecord) => {
      if (saveTimer.current !== undefined) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = undefined;
      }
      committedRef.current = basicsRef.current;
      void update(mergeBasics(base));
    },
    [mergeBasics, update],
  );

  const commitBasics = useCallback(() => {
    if (committedRef.current === basicsRef.current) {
      if (saveTimer.current !== undefined) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = undefined;
      }
      return;
    }
    saveNow(recordRef.current);
  }, [saveNow]);

  const editBasics = useCallback(
    (patch: Partial<BasicsDraft>) => {
      const next = { ...basicsRef.current, ...patch };
      basicsRef.current = next;
      setBasics(next);
      if (saveTimer.current !== undefined) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        saveTimer.current = undefined;
        saveNow(recordRef.current);
      }, 600);
    },
    [saveNow],
  );

  const applyRecord = useCallback(
    (base: ApplicationRecord) => {
      saveNow(base);
    },
    [saveNow],
  );

  const cancelPending = useCallback(() => {
    if (saveTimer.current !== undefined) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = undefined;
    }
  }, []);

  useEffect(() => () => cancelPending(), [cancelPending]);

  const closeSheet = useCallback(() => {
    commitBasics();
    onClose();
  }, [commitBasics, onClose]);

  const stageProgress = useMemo(() => {
    const sequence: ApplicationStage[] = ["draft", "submitted", "screening", "assessment", "interview-1", "interview-2", "interview-3", "offer"];
    const at = sequence.indexOf(record.stage);
    return { sequence, at, closed: isClosed(record.stage) };
  }, [record.stage]);

  return (
    <>
      <div className="q-scrim" onClick={closeSheet} />
      <aside className="q-sheet" role="dialog" aria-label={`${basics.company || "未填写公司"} 的投递详情`}>
        <header className="q-sheet-head">
          <div className="q-grow">
            <div style={{ fontSize: "var(--text-title)", fontWeight: 600, letterSpacing: "-0.01em" }}>
              {basics.company || "未填写公司"}
            </div>
            <div className="q-cap">
              {basics.role || "未填写岗位"}
              {basics.city ? ` · ${basics.city}` : ""}
            </div>
          </div>
          {record.url && (
            <a className="q-icon-btn" href={record.url} target="_blank" rel="noreferrer" aria-label="打开原始页面">
              <External size={16} />
            </a>
          )}
          <button type="button" className="q-icon-btn" onClick={closeSheet} aria-label="关闭">
            <X size={16} />
          </button>
        </header>

        <div className="q-sheet-body quill-scroll">
          {/* Editable basics. */}
          <div className="q-grid q-grid-2" style={{ marginBottom: "var(--s-5)" }}>
            <label className="q-field-group">
              <span className="q-label">公司</span>
              <input
                className="q-input"
                value={basics.company}
                onChange={(event) => editBasics({ company: event.target.value })}
                onBlur={commitBasics}
              />
            </label>
            <label className="q-field-group">
              <span className="q-label">岗位</span>
              <input
                className="q-input"
                value={basics.role}
                onChange={(event) => editBasics({ role: event.target.value })}
                onBlur={commitBasics}
              />
            </label>
            <label className="q-field-group">
              <span className="q-label">城市</span>
              <input
                className="q-input"
                value={basics.city}
                onChange={(event) => editBasics({ city: event.target.value })}
                onBlur={commitBasics}
              />
            </label>
            <label className="q-field-group">
              <span className="q-label">薪资</span>
              <input
                className="q-input"
                value={basics.salary}
                onChange={(event) => editBasics({ salary: event.target.value })}
                onBlur={commitBasics}
              />
            </label>
          </div>

          {/* Stage. */}
          <div className="q-field-group" style={{ marginBottom: "var(--s-5)" }}>
            <span className="q-label">当前阶段</span>
            {!stageProgress.closed && (
              <div className="q-stage-track" aria-hidden="true">
                {stageProgress.sequence.map((_, index) => (
                  <span
                    key={index}
                    className="q-stage-seg"
                    data-done={index <= stageProgress.at}
                  />
                ))}
              </div>
            )}
            <div className="q-toolbar" style={{ marginTop: "var(--s-2)" }}>
              {(Object.keys(STAGE_LABELS) as ApplicationStage[]).map((stage) => (
                <button
                  key={stage}
                  type="button"
                  className={`q-btn q-btn-sm ${record.stage === stage ? "q-btn-secondary" : "q-btn-ghost"}`}
                  aria-pressed={record.stage === stage}
                  onClick={() => applyRecord(advanceStage(record, stage))}
                >
                  {record.stage === stage && <Check size={13} />}
                  {STAGE_LABELS[stage]}
                </button>
              ))}
            </div>
          </div>

          {/* Next action. */}
          <div className="q-field-group" style={{ marginBottom: "var(--s-5)" }}>
            <span className="q-label">下一步行动</span>
            {record.nextAction ? (
              <div className="q-group">
                <div className="q-group-row">
                  <Clock size={15} style={{ color: "var(--accent)", flex: "none" }} />
                  <div className="q-grow">
                    <div className="q-strong">{record.nextAction.what}</div>
                    {record.nextAction.dueAt && (
                      <div className="q-cap">
                        {formatDate(record.nextAction.dueAt)} · {deadlineLabel(record.nextAction.dueAt)}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    className="q-btn q-btn-ghost q-btn-sm"
                    onClick={() => {
                      const cleared = { ...record };
                      delete cleared.nextAction;
                      applyRecord(cleared);
                    }}
                  >
                    清除
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", gap: "var(--s-2)" }}>
                <input
                  className="q-input"
                  value={action}
                  placeholder="例如：跟进 HR、准备笔试"
                  onChange={(event) => setAction(event.target.value)}
                />
                <button
                  type="button"
                  className="q-btn q-btn-outline"
                  disabled={!action.trim()}
                  onClick={() => {
                    applyRecord(setNextAction(record, action.trim()));
                    setAction("");
                  }}
                >
                  <Plus size={14} />
                  添加
                </button>
              </div>
            )}
          </div>

          {/* Submitted content, for recall before an interview. */}
          {record.submittedFields && record.submittedFields.length > 0 && (
            <div style={{ marginBottom: "var(--s-5)" }}>
              <div className="q-eyebrow" style={{ marginBottom: "var(--s-3)" }}>
                当时提交的内容
              </div>
              <div className="q-group">
                {record.submittedFields.map((field, index) => (
                  <div className="q-group-row" key={index} style={{ alignItems: "flex-start" }}>
                    <span className="q-cap" style={{ width: "7rem", flex: "none" }}>
                      {field.label}
                    </span>
                    <span className="q-grow" style={{ fontSize: "var(--text-sub)" }}>
                      {field.value}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Timeline. */}
          <div style={{ marginBottom: "var(--s-5)" }}>
            <div className="q-eyebrow" style={{ marginBottom: "var(--s-3)" }}>
              进展记录
            </div>
            <div className="q-timeline">
              {[...record.timeline].reverse().map((entry, index) => (
                <div className="q-timeline-item" key={index}>
                  <div style={{ fontSize: "var(--text-sub)" }}>{entry.note}</div>
                  <div className="q-cap">{relativeTime(entry.at)}</div>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: "var(--s-2)", marginTop: "var(--s-3)" }}>
              <input
                className="q-input"
                value={note}
                placeholder="记录一次沟通、一次面试反馈…"
                onChange={(event) => setNote(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && note.trim()) {
                    applyRecord(addNote(record, note.trim()));
                    setNote("");
                  }
                }}
              />
              <button
                type="button"
                className="q-btn q-btn-outline"
                disabled={!note.trim()}
                onClick={() => {
                  applyRecord(addNote(record, note.trim()));
                  setNote("");
                }}
              >
                记录
              </button>
            </div>
          </div>
        </div>

        <footer className="q-sheet-foot">
          <button
            type="button"
            className="q-btn q-btn-danger"
            onClick={() => {
              // A pending debounce would otherwise save the record back after
              // it was deleted.
              cancelPending();
              void getStore()
                .deleteRecord(record.id)
                .then(() => reload())
                .then(() => {
                  onClose();
                  onToast("已删除该记录", "success");
                });
            }}
          >
            <Trash size={15} />
            删除记录
          </button>
          <div className="q-grow" />
          <button type="button" className="q-btn q-btn-primary" onClick={closeSheet}>
            完成
          </button>
        </footer>
      </aside>
    </>
  );
}
