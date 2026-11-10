/**
 * Settings for the workbench.
 *
 * Deliberately a superset of the extension's options page: the appearance and
 * behaviour toggles are the same, plus data portability, because a person who
 * invested an hour in a ledger needs a way to take it with them.
 */

import { useCallback, useEffect, useState, type JSX } from "react";
import {
  DEFAULT_MODEL_CONFIG,
  DEFAULT_SETTINGS,
  normalizeSettings,
  type ModelConfig,
  type ModelProtocol,
  type Settings,
} from "@quill/core";
import { useWorkbench } from "../state.js";
import { getStore } from "../data/store.js";
import { downloadFile } from "../data/format.js";
import { checkModelServer } from "../data/model.js";
import { testUserModel } from "../data/userModel.js";
import { Check, Document, Download, Info, Lock, Settings as SettingsIcon, Trash, Upload, Warning } from "../icons.js";

type Toast = (text: string, tone?: "neutral" | "success" | "error") => void;

export function SettingsView({ onToast }: { onToast: Toast }): JSX.Element {
  const { state, reload, updateSettings } = useWorkbench();
  const [confirmErase, setConfirmErase] = useState(false);
  const [importError, setImportError] = useState<string | undefined>();
  const [diagnosticDescription, setDiagnosticDescription] = useState("");
  const [diagnosticBusy, setDiagnosticBusy] = useState(false);
  const [diagnosticNote, setDiagnosticNote] = useState<string | undefined>();
  const [confirmClearDiagnostics, setConfirmClearDiagnostics] = useState(false);
  const [modelUrl, setModelUrl] = useState(
    state.settings?.resumeModel?.baseUrl ?? DEFAULT_SETTINGS.resumeModel.baseUrl,
  );
  const [betaCode, setBetaCode] = useState<string>(
    state.settings?.resumeModel?.betaCode ?? "",
  );
  const [modelCheck, setModelCheck] = useState<{ tone: "ok" | "error"; text: string } | undefined>();
  const [checkingModel, setCheckingModel] = useState(false);
  const [customProtocol, setCustomProtocol] = useState<ModelProtocol>("openai");
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [customApiKey, setCustomApiKey] = useState("");
  const [customModelName, setCustomModelName] = useState("");
  const [customTemperature, setCustomTemperature] = useState("0.2");
  const [customCheck, setCustomCheck] = useState<{ tone: "ok" | "error"; text: string } | undefined>();
  const [checkingCustom, setCheckingCustom] = useState(false);

  const settings = state.settings ?? DEFAULT_SETTINGS;
  const resumeModel = settings.resumeModel ?? DEFAULT_SETTINGS.resumeModel;
  const modelConfig = settings.model ?? DEFAULT_MODEL_CONFIG;
  const diagnosticsAvailable = typeof chrome !== "undefined" && typeof chrome.runtime?.id === "string";

  useEffect(() => {
    setModelUrl(resumeModel.baseUrl);
  }, [resumeModel.baseUrl]);

  useEffect(() => {
    setBetaCode(resumeModel.betaCode ?? "");
  }, [resumeModel.betaCode]);

  useEffect(() => {
    setCustomProtocol(modelConfig.protocol ?? "openai");
    setCustomBaseUrl(modelConfig.baseUrl);
    setCustomApiKey(modelConfig.apiKey);
    setCustomModelName(modelConfig.model);
    setCustomTemperature(String(modelConfig.temperature ?? 0.2));
  }, [
    modelConfig.protocol,
    modelConfig.baseUrl,
    modelConfig.apiKey,
    modelConfig.model,
    modelConfig.temperature,
  ]);

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
        // A backup is a file people email to themselves. Never put an API key
        // in it; the key stays in this browser and is re-entered on a new device.
        settings: {
          ...state.settings,
          ...(state.settings.model
            ? { model: { ...state.settings.model, apiKey: "" } }
            : {}),
          ...(state.settings.resumeModel
            ? { resumeModel: { ...state.settings.resumeModel, betaCode: "" } }
            : {}),
        },
      },
      null,
      2,
    );
    downloadFile(`quill-备份-${new Date().toISOString().slice(0, 10)}.json`, payload, "application/json");
    onToast("已导出备份文件（不包含 API Key 与访问码）", "success");
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
        if (parsed.settings) {
          const imported = parsed.settings as Partial<Settings>;
          const currentKey = state.settings.model?.apiKey ?? "";
          const importedModel = imported.model;
          const currentBeta = resumeModel.betaCode ?? "";
          const importedResume = imported.resumeModel;
          const merged = normalizeSettings({
            ...state.settings,
            ...imported,
            resumeModel: {
              ...DEFAULT_SETTINGS.resumeModel,
              ...resumeModel,
              ...(importedResume ?? {}),
              // Backups omit both credentials; keep the ones already here.
              betaCode: importedResume?.betaCode?.trim() || currentBeta,
            },
            model: {
              ...DEFAULT_MODEL_CONFIG,
              ...modelConfig,
              ...(importedModel ?? {}),
              apiKey: importedModel?.apiKey?.trim() || currentKey,
            },
          });
          await store.saveSettings(merged);
        }
        await reload();
        setImportError(undefined);
        onToast("已导入备份", "success");
      } catch {
        setImportError("这个文件不是 Quill 导出的备份，或内容已损坏。");
      }
    },
    [modelConfig, onToast, reload, resumeModel, state.settings],
  );

  /*
   * Diagnostics are produced by the extension's service worker, not by this
   * page. In the standalone build there is no background to ask, so the whole
   * section explains that instead of offering buttons that would fail.
   */
  const exportDiagnostics = useCallback(async () => {
    if (!diagnosticsAvailable) return;
    setDiagnosticBusy(true);
    setDiagnosticNote(undefined);
    try {
      const description = diagnosticDescription.trim();
      const response = (await chrome.runtime.sendMessage({
        type: "diagnostics-export",
        ...(description ? { description } : {}),
      })) as { ok: boolean; bundle?: unknown; error?: string };

      if (!response?.ok || !response.bundle) {
        setDiagnosticNote(response?.error ?? "扩展后台没有响应，请确认扩展已启用后重试。");
        return;
      }

      const now = new Date();
      const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(
        now.getDate(),
      ).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
      downloadFile(`quill-诊断-${stamp}.json`, JSON.stringify(response.bundle, null, 2), "application/json");
      setDiagnosticNote("已导出。把这个文件发给开发者即可，不会自动上传到任何地方。");
      onToast("已导出诊断文件", "success");
    } catch {
      setDiagnosticNote("无法连接扩展后台，请确认扩展已加载。");
    } finally {
      setDiagnosticBusy(false);
    }
  }, [diagnosticsAvailable, diagnosticDescription, onToast]);

  const clearDiagnostics = useCallback(async () => {
    if (!diagnosticsAvailable) return;
    setDiagnosticBusy(true);
    try {
      const response = (await chrome.runtime.sendMessage({ type: "diagnostics-clear" })) as {
        ok: boolean;
        error?: string;
      };
      setDiagnosticNote(response?.ok ? "已清空本机的诊断记录。" : response?.error ?? "清空失败，请稍后重试。");
      if (response?.ok) onToast("已清空诊断记录", "success");
    } catch {
      setDiagnosticNote("无法连接扩展后台，请确认扩展已加载。");
    } finally {
      setDiagnosticBusy(false);
      setConfirmClearDiagnostics(false);
    }
  }, [diagnosticsAvailable, onToast]);

  const saveModelUrl = useCallback(async () => {
    const trimmed = modelUrl.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(trimmed)) {
      setModelCheck({ tone: "error", text: "地址需要以 http:// 或 https:// 开头。" });
      return;
    }
    if (trimmed === resumeModel.baseUrl) return;
    await updateSettings({
      resumeModel: { ...resumeModel, baseUrl: trimmed, consentShown: false },
    });
    setModelCheck({ tone: "ok", text: "地址已保存；下次上传简历时会重新确认发送范围。" });
  }, [modelUrl, resumeModel, updateSettings]);

  const saveBetaCode = useCallback(async () => {
    const trimmed = betaCode.trim();
    if (trimmed === resumeModel.betaCode) return;
    await updateSettings({ resumeModel: { ...resumeModel, betaCode: trimmed } });
    setModelCheck({
      tone: "ok",
      text: trimmed ? "访问码已保存。" : "已清除访问码。",
    });
  }, [betaCode, resumeModel, updateSettings]);

  const testModelServer = useCallback(async () => {
    setCheckingModel(true);
    setModelCheck(undefined);
    const result = await checkModelServer(modelUrl, betaCode);
    if (result.ok) {
      if (result.betaRequired && !result.betaOk) {
        setModelCheck({ tone: "error", text: "服务器要求访问码，请填写正确的访问码后再试。" });
      } else {
        setModelCheck(
          result.modelConfigured
            ? { tone: "ok", text: "服务器已就绪，可以使用模型识别。" }
            : { tone: "error", text: "服务器在运行，但还没有配置模型密钥。" },
        );
      }
    } else {
      setModelCheck({ tone: "error", text: result.message });
    }
    setCheckingModel(false);
  }, [modelUrl, betaCode]);

  const customConfig = useCallback(
    (enabled = modelConfig.enabled, protocolOverride = customProtocol): ModelConfig => {
      const temperature = Number.parseFloat(customTemperature);
      return {
        ...modelConfig,
        protocol: protocolOverride,
        baseUrl: customBaseUrl.trim().replace(/\/+$/, ""),
        apiKey: customApiKey.trim(),
        model: customModelName.trim(),
        temperature: Number.isFinite(temperature)
          ? Math.min(2, Math.max(0, temperature))
          : 0.2,
        enabled: Boolean(enabled),
      };
    },
    [
      customApiKey,
      customBaseUrl,
      customModelName,
      customProtocol,
      customTemperature,
      modelConfig,
    ],
  );

  const saveCustomModel = useCallback(
    async (enabled = modelConfig.enabled, protocolOverride = customProtocol) => {
      const next = customConfig(enabled, protocolOverride);
      if (
        next.protocol === (modelConfig.protocol ?? "openai") &&
        next.baseUrl === modelConfig.baseUrl &&
        next.apiKey === modelConfig.apiKey &&
        next.model === modelConfig.model &&
        next.temperature === modelConfig.temperature &&
        next.enabled === modelConfig.enabled
      ) {
        return;
      }
      const destinationChanged =
        next.protocol !== (modelConfig.protocol ?? "openai") ||
        next.baseUrl !== modelConfig.baseUrl;
      await updateSettings({
        model: next,
        ...(destinationChanged
          ? { resumeModel: { ...resumeModel, consentShown: false } }
          : {}),
      });
      setCustomCheck(
        enabled
          ? next.baseUrl && next.apiKey && next.model
            ? { tone: "ok", text: "自定义模型已保存。" }
            : { tone: "error", text: "已打开自定义模型，但 Base URL、API Key 或模型名称还没填完。" }
          : { tone: "ok", text: "已关闭自定义模型。" },
      );
    },
    [customConfig, customProtocol, modelConfig, resumeModel, updateSettings],
  );

  const testCustomModel = useCallback(async () => {
    const config = customConfig(true);
    if (!config.baseUrl || !config.apiKey || !config.model) {
      setCustomCheck({ tone: "error", text: "请先完整填写 Base URL、API Key 和模型名称。" });
      return;
    }
    setCheckingCustom(true);
    setCustomCheck(undefined);
    const result = await testUserModel(config);
    setCustomCheck(
      result.ok
        ? { tone: "ok", text: "连接成功，自定义模型可以响应。" }
        : { tone: "error", text: result.message },
    );
    setCheckingCustom(false);
  }, [customConfig]);

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

      <Section
        title="简历识别"
        description="默认用本机规则；开启模型识别后，扫描件和图片也能读取。"
      >
        <Toggle
          title="使用模型识别简历"
          description="扫描件和图片也能读取，字段归属比本机规则更准。开启后，新上传简历的文字会发送到识别服务器。"
          checked={resumeModel.enabled}
          onChange={(checked) =>
            void updateSettings({ resumeModel: { ...resumeModel, enabled: checked } })
          }
        />

        {resumeModel.enabled && (
          <div style={{ padding: "var(--s-4)", display: "flex", flexDirection: "column", gap: "var(--s-2)" }}>
            <label
              className="q-setting-title"
              htmlFor="resume-model-url"
              style={{ display: "block" }}
            >
              识别服务器地址
            </label>
            <div className="q-setting-desc">
              填服务方提供的识别服务地址，以 https:// 开头。平台密钥只保存在服务器上，
              浏览器不会接触。
            </div>
            <div style={{ display: "flex", gap: "var(--s-2)", flexWrap: "wrap", marginTop: "var(--s-2)" }}>
              <input
                id="resume-model-url"
                className="q-input"
                value={modelUrl}
                onChange={(event) => setModelUrl(event.target.value)}
                onBlur={() => void saveModelUrl()}
                placeholder="https://api.example.com"
                spellCheck={false}
                autoComplete="off"
                style={{ flex: "1 1 16rem", minWidth: 0 }}
              />
              <button
                type="button"
                className="q-btn q-btn-outline"
                onClick={() => void testModelServer()}
                disabled={checkingModel}
              >
                {checkingModel ? "正在连接…" : "测试连接"}
              </button>
            </div>

            <label
              className="q-setting-title"
              htmlFor="resume-model-beta"
              style={{ display: "block", marginTop: "var(--s-3)" }}
            >
              访问码（如有）
            </label>
            <div className="q-setting-desc">
              识别服务可能要求访问码才能使用。它只用于限制访问，不是模型平台的 API key。
            </div>
            <input
              id="resume-model-beta"
              className="q-input"
              type="text"
              value={betaCode}
              onChange={(event) => setBetaCode(event.target.value)}
              onBlur={() => void saveBetaCode()}
              placeholder="向服务方获取，可留空"
              spellCheck={false}
              autoComplete="off"
            />

            {modelCheck && (
              <div className="q-insight" data-kind={modelCheck.tone === "ok" ? "success" : "warning"}>
                <Info size={16} />
                <div className="q-insight-detail" style={{ marginTop: 0 }}>
                  {modelCheck.text}
                </div>
              </div>
            )}
            <div className="q-insight" style={{ background: "var(--bg-sunken)" }}>
              <Lock size={16} />
              <div className="q-insight-detail" style={{ marginTop: 0 }}>
                开启后，识别偏离了“完全本地”的默认：简历文字会离开这台设备，发送到上面的服务器。
                服务器只做转写与结构化，不保存文件或结果，也不写入日志；你可以随时关闭这个开关。
              </div>
            </div>
          </div>
        )}
      </Section>

      <Section
        title="自定义模型（可选）"
        description="用自己的 OpenAI / Anthropic 兼容接口做文字简历解析与岗位分析。"
      >
        <Toggle
          title="使用我自己的模型 API"
          description="请求直接从浏览器发往你填写的地址。API Key 只保存在本机，不会发送到 Quill 的识别服务器。"
          checked={Boolean(modelConfig.enabled)}
          onChange={(checked) => void saveCustomModel(checked)}
        />

        {modelConfig.enabled && (
          <div style={{ padding: "var(--s-4)", display: "flex", flexDirection: "column", gap: "var(--s-4)" }}>
            <div>
              <span className="q-setting-title">接口协议</span>
              <p className="q-setting-desc" style={{ marginTop: "var(--s-1)" }}>
                OpenAI 兼容接口请求 /chat/completions；Anthropic 兼容接口请求 /v1/messages。
              </p>
              <div className="q-segmented" style={{ marginTop: "var(--s-2)" }}>
                {(
                  [
                    ["openai", "OpenAI 兼容"],
                    ["anthropic", "Anthropic 兼容"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={customProtocol === id}
                    onClick={() => {
                      setCustomProtocol(id);
                      void saveCustomModel(modelConfig.enabled, id);
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="q-setting-title" htmlFor="custom-model-url" style={{ display: "block" }}>
                Base URL
              </label>
              <input
                id="custom-model-url"
                className="q-input"
                value={customBaseUrl}
                onChange={(event) => setCustomBaseUrl(event.target.value)}
                onBlur={() => void saveCustomModel()}
                placeholder={
                  customProtocol === "anthropic"
                    ? "https://.../anthropic 或完整的 /v1/messages 地址"
                    : "https://api.deepseek.com/v1"
                }
                spellCheck={false}
                autoComplete="off"
                style={{ marginTop: "var(--s-2)" }}
              />
            </div>

            <div className="q-grid q-grid-2">
              <div>
                <label className="q-setting-title" htmlFor="custom-model-key" style={{ display: "block" }}>
                  API Key
                </label>
                <input
                  id="custom-model-key"
                  className="q-input"
                  type="password"
                  value={customApiKey}
                  onChange={(event) => setCustomApiKey(event.target.value)}
                  onBlur={() => void saveCustomModel()}
                  placeholder="sk-..."
                  spellCheck={false}
                  autoComplete="off"
                  style={{ marginTop: "var(--s-2)" }}
                />
              </div>
              <div>
                <label className="q-setting-title" htmlFor="custom-model-name" style={{ display: "block" }}>
                  模型名称
                </label>
                <input
                  id="custom-model-name"
                  className="q-input"
                  value={customModelName}
                  onChange={(event) => setCustomModelName(event.target.value)}
                  onBlur={() => void saveCustomModel()}
                  placeholder="deepseek-chat"
                  spellCheck={false}
                  autoComplete="off"
                  style={{ marginTop: "var(--s-2)" }}
                />
              </div>
            </div>

            <div style={{ display: "flex", gap: "var(--s-2)", alignItems: "flex-end", flexWrap: "wrap" }}>
              <div style={{ width: "9rem" }}>
                <label className="q-setting-title" htmlFor="custom-model-temperature" style={{ display: "block" }}>
                  温度
                </label>
                <input
                  id="custom-model-temperature"
                  className="q-input"
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={customTemperature}
                  onChange={(event) => setCustomTemperature(event.target.value)}
                  onBlur={() => void saveCustomModel()}
                  style={{ marginTop: "var(--s-2)" }}
                />
              </div>
              <button
                type="button"
                className="q-btn q-btn-outline"
                onClick={() => void testCustomModel()}
                disabled={checkingCustom}
              >
                {checkingCustom ? "正在测试…" : "测试模型"}
              </button>
            </div>

            {customCheck && (
              <div className="q-insight" data-kind={customCheck.tone === "ok" ? "success" : "warning"}>
                <Info size={16} />
                <div className="q-insight-detail" style={{ marginTop: 0 }}>
                  {customCheck.text}
                </div>
              </div>
            )}

            <div className="q-insight" style={{ background: "var(--bg-sunken)" }}>
              <Lock size={16} />
              <div className="q-insight-detail" style={{ marginTop: 0 }}>
                自定义模型只处理可复制文字的 PDF、DOCX、TXT，以及岗位描述；扫描件和图片仍需要识别服务。
                浏览器直连要求对方允许 CORS；在扩展里打开工作台不受这个限制。API Key 不会写入导出备份。
              </div>
            </div>
          </div>
        )}

        <div style={{ padding: "var(--s-4)", borderTop: "var(--hairline-w) solid var(--line)" }}>
          <button
            type="button"
            className="q-btn q-btn-ghost"
            onClick={() => {
              void updateSettings({ setupCompleted: false }).then(() => {
                window.location.hash = "#/setup";
              });
            }}
          >
            重新运行模型引导
          </button>
        </div>
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

      <Section title="数据" description="资料保存在这台设备的浏览器里；模型识别是唯一的例外。">
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

      <Section title="诊断与日志" description="遇到问题时，先记录现场，再把诊断文件发给开发者。">
        <div style={{ padding: "var(--s-4)", display: "flex", flexDirection: "column", gap: "var(--s-4)" }}>
          {!diagnosticsAvailable && (
            <div className="q-insight" data-kind="warning">
              <Warning size={16} />
              <div>
                <div className="q-insight-title">当前页面读不到扩展日志</div>
                <div className="q-insight-detail">
                  请从浏览器扩展里打开 Quill 工作台，或在网页的填写面板上点击「报告问题」。
                </div>
              </div>
            </div>
          )}

          <div>
            <label
              className="q-setting-title"
              htmlFor="diagnostic-description"
              style={{ display: "block", marginBottom: "var(--s-2)" }}
            >
              问题描述
            </label>
            <div className="q-setting-desc" style={{ marginBottom: "var(--s-3)" }}>
              说说在哪个页面、做了什么、哪里不对。可选，但能显著缩短排查时间。
            </div>
            <textarea
              id="diagnostic-description"
              className="q-textarea"
              rows={3}
              maxLength={1000}
              value={diagnosticDescription}
              onChange={(event) => setDiagnosticDescription(event.target.value)}
              placeholder="例如：在快手投递页点「填写」后，教育经历没有自动添加。"
              disabled={!diagnosticsAvailable || diagnosticBusy}
              style={{ width: "100%", resize: "vertical" }}
            />
          </div>

          <div style={{ display: "flex", gap: "var(--s-2)", flexWrap: "wrap", alignItems: "center" }}>
            <button
              type="button"
              className="q-btn q-btn-primary"
              onClick={() => void exportDiagnostics()}
              disabled={!diagnosticsAvailable || diagnosticBusy}
            >
              <Document size={15} />
              {diagnosticBusy ? "正在整理…" : "导出诊断文件"}
            </button>

            {confirmClearDiagnostics ? (
              <>
                <button
                  type="button"
                  className="q-btn q-btn-outline"
                  onClick={() => setConfirmClearDiagnostics(false)}
                  disabled={diagnosticBusy}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="q-btn q-btn-primary"
                  style={{ background: "var(--red)" }}
                  onClick={() => void clearDiagnostics()}
                  disabled={diagnosticBusy}
                >
                  <Trash size={15} />
                  确认清空
                </button>
              </>
            ) : (
              <button
                type="button"
                className="q-btn q-btn-ghost"
                onClick={() => setConfirmClearDiagnostics(true)}
                disabled={!diagnosticsAvailable || diagnosticBusy}
              >
                <Trash size={15} />
                清空记录
              </button>
            )}
          </div>

          {diagnosticNote && (
            <div className="q-insight" data-kind={diagnosticNote.startsWith("已") ? "success" : "warning"}>
              <Info size={16} />
              <div className="q-insight-detail" style={{ marginTop: 0 }}>
                {diagnosticNote}
              </div>
            </div>
          )}

          <div className="q-insight" style={{ background: "var(--bg-sunken)" }}>
            <Lock size={16} />
            <div className="q-insight-detail" style={{ marginTop: 0 }}>
              诊断文件只包含页面结构、字段标签、识别结果和操作记录。你填写的值、简历正文、密码、Cookie
              都不会被写入；文件也不会自动上传，只有你亲手导出并发送时才会离开这台设备。
            </div>
          </div>
        </div>
      </Section>

      <div className="q-consent" style={{ marginTop: "var(--s-8)" }}>
        <Lock />
        <div>
          {resumeModel.enabled && modelConfig.enabled
            ? "简历文字可能发送到你的识别服务器做 OCR，或发送到你配置的自定义模型做结构化；岗位描述可能发送给自定义模型。Quill 不保存这些内容，资料与填写结果仍留在本机。"
            : resumeModel.enabled
              ? "除了新上传的简历会发送到你的识别服务器做转写与结构化，Quill 不连接其他服务器。资料、填写内容与导出文件仍保存在这台设备，服务器不保存简历或识别结果。"
              : modelConfig.enabled
                ? "简历文字与岗位描述会发送到你配置的自定义模型；除此之外 Quill 不连接其他服务器。API Key 只保存在本机。"
                : "Quill 不连接任何服务器。你的简历与填写内容不会离开这台设备，也不会被用于训练模型。唯一的例外是你在这里点击“导出”。"}
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
