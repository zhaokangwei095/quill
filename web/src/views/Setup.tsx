/**
 * First-run setup.
 *
 * The product works locally, but the model-backed experience needs one of two
 * credentials: Quill's recognition service (which holds the platform key), or
 * the person's own OpenAI-/Anthropic-compatible endpoint. This screen makes
 * that choice explicit before the first resume is uploaded, and keeps the
 * "no server at all" path available instead of making it a hidden fallback.
 */

import { useCallback, useMemo, useState, type JSX } from "react";
import {
  DEFAULT_MODEL_CONFIG,
  DEFAULT_SETTINGS,
  customModelReady,
  type ModelConfig,
  type ModelProtocol,
  type Settings,
} from "@quill/core";
import { useWorkbench } from "../state.js";
import { checkModelServer } from "../data/model.js";
import { testUserModel } from "../data/userModel.js";
import { ArrowRight, Check, Info, Lock, Sparkle, Upload, Warning } from "../icons.js";

type Toast = (text: string, tone?: "neutral" | "success" | "error") => void;
type Mode = "quill" | "custom" | "local";

const MODES: Array<{
  id: Mode;
  title: string;
  subtitle: string;
  detail: string;
  icon: JSX.Element;
}> = [
  {
    id: "quill",
    title: "Quill 识别服务",
    subtitle: "需服务地址",
    detail: "由服务方完成 OCR 与结构化。扫描件、图片也能读，平台密钥不经过浏览器。",
    icon: <Sparkle size={17} />,
  },
  {
    id: "custom",
    title: "我自己的模型",
    subtitle: "自带 Key",
    detail: "用你的 OpenAI / Anthropic 兼容接口做文字简历与岗位分析。密钥只保存在本机。",
    icon: <Upload size={17} />,
  },
  {
    id: "local",
    title: "只用本机规则",
    subtitle: "完全离线",
    detail: "不连接任何服务。可复制文字的 PDF、DOCX、TXT 可用；扫描件和图片读不出。",
    icon: <Lock size={17} />,
  },
];

export function SetupView({
  onDone,
  onToast,
}: {
  onDone: (route: string) => void;
  onToast: Toast;
}): JSX.Element {
  const { state, updateSettings } = useWorkbench();
  const settings = state.settings ?? DEFAULT_SETTINGS;
  const resumeModel = settings.resumeModel ?? DEFAULT_SETTINGS.resumeModel;
  const initialModel = settings.model ?? DEFAULT_MODEL_CONFIG;

  const [mode, setMode] = useState<Mode>(
    settings.setupMode ??
      (customModelReady(initialModel) ? "custom" : resumeModel.enabled ? "quill" : "local"),
  );
  const [serverUrl, setServerUrl] = useState(resumeModel.baseUrl);
  const [betaCode, setBetaCode] = useState(resumeModel.betaCode ?? "");
  const [protocol, setProtocol] = useState<ModelProtocol>(initialModel.protocol ?? "openai");
  const [baseUrl, setBaseUrl] = useState(initialModel.baseUrl);
  const [apiKey, setApiKey] = useState(initialModel.apiKey);
  const [model, setModel] = useState(initialModel.model);
  const [busy, setBusy] = useState<"test" | "save" | undefined>();
  const [notice, setNotice] = useState<{ tone: "ok" | "error" | "info"; text: string } | undefined>();

  const customConfig = useMemo<ModelConfig>(
    () => ({
      ...DEFAULT_MODEL_CONFIG,
      ...initialModel,
      protocol,
      baseUrl: baseUrl.trim(),
      apiKey: apiKey.trim(),
      model: model.trim(),
      temperature: initialModel.temperature ?? 0.2,
      enabled: true,
    }),
    [apiKey, baseUrl, initialModel, model, protocol],
  );

  const testConnection = useCallback(async () => {
    setBusy("test");
    setNotice(undefined);
    try {
      if (mode === "quill") {
        if (!/^https?:\/\//i.test(serverUrl.trim())) {
          setNotice({ tone: "error", text: "服务器地址需要以 http:// 或 https:// 开头。" });
          return;
        }
        const result = await checkModelServer(serverUrl, betaCode);
        if (!result.ok) {
          setNotice({ tone: "error", text: result.message });
        } else if (result.betaRequired && !result.betaOk) {
          setNotice({ tone: "error", text: "服务器要求访问码，请核对后重试。" });
        } else if (!result.modelConfigured) {
          setNotice({ tone: "error", text: "服务器在运行，但还没有配置模型密钥。" });
        } else {
          setNotice({ tone: "ok", text: "连接成功，可以使用 Quill 的识别服务。" });
        }
      } else if (mode === "custom") {
        if (!customConfig.baseUrl || !customConfig.apiKey || !customConfig.model) {
          setNotice({ tone: "error", text: "请先填写 Base URL、API Key 和模型名称。" });
          return;
        }
        const result = await testUserModel(customConfig);
        setNotice(
          result.ok
            ? { tone: "ok", text: "连接成功，自定义模型可以响应。" }
            : { tone: "error", text: result.message },
        );
      } else {
        setNotice({ tone: "ok", text: "本机模式不需要连接测试。" });
      }
    } finally {
      setBusy(undefined);
    }
  }, [betaCode, customConfig, mode, serverUrl]);

  const save = useCallback(
    async (nextMode: Mode) => {
      setBusy("save");
      setNotice(undefined);
      try {
        if (nextMode === "quill" && !/^https?:\/\//i.test(serverUrl.trim())) {
          setNotice({ tone: "error", text: "服务器地址需要以 http:// 或 https:// 开头。" });
          return;
        }
        if (nextMode === "custom" && (!baseUrl.trim() || !apiKey.trim() || !model.trim())) {
          setNotice({ tone: "error", text: "请完整填写 Base URL、API Key 和模型名称。" });
          return;
        }

        const nextResumeModel =
          nextMode === "quill"
            ? {
                ...resumeModel,
                enabled: true,
                baseUrl: serverUrl.trim().replace(/\/+$/, ""),
                betaCode: betaCode.trim(),
                consentShown: false,
              }
            : { ...resumeModel, enabled: false };

        const nextModel: ModelConfig =
          nextMode === "custom"
            ? { ...customConfig, enabled: true }
            : { ...initialModel, enabled: false };

        await updateSettings({
          resumeModel: nextResumeModel,
          model: nextModel,
          setupCompleted: true,
          setupMode: nextMode,
        } satisfies Partial<Settings>);

        onToast(
          nextMode === "local"
            ? "已设为本机模式"
            : nextMode === "custom"
              ? "已保存自定义模型"
              : "已保存识别服务",
          "success",
        );
        onDone("resume");
      } catch (error) {
        setNotice({
          tone: "error",
          text: error instanceof Error ? error.message : "保存失败，请重试。",
        });
      } finally {
        setBusy(undefined);
      }
    },
    [
      apiKey,
      baseUrl,
      betaCode,
      customConfig,
      initialModel,
      model,
      onDone,
      onToast,
      resumeModel,
      serverUrl,
      updateSettings,
    ],
  );

  return (
    <div className="q-page q-setup">
      <header className="q-page-head q-reveal">
        <div className="q-eyebrow" style={{ marginBottom: "var(--s-3)" }}>
          <Sparkle size={13} style={{ verticalAlign: "-2px", marginRight: "var(--s-1)" }} />
          开始使用 · 约 1 分钟
        </div>
        <h1 className="q-page-title">先决定，简历交给谁读。</h1>
        <p className="q-page-lead">
          Quill 的其他数据始终只保存在本机。只有识别简历和分析岗位时，文字才会离开这台设备，
          而且由你选择去哪里。
        </p>
      </header>

      <section className="q-block q-reveal">
        <div className="q-setup-grid">
          {MODES.map((item) => (
            <button
              key={item.id}
              type="button"
              className="q-setup-choice"
              aria-pressed={mode === item.id}
              onClick={() => {
                setMode(item.id);
                setNotice(undefined);
              }}
            >
              <span className="q-setup-choice-icon">{item.icon}</span>
              <span className="q-setup-choice-head">
                <span className="q-setup-choice-title">{item.title}</span>
                <span className="q-chip q-chip-neutral">{item.subtitle}</span>
              </span>
              <span className="q-setup-choice-detail">{item.detail}</span>
              {mode === item.id && (
                <span className="q-setup-choice-check" aria-hidden="true">
                  <Check size={13} />
                </span>
              )}
            </button>
          ))}
        </div>
      </section>

      <section className="q-block q-reveal">
        <div className="q-card-lg">
          {mode === "quill" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-4)" }}>
              <div>
                <label className="q-setting-title" htmlFor="setup-server-url" style={{ display: "block" }}>
                  识别服务器地址
                </label>
                <p className="q-setting-desc" style={{ marginTop: "var(--s-1)" }}>
                  填服务方提供的识别服务地址，以 https:// 开头。
                </p>
                <input
                  id="setup-server-url"
                  className="q-input"
                  value={serverUrl}
                  onChange={(event) => setServerUrl(event.target.value)}
                  placeholder="https://your-quill-server.example.com"
                  spellCheck={false}
                  autoComplete="off"
                  style={{ marginTop: "var(--s-2)" }}
                />
              </div>
              <div>
                <label className="q-setting-title" htmlFor="setup-beta" style={{ display: "block" }}>
                  访问码（如有）
                </label>
                <p className="q-setting-desc" style={{ marginTop: "var(--s-1)" }}>
                  只用于限制服务访问，不是模型平台的 API Key。
                </p>
                <input
                  id="setup-beta"
                  className="q-input"
                  value={betaCode}
                  onChange={(event) => setBetaCode(event.target.value)}
                  placeholder="向服务方获取，可留空"
                  spellCheck={false}
                  autoComplete="off"
                  style={{ marginTop: "var(--s-2)" }}
                />
              </div>
            </div>
          )}

          {mode === "custom" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-4)" }}>
              <div>
                <span className="q-setting-title">接口协议</span>
                <p className="q-setting-desc" style={{ marginTop: "var(--s-1)" }}>
                  OpenAI 兼容接口使用 /chat/completions；Anthropic 兼容接口使用 /v1/messages。
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
                      aria-pressed={protocol === id}
                      onClick={() => setProtocol(id)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="q-setting-title" htmlFor="setup-model-url" style={{ display: "block" }}>
                  Base URL
                </label>
                <p className="q-setting-desc" style={{ marginTop: "var(--s-1)" }}>
                  {protocol === "anthropic"
                    ? "例如 https://maas-api.example.com/anthropic 或完整的 /v1/messages 地址。"
                    : "例如 https://api.deepseek.com/v1、https://api.openai.com/v1，或本地 Ollama 的 http://127.0.0.1:11434/v1。"}
                </p>
                <input
                  id="setup-model-url"
                  className="q-input"
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder={protocol === "anthropic" ? "https://.../anthropic" : "https://.../v1"}
                  spellCheck={false}
                  autoComplete="off"
                  style={{ marginTop: "var(--s-2)" }}
                />
              </div>
              <div className="q-grid q-grid-2">
                <div>
                  <label className="q-setting-title" htmlFor="setup-model-key" style={{ display: "block" }}>
                    API Key
                  </label>
                  <input
                    id="setup-model-key"
                    className="q-input"
                    type="password"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder="sk-..."
                    spellCheck={false}
                    autoComplete="off"
                    style={{ marginTop: "var(--s-2)" }}
                  />
                </div>
                <div>
                  <label className="q-setting-title" htmlFor="setup-model-name" style={{ display: "block" }}>
                    模型名称
                  </label>
                  <input
                    id="setup-model-name"
                    className="q-input"
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                    placeholder="例如 deepseek-chat"
                    spellCheck={false}
                    autoComplete="off"
                    style={{ marginTop: "var(--s-2)" }}
                  />
                </div>
              </div>
              <div className="q-insight" style={{ background: "var(--bg-sunken)" }}>
                <Info size={16} />
                <div className="q-insight-detail" style={{ marginTop: 0 }}>
                  自定义模型只能读取可复制文字的 PDF、DOCX 和 TXT；扫描件与图片仍需要 Quill
                  识别服务。之后可以在「设置」里同时配置两者。
                </div>
              </div>
            </div>
          )}

          {mode === "local" && (
            <div className="q-insight" style={{ background: "var(--bg-sunken)" }}>
              <Lock size={16} />
              <div className="q-insight-detail" style={{ marginTop: 0 }}>
                不会产生任何网络请求。字段来自本机规则，准确度低于模型；扫描件和图片无法读取。
                你随时可以在「设置」里再打开模型。
              </div>
            </div>
          )}

          {notice && (
            <div
              className="q-insight"
              data-kind={notice.tone === "ok" ? "success" : notice.tone === "error" ? "warning" : undefined}
              style={{ marginTop: "var(--s-4)" }}
            >
              {notice.tone === "ok" ? <Check size={16} /> : <Warning size={16} />}
              <div className="q-insight-detail" style={{ marginTop: 0 }}>
                {notice.text}
              </div>
            </div>
          )}

          <div className="q-toolbar" style={{ marginTop: "var(--s-5)", flexWrap: "wrap" }}>
            {mode !== "local" && (
              <button
                type="button"
                className="q-btn q-btn-outline"
                onClick={() => void testConnection()}
                disabled={busy !== undefined}
              >
                {busy === "test" ? "正在测试…" : "测试连接"}
              </button>
            )}
            <div className="q-grow" />
            <button
              type="button"
              className="q-btn q-btn-primary"
              onClick={() => void save(mode)}
              disabled={busy !== undefined}
            >
              {busy === "save" ? "正在保存…" : "保存并开始"}
              <ArrowRight size={15} />
            </button>
          </div>
        </div>
      </section>

      <section className="q-block">
        <div className="q-between" style={{ alignItems: "center", gap: "var(--s-4)", flexWrap: "wrap" }}>
          <div>
            <div className="q-setting-title">先看看，之后再配</div>
            <p className="q-setting-desc">
              跳过会把 Quill 设为本机模式。设置页里可以随时重新打开这个引导。
            </p>
          </div>
          <button
            type="button"
            className="q-btn q-btn-ghost"
            onClick={() => void save("local")}
            disabled={busy !== undefined}
          >
            跳过，先用本机规则
          </button>
        </div>
      </section>

      <div className="q-consent" style={{ marginTop: "var(--s-8)" }}>
        <Lock />
        <div>
          {mode === "custom"
            ? "API Key 只保存在这台设备的浏览器存储里，请求直接从浏览器发往你填写的地址；Quill 的服务器看不到它，导出备份时也不会写入。"
            : mode === "quill"
              ? "简历文字会发送到上面的识别服务器做转写与结构化；服务器不保存文件或结果。平台密钥只在服务器上，浏览器不会接触。"
              : "你选择了完全本机运行。Quill 不会把简历文字或填写内容发送到任何服务器。"}
        </div>
      </div>
    </div>
  );
}
