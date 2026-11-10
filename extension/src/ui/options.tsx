/**
 * Settings.
 *
 * Grouped by *consequence*, not by data model: what Quill may write, what it may
 * remember, and how it looks. Each toggle states its effect in one sentence and
 * nothing is enabled that the person has not been told about.
 */

import { useCallback, useState, type JSX } from "react";
import { createRoot } from "react-dom/client";
import { DEFAULT_SETTINGS, customModelReady, type Settings } from "@quill/core";
import { useExtensionState, useToast } from "./hooks.js";
import { download, send } from "./shared.js";
import { Check, Download, Lock, Settings as SettingsIcon, Sparkle, Trash } from "./icons.js";

function Options(): JSX.Element {
  const { state, loading, reload } = useExtensionState();
  const { toast, show } = useToast();
  const [busy, setBusy] = useState(false);
  const [confirmingErase, setConfirmingErase] = useState(false);

  const settings = state?.settings ?? DEFAULT_SETTINGS;

  const update = useCallback(
    async (patch: Partial<Settings>) => {
      const next = { ...settings, ...patch };
      setBusy(true);
      try {
        await send({ type: "save-settings", settings: next });
        show("已保存", "success");
      } catch (error) {
        show(error instanceof Error ? error.message : "保存失败", "error");
      } finally {
        setBusy(false);
      }
    },
    [settings, show],
  );

  const exportData = useCallback(async () => {
    const response = await chrome.runtime.sendMessage({ type: "get-state" });
    if (!response?.ok) return;
    const exportedSettings: Settings = {
      ...response.state.settings,
      // API keys are credentials, not data. A backup travels through chat apps
      // and cloud drives, so it must never carry one.
      model: { ...response.state.settings.model, apiKey: "", enabled: false },
      resumeModel: { ...response.state.settings.resumeModel, betaCode: "" },
    };
    const payload = JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        version: 1,
        profile: response.state.profile,
        memory: response.state.memory,
        analyses: response.state.analyses,
        reports: response.state.reports,
        records: response.state.records,
        settings: exportedSettings,
      },
      null,
      2,
    );
    download(`quill-backup-${new Date().toISOString().slice(0, 10)}.json`, payload, "application/json");
    show("已导出（不包含 API Key 与访问码）", "success");
  }, [show]);

  const erase = useCallback(async () => {
    await chrome.storage.local.clear();
    setConfirmingErase(false);
    await reload();
    show("已删除全部本地数据", "success");
  }, [reload, show]);

  if (loading) {
    return (
      <div style={{ maxWidth: "44rem", margin: "0 auto", padding: "var(--s-10) var(--s-6)" }}>
        {[0, 1, 2].map((index) => (
          <div key={index} className="q-skeleton" style={{ height: "4rem", marginBottom: "var(--s-3)" }} />
        ))}
      </div>
    );
  }

  return (
    <div style={{ maxWidth: "44rem", margin: "0 auto", padding: "var(--s-10) var(--s-6) var(--s-24)" }}>
      <header style={{ marginBottom: "var(--s-10)" }}>
        <div className="q-eyebrow" style={{ marginBottom: "var(--s-3)" }}>
          <SettingsIcon size={13} style={{ verticalAlign: "-2px", marginRight: "var(--s-1)" }} />
          Quill 设置
        </div>
        <h1 className="q-display" style={{ fontSize: "2.25rem" }}>
          你决定 Quill 能做什么。
        </h1>
        <p className="q-sub" style={{ marginTop: "var(--s-4)", maxWidth: "48ch", fontSize: "var(--text-body)" }}>
          所有开关默认都是保守的：不擅自覆盖你已填的内容，不擅自把答案提交出去。
        </p>
      </header>

      <Section title="填写行为" description="Quill 在网申页面上能做到什么程度。">
        <Toggle
          title="自动识别页面字段"
          description="打开网申页面时自动扫描，不再需要手动点“识别”。"
          checked={settings.autoScan}
          disabled={busy}
          onChange={(checked) => void update({ autoScan: checked })}
        />
        <Toggle
          title="不覆盖已填写的内容"
          description="页面上已经有值的字段会被跳过，保持原样。建议保持开启。"
          checked={settings.preserveExisting}
          disabled={busy}
          onChange={(checked) => void update({ preserveExisting: checked })}
        />
        <Toggle
          title="高置信度字段直接填写"
          description="来自你已确认记录的字段不再逐一询问。关闭后，每一项都需要你点“填写”。"
          checked={settings.autoApplyConfident}
          disabled={busy}
          onChange={(checked) => void update({ autoApplyConfident: checked })}
        />
        <Toggle
          title="填写后用描边标出"
          description="填过的字段会短暂高亮，方便你快速核对。"
          checked={settings.highlightFilled}
          disabled={busy}
          onChange={(checked) => void update({ highlightFilled: checked })}
        />
      </Section>

      <Section title="学习与记忆" description="Quill 如何从你的操作中积累经验。">
        <Toggle
          title="记住我手动填写的内容"
          description="资料库中没有的字段，在你亲手填写后会被记录，下次直接给出建议。"
          checked={settings.learnFromUserInput}
          disabled={busy}
          onChange={(checked) => void update({ learnFromUserInput: checked })}
        />
        <Toggle
          title="需要我确认后再记忆"
          description="关闭后，手填内容会直接计为已确认的记忆；开启时只在工作台里待你核对。"
          checked={settings.confirmLearned}
          disabled={busy}
          onChange={(checked) => void update({ confirmLearned: checked })}
        />
        <Toggle
          title="自动整理长文本回答"
          description="自我介绍、职业规划这类问题，如果资料库里没有现成答案，Quill 会用你的真实经历组织一段草稿，并标注“由简历整理生成”。"
          checked={settings.composeEssays}
          disabled={busy}
          onChange={(checked) => void update({ composeEssays: checked })}
        />
      </Section>

      <Section title="简历识别" description="默认本机解析；也可以启用识别服务或自己的模型。">
        <Toggle
          title="使用模型识别简历"
          description="新上传简历的文字会发送到识别服务器做转写与结构化，扫描件和图片也能读取。服务器地址、访问码与连接测试在工作台的「设置 → 简历识别」里。"
          checked={settings.resumeModel.enabled}
          disabled={busy}
          onChange={(checked) =>
            void update({ resumeModel: { ...settings.resumeModel, enabled: checked } })
          }
        />
        <div className="q-setting">
          <div className="q-setting-body">
            <div className="q-setting-title">我自己的模型</div>
            <div className="q-setting-desc">
              {customModelReady(settings.model)
                ? `已启用：${settings.model?.model || "未命名模型"}。简历文字与岗位描述会直接从浏览器发往你填写的地址，密钥只保存在本机。`
                : "使用 OpenAI / Anthropic 兼容接口读取文字简历、分析岗位描述。没有配置时不会发送任何请求。"}
            </div>
          </div>
          <button
            type="button"
            className="q-btn q-btn-outline"
            onClick={() => {
              void chrome.tabs.create({
                url: chrome.runtime.getURL("pages/workbench.html#settings"),
              });
            }}
          >
            <Sparkle size={15} />
            {customModelReady(settings.model) ? "查看配置" : "去配置"}
          </button>
        </div>
        <div className="q-setting">
          <div className="q-setting-body">
            <div className="q-setting-title">重新运行模型引导</div>
            <div className="q-setting-desc">
              重新选择识别方式，填写服务器地址与访问码，或改用自己的模型。
            </div>
          </div>
          <button
            type="button"
            className="q-btn q-btn-outline"
            onClick={() => {
              void chrome.tabs.create({
                url: chrome.runtime.getURL("pages/workbench.html#setup"),
              });
            }}
          >
            打开引导
          </button>
        </div>
      </Section>

      <Section title="外观" description="跟随系统，或固定为某一种。">
        <div className="q-setting">
          <div className="q-setting-body">
            <div className="q-setting-title">配色方案</div>
            <div className="q-setting-desc">面板与工作台都遵循同一个设计语言。</div>
          </div>
          <div style={{ display: "flex", gap: "var(--s-1)" }}>
            {(["system", "light", "dark"] as const).map((option) => (
              <button
                key={option}
                type="button"
                className={`q-btn q-btn-sm ${settings.appearance === option ? "q-btn-secondary" : "q-btn-ghost"}`}
                onClick={() => void update({ appearance: option })}
                disabled={busy}
                aria-pressed={settings.appearance === option}
              >
                {settings.appearance === option && <Check size={13} />}
                {option === "system" ? "跟随系统" : option === "light" ? "浅色" : "深色"}
              </button>
            ))}
          </div>
        </div>
      </Section>

      <Section title="你的数据" description="资料保存在这台设备的浏览器存储中；只有你选择的模型识别会把相应文字发出去。">
        <div className="q-setting">
          <div className="q-setting-body">
            <div className="q-setting-title">导出备份</div>
            <div className="q-setting-desc">
              导出简历资料、记忆、岗位分析与投递记录，格式为 JSON，方便你换设备时导入。
            </div>
          </div>
          <button type="button" className="q-btn q-btn-outline" onClick={() => void exportData()}>
            <Download size={15} />
            导出
          </button>
        </div>

        <div className="q-setting">
          <div className="q-setting-body">
            <div className="q-setting-title">删除全部数据</div>
            <div className="q-setting-desc">
              永久删除简历、记忆、分析与投递记录。此操作无法撤销。
            </div>
          </div>
          {confirmingErase ? (
            <div style={{ display: "flex", gap: "var(--s-2)" }}>
              <button type="button" className="q-btn q-btn-outline" onClick={() => setConfirmingErase(false)}>
                保留数据
              </button>
              <button
                type="button"
                className="q-btn q-btn-primary"
                style={{ background: "var(--red)" }}
                onClick={() => void erase()}
              >
                确认删除
              </button>
            </div>
          ) : (
            <button type="button" className="q-btn q-btn-danger" onClick={() => setConfirmingErase(true)}>
              <Trash size={15} />
              删除
            </button>
          )}
        </div>
      </Section>

      <div className="q-consent" style={{ marginTop: "var(--s-8)" }}>
        <Lock />
        <div>
          {settings.resumeModel.enabled && customModelReady(settings.model)
            ? "资料保存在本机。可复制文字的简历会发给你配置的自定义模型，图片和扫描件会发到识别服务器；岗位分析会发给自定义模型。两个密钥都只保存在本机，可以随时关闭。"
            : settings.resumeModel.enabled
              ? "资料保存在本机。模型识别开启时，新上传简历的文字会发到你的识别服务器做转写与结构化；服务器不保存文件或结果。可在上面的开关里关闭，关闭后不产生任何识别请求。"
              : customModelReady(settings.model)
                ? "资料保存在本机。只有在你上传简历或分析岗位时，相应文字才会发给你配置的自定义模型；API Key 不会发送到 Quill 的服务器。"
                : "Quill 不连接任何服务器。你的简历与填写内容不会离开这台设备，也不会被用于训练模型。唯一的例外是你主动点击“导出”。"}
        </div>
      </div>

      {toast && (
        <div className="q-toast-region">
          <div className="q-toast">{toast.text}</div>
        </div>
      )}
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
    <section style={{ marginBottom: "var(--s-10)" }}>
      <h2 style={{ fontSize: "var(--text-title)", letterSpacing: "var(--tracking-title)" }}>{title}</h2>
      <p className="q-sub" style={{ marginTop: "var(--s-2)" }}>
        {description}
      </p>
      <div className="q-group" style={{ marginTop: "var(--s-4)" }}>
        {children}
      </div>
    </section>
  );
}

function Toggle({
  title,
  description,
  checked,
  disabled,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  disabled: boolean;
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
        disabled={disabled}
        onClick={() => onChange(!checked)}
      />
    </div>
  );
}

const container = document.getElementById("root");
if (container) createRoot(container).render(<Options />);
