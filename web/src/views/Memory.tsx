/**
 * The memory library.
 *
 * This view exists because a system that learns from you in the background owes
 * you a place to see what it learned and delete it. Without this screen,
 * "learning" is indistinguishable from "quietly accumulating data about you".
 *
 * Sensitive values are masked by default with an explicit reveal, and every
 * entry shows where it came from and how many times it has been used.
 */

import { useCallback, useMemo, useState, type JSX } from "react";
import {
  conflictingMemory,
  isSensitiveKey,
  maskValue,
  previewMemory,
  suggestPromotions,
  type MemoryEntry,
} from "@quill/core";
import { useWorkbench } from "../state.js";
import { getStore } from "../data/store.js";
import { relativeTime } from "../data/format.js";
import {
  Brain,
  Check,
  Eye,
  Info,
  Lock,
  Search,
  Trash,
  Warning,
  X,
} from "../icons.js";

type Toast = (text: string, tone?: "neutral" | "success" | "error") => void;

export function MemoryView({ onToast }: { onToast: Toast }): JSX.Element {
  const { state, reload } = useWorkbench();
  const [query, setQuery] = useState("");
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | undefined>();
  const [draft, setDraft] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return state.memory;
    return state.memory.filter((entry) =>
      [entry.labelSnapshot, entry.value, entry.key].join(" ").toLowerCase().includes(needle),
    );
  }, [query, state.memory]);

  const conflicts = useMemo(() => conflictingMemory(state.memory), [state.memory]);

  /** Answers typed repeatedly that are not yet part of the profile. */
  const promotions = useMemo(() => {
    if (!state.profile) return [];
    const inUse = new Set<string>();
    const profile = state.profile;
    // Only flag promotions for values the profile genuinely lacks.
    if (profile.identity.idNumber) inUse.add("identity.idNumber");
    if (profile.identity.maritalStatus) inUse.add("identity.maritalStatus");
    if (profile.contact.wechat) inUse.add("contact.wechat");
    return suggestPromotions(state.memory, inUse);
  }, [state.memory, state.profile]);

  const saveEntry = useCallback(
    async (entry: MemoryEntry) => {
      const next = await getStore().saveMemory({ ...entry, updatedAt: Date.now(), reviewed: true });
      await reload();
      void next;
      onToast("已更新这条记忆", "success");
    },
    [onToast, reload],
  );

  const removeEntry = useCallback(
    async (id: string) => {
      await getStore().deleteMemory(id);
      await reload();
      onToast("已删除，下次不会再使用这条内容", "success");
    },
    [onToast, reload],
  );

  return (
    <div className="q-page">
      <header className="q-page-head q-reveal">
        <div className="q-between" style={{ alignItems: "flex-start", gap: "var(--s-4)", flexWrap: "wrap" }}>
          <div>
            <h1 className="q-page-title">Quill 帮你记住了这些。</h1>
            <p className="q-page-lead">
              当某个字段资料库里没有、而你自己动手填写时，Quill 会记下那次答案。
              这里列出了全部内容，你可以核对、修改或删除。删除后下次不会再使用。
            </p>
          </div>
          {state.memory.length > 0 && (
            <div className="q-toolbar">
              {confirmClear ? (
                <>
                  <button type="button" className="q-btn q-btn-outline" onClick={() => setConfirmClear(false)}>
                    保留
                  </button>
                  <button
                    type="button"
                    className="q-btn q-btn-primary"
                    style={{ background: "var(--red)" }}
                    onClick={() => {
                      void getStore()
                        .clearMemory()
                        .then(() => reload())
                        .then(() => {
                          setConfirmClear(false);
                          onToast("已清空全部记忆", "success");
                        });
                    }}
                  >
                    确认清空 {state.memory.length} 条
                  </button>
                </>
              ) : (
                <button type="button" className="q-btn q-btn-danger" onClick={() => setConfirmClear(true)}>
                  <Trash size={15} />
                  清空全部
                </button>
              )}
            </div>
          )}
        </div>
      </header>

      {state.memory.length === 0 ? (
        <div className="q-empty">
          <Brain size={22} style={{ color: "var(--ink-quaternary)" }} />
          <span className="q-empty-title">还没有记住任何内容</span>
          <p className="q-empty-body">
            当你第一次在网申页面手动填写一个资料库里没有的字段时，答案会出现在这里。
          </p>
        </div>
      ) : (
        <>
          {conflicts.length > 0 && (
            <section className="q-block">
              <div className="q-insight" data-kind="warning" style={{ marginBottom: "var(--s-4)" }}>
                <Warning size={16} />
                <div>
                  <div className="q-insight-title">{conflicts.length} 个字段存在不同版本的答案</div>
                  <div className="q-insight-detail">
                    同一个字段记录过多个不同的值，Quill 会使用最近一次。如果其中有不正确的，请在这里删掉。
                  </div>
                </div>
              </div>
              <div className="q-group">
                {conflicts.map((conflict) => (
                  <div key={conflict.key} className="q-group-row" style={{ alignItems: "flex-start" }}>
                    <span className="q-cap" style={{ width: "8rem", flex: "none" }}>
                      {conflict.entries[0]?.labelSnapshot || conflict.key}
                    </span>
                    <div className="q-grow" style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                      {conflict.entries.map((entry) => (
                        <div key={entry.id} className="q-memory-conflict-row">
                          <span className="q-chip q-chip-neutral q-memory-conflict-value">{entry.value}</span>
                          <span className="q-cap">{relativeTime(entry.updatedAt)}</span>
                          <button
                            type="button"
                            className="q-icon-btn"
                            aria-label={`删除 ${entry.value}`}
                            onClick={() => void removeEntry(entry.id)}
                          >
                            <X size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {promotions.length > 0 && (
            <section className="q-block">
              <div className="q-block-head">
                <div>
                  <h2 className="q-block-title">可以补充进简历</h2>
                  <p className="q-block-sub">
                    这些内容你已经反复填写过，但还不在简历资料里。补充进去之后，所有网申都能直接用到。
                  </p>
                </div>
              </div>
              <div className="q-group">
                {promotions.map((promotion) => (
                  <div className="q-group-row" key={promotion.key}>
                    <Info size={15} style={{ color: "var(--accent)", flex: "none" }} />
                    <div className="q-grow">
                      <div className="q-strong">{promotion.value}</div>
                      <div className="q-cap">{promotion.reason}</div>
                    </div>
                    <span className="q-chip q-chip-neutral">{promotion.key}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          <div className="q-toolbar" style={{ marginBottom: "var(--s-4)" }}>
            <label className="q-search">
              <Search size={15} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索字段名或内容"
                aria-label="搜索记忆"
              />
              {query && (
                <button type="button" className="q-icon-btn" onClick={() => setQuery("")} aria-label="清除">
                  <X size={13} />
                </button>
              )}
            </label>
            <span className="q-cap" style={{ marginLeft: "auto" }}>
              {filtered.length} / {state.memory.length} 条
            </span>
          </div>

          <div className="q-grid q-grid-2">
            {filtered.map((entry) => {
              const sensitive = isSensitiveKey(entry.key);
              const isRevealed = revealed.has(entry.id);
              const isEditing = editing === entry.id;
              const preview = previewMemory(entry);

              return (
                <div className="q-card-lg q-memory-card q-reveal" key={entry.id}>
                  <div className="q-between q-memory-head" style={{ marginBottom: "var(--s-3)" }}>
                    <span className="q-label q-memory-label">
                      <span className="q-truncate" title={entry.labelSnapshot}>
                        {entry.labelSnapshot || entry.key}
                      </span>
                      {sensitive && <Lock size={12} style={{ color: "var(--ink-tertiary)", flex: "none" }} />}
                    </span>
                    <div className="q-memory-actions">
                      {sensitive && (
                        <button
                          type="button"
                          className="q-icon-btn"
                          aria-label={isRevealed ? "隐藏内容" : "显示内容"}
                          aria-pressed={isRevealed}
                          onClick={() =>
                            setRevealed((current) => {
                              const next = new Set(current);
                              if (next.has(entry.id)) next.delete(entry.id);
                              else next.add(entry.id);
                              return next;
                            })
                          }
                        >
                          <Eye size={14} />
                        </button>
                      )}
                      <button
                        type="button"
                        className="q-icon-btn"
                        aria-label="编辑"
                        onClick={() => {
                          setEditing(entry.id);
                          setDraft(entry.value);
                        }}
                      >
                        <Check size={14} />
                      </button>
                      <button
                        type="button"
                        className="q-icon-btn"
                        aria-label="删除"
                        onClick={() => void removeEntry(entry.id)}
                      >
                        <Trash size={14} />
                      </button>
                    </div>
                  </div>

                  {isEditing ? (
                    <div className="q-memory-editor">
                      <textarea
                        className="q-textarea"
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={(event) => {
                          // Enter belongs to the value: these entries can be paragraphs.
                          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                            void saveEntry({ ...entry, value: draft.trim() });
                            setEditing(undefined);
                          }
                          if (event.key === "Escape") setEditing(undefined);
                        }}
                        autoFocus
                      />
                      <div className="q-memory-editor-actions">
                        <span className="q-cap">⌘/Ctrl + Enter 保存 · Esc 取消</span>
                        <button
                          type="button"
                          className="q-btn q-btn-primary q-btn-sm"
                          disabled={!draft.trim()}
                          onClick={() => {
                            void saveEntry({ ...entry, value: draft.trim() });
                            setEditing(undefined);
                          }}
                        >
                          保存
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="q-memory-value">
                      {sensitive && !isRevealed ? preview.value || maskValue(entry.value) : entry.value}
                    </div>
                  )}

                  <div className="q-cap" style={{ marginTop: "var(--s-3)", display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
                    <span>
                      {entry.origin === "confirmed" ? "已确认" : entry.origin === "learned" ? "自动记录" : "导入"}
                    </span>
                    <span>·</span>
                    <span>使用 {entry.hits} 次</span>
                    <span>·</span>
                    <span>{relativeTime(entry.updatedAt)}</span>
                    {entry.siteKey && (
                      <>
                        <span>·</span>
                        <span>仅 {entry.siteKey}</span>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {filtered.length === 0 && (
            <div className="q-empty">
              <span className="q-empty-body">没有匹配的记忆。</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
