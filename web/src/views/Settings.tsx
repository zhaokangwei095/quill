/**
 * Settings for the workbench.
 *
 * Deliberately a superset of the extension's options page: the appearance and
 * behaviour toggles are the same, plus data portability, because a person who
 * invested an hour in a ledger needs a way to take it with them.
 */

import { useCallback, useState, type JSX } from "react";
import { DEFAULT_SETTINGS, type Settings } from "@quill/core";
import { useWorkbench } from "../state.js";
import { getStore } from "../data/store.js";
import { downloadFile } from "../data/format.js";
import { Check, Download, Lock, Settings as SettingsIcon, Trash, Upload, Warning } from "../icons.js";

type Toast = (text: string, tone?: "neutral" | "success" | "error") => void;

export function SettingsView({ onToast }: { onToast: Toast }): JSX.Element {
  const { state, reload, updateSettings } = useWorkbench();
  const [confirmErase, setConfirmErase] = useState(false);
  const [importError, setImportError] = useState<string | undefined>();

  const settings = state.settings ?? DEFAULT_SETTINGS;

  const exportAll = useCallback(() => {
    const payload = JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        version: 1,
        profile: state.profile,
        memory: state.memory,
        analyses: state.analyses,
        reports: state.reports,
        records: state.records,
        settings: state.settings,
      },
      null,
      2,
    );
    downloadFile(`quill-备份-${new Date().toISOString().slice(0, 10)}.json`, payload, "application/json");
    onToast("已导出备份文件", "success");
  }, [onToast, state]);

  const importAll = useCallback(
    async (file: File) => {
      try {
        const parsed = JSON.parse(await file.text()) as Record<string, unknown>;
        const store = getStore();
        if (parsed.profile) await store.saveProfile(parsed.profile as never);
        if (Array.isArray(parsed.memory)) {
          for (const entry of parsed.memory) await store.saveMemory(entry as never);
        }
        if (Array.isArray(parsed.records)) {
          for (const record of parsed.records) await store.saveRecord(record as never);
        }
        if (Array.isArray(parsed.reports)) {
          for (const report of parsed.reports) await store.saveReport(report as never);
        }
        if (parsed.settings) await store.saveSettings({ ...DEFAULT_SETTINGS, ...(parsed.settings as object) });
        await reload();
        setImportError(undefined);
        onToast("已导入备份", "success");
      } catch {
        setImportError("这个文件不是 Quill 导出的备份，或内容已损坏。");
      }
    },
    [onToast, reload],
  );

  return (
    <div className="q-page">
      <header className="q-page-head q-reveal">
        <div className="q-eyebrow" style={{ marginBottom: "var(--s-3)" }}>
          <SettingsIcon size={13} style={{ verticalAlign: "-2px", marginRight: "var(--s-1)" }} />
          设置
        </div>
        <h1 className="q-page-title">你决定 Quill 能做什么。</h1>
        <p className="q-page-lead">
          所有开关默认都是保守的：不擅自覆盖你已填的内容，不在你不知情的情况下记住任何东西。
        </p>
      </header>

      <Section title="填写行为" description="扩展在网申页面上能做到什么程度。">
        <Toggle
          title="自动识别页面字段"
          description="打开网申页面时自动扫描。关闭后需要手动点击扩展图标。"
          checked={settings.autoScan}
          onChange={(checked) => void updateSettings({ autoScan: checked })}
        />
        <Toggle
          title="不覆盖已填写的内容"
          description="页面上已经有值的字段会被跳过。除非你明确要求，Quill 不会改写它们。"
          checked={settings.preserveExisting}
          onChange={(checked) => void updateSettings({ preserveExisting: checked })}
        />
        <Toggle
          title="高置信度字段直接填写"
          description="来自你已确认记录的字段不再逐一询问。关闭后每一项都需要你点“填写”。"
          checked={settings.autoApplyConfident}
          onChange={(checked) => void updateSettings({ autoApplyConfident: checked })}
        />
        <Toggle
          title="填写后高亮标出"
          description="填过的字段会短暂描边，方便你快速核对。"
          checked={settings.highlightFilled}
          onChange={(checked) => void updateSettings({ highlightFilled: checked })}
        />
      </Section>

      <Section title="学习与记忆" description="扩展如何从你的操作中积累经验。">
        <Toggle
          title="记住我手动填写的内容"
          description="资料库里没有的字段，在你亲手填写后会被记录。"
          checked={settings.learnFromUserInput}
          onChange={(checked) => void updateSettings({ learnFromUserInput: checked })}
        />
        <Toggle
          title="需要我确认后再记忆"
          description="关闭后手填内容会直接计入记忆；开启时它们会标为待核对。"
          checked={settings.confirmLearned}
          onChange={(checked) => void updateSettings({ confirmLearned: checked })}
        />
        <Toggle
          title="自动整理长文本回答"
          description="自我介绍这类问题如果资料库里没有现成答案，Quill 会用你的真实经历组织草稿，并明确标注是它整理的。"
          checked={settings.composeEssays}
          onChange={(checked) => void updateSettings({ composeEssays: checked })}
        />
      </Section>

      <Section title="外观" description="工作台与浏览器扩展遵循同一套设计。">
        <div className="q-setting-group">
          {(["system", "light", "dark"] as const).map((option) => (
            <button
              key={option}
              type="button"
              className={`q-btn ${settings.appearance === option ? "q-btn-secondary" : "q-btn-ghost"}`}
              aria-pressed={settings.appearance === option}
              onClick={() => void updateSettings({ appearance: option })}
            >
              {settings.appearance === option && <Check size={14} />}
              {option === "system" ? "跟随系统" : option === "light" ? "浅色" : "深色"}
            </button>
          ))}
        </div>
      </Section>

      <Section title="数据" description="全部保存在这台设备的浏览器里，不上传任何服务器。">
        <div style={{ padding: "var(--s-4)", display: "flex", flexDirection: "column", gap: "var(--s-4)" }}>
          <div className="q-between" style={{ alignItems: "flex-start", gap: "var(--s-4)", flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: "14rem" }}>
              <div className="q-setting-title">导出备份</div>
              <div className="q-setting-desc">
                导出简历资料、记忆、岗位分析与投递记录为 JSON 文件。
              </div>
            </div>
            <button type="button" className="q-btn q-btn-outline" onClick={exportAll} disabled={!state.profile}>
              <Download size={15} />
              导出
            </button>
          </div>

          <hr />

          <div className="q-between" style={{ alignItems: "flex-start", gap: "var(--s-4)", flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: "14rem" }}>
              <div className="q-setting-title">从备份导入</div>
              <div className="q-setting-desc">导入后会与现有数据合并，同名内容以导入的为准。</div>
            </div>
            <label className="q-btn q-btn-outline">
              <Upload size={15} />
              选择文件
              <input
                type="file"
                accept="application/json,.json"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void importAll(file);
                  event.target.value = "";
                }}
              />
            </label>
          </div>

          {importError && (
            <div className="q-insight" data-kind="warning">
              <Warning size={16} />
              <div className="q-insight-detail">{importError}</div>
            </div>
          )}

          <hr />

          <div className="q-between" style={{ alignItems: "flex-start", gap: "var(--s-4)", flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: "14rem" }}>
              <div className="q-setting-title">删除全部数据</div>
              <div className="q-setting-desc">
                永久删除简历、记忆、分析与投递记录。此操作无法撤销。
              </div>
            </div>
            {confirmErase ? (
              <div style={{ display: "flex", gap: "var(--s-2)" }}>
                <button type="button" className="q-btn q-btn-outline" onClick={() => setConfirmErase(false)}>
                  保留数据
                </button>
                <button
                  type="button"
                  className="q-btn q-btn-primary"
                  style={{ background: "var(--red)" }}
                  onClick={() => {
                    void (async () => {
                      await getStore().clearMemory();
                      localStorage.clear();
                      await chrome?.storage?.local?.clear?.().catch(() => {});
                      setConfirmErase(false);
                      await reload();
                      onToast("已删除全部本地数据", "success");
                    })();
                  }}
                >
                  <Trash size={15} />
                  确认删除
                </button>
              </div>
            ) : (
              <button type="button" className="q-btn q-btn-danger" onClick={() => setConfirmErase(true)}>
                <Trash size={15} />
                删除
              </button>
            )}
          </div>
        </div>
      </Section>

      <div className="q-consent" style={{ marginTop: "var(--s-8)" }}>
        <Lock />
        <div>
          Quill 不连接任何服务器。你的简历与填写内容不会离开这台设备，也不会被用于训练模型。
          唯一的例外是你在这里点击“导出”。
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section className="q-block">
      <h2 className="q-block-title" style={{ fontSize: "var(--text-h4)" }}>
        {title}
      </h2>
      <p className="q-block-sub" style={{ marginBottom: "var(--s-4)" }}>
        {description}
      </p>
      <div className="q-card-lg" style={{ padding: 0 }}>
        {children}
      </div>
    </section>
  );
}

function Toggle({
  title,
  description,
  checked,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}): JSX.Element {
  return (
    <div className="q-setting">
      <div className="q-setting-body">
        <div className="q-setting-title">{title}</div>
        <div className="q-setting-desc">{description}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={title}
        className="q-switch"
        onClick={() => onChange(!checked)}
      />
    </div>
  );
}
