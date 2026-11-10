/**
 * First-run page.
 *
 * Its job is to explain the privacy model before anything is captured, and to
 * let the person choose where resume recognition happens: a recognition
 * service they were given the address for, their own OpenAI-/Anthropic-
 * compatible endpoint, or nowhere. The local path is the default so a fresh
 * install works without any server. The choice is saved before the workbench
 * opens, so a fresh install never lands on an empty screen wondering why
 * recognition fails.
 */

import { useEffect, useState, type JSX } from "react";
import { createRoot } from "react-dom/client";
import {
  DEFAULT_MODEL_CONFIG,
  DEFAULT_SETTINGS,
  customModelReady,
  normalizeSettings,
  type Settings,
} from "@quill/core";
import { ArrowRight, Lock, QuillMark, Sparkle, Upload, Warning } from "./icons.js";

type Mode = "quill" | "custom" | "local";

const MODES: Array<{ id: Mode; label: string; detail: string }> = [
  {
    id: "quill",
    label: "Quill 识别服务",
    detail: "填写服务方提供的服务器地址和访问码。扫描件、图片也能读，平台密钥不经过浏览器。",
  },
  {
    id: "custom",
    label: "我自己的模型",
    detail: "用你的 OpenAI / Anthropic 兼容接口读取文字简历和分析岗位。密钥只保存在本机。",
  },
  {
    id: "local",
    label: "只用本机规则",
    detail: "完全不联网。可复制文字的 PDF、DOCX、TXT 可用；扫描件和图片读不出。",
  },
];

const STEPS: Array<{ title: string; body: string }> = [
  {
    title: "上传一份简历",
    body: "Quill 会读取其中的姓名、联系方式、教育与经历，形成你自己的资料库。识别方式就是你上面选的那一种，之后随时可以改。",
  },
  {
    title: "打开任意网申页面",
    body: "右下角会出现一个面板，告诉你这一页有哪些字段、哪些能自动填、哪些缺资料。填写前一定由你确认。",
  },
  {
    title: "你填的内容会被记住",
    body: "当某个字段没有对应资料、你自己动手填写时，Quill 会记住这一次的答案，下次遇到同样的字段直接给出建议。",
  },
];

function Welcome(): JSX.Element {
  const [mode, setMode] = useState<Mode>("local");
  const [serverUrl, setServerUrl] = useState(DEFAULT_SETTINGS.resumeModel.baseUrl);
  const [betaCode, setBetaCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    void (async () => {
      try {
        const stored = (await chrome.storage.local.get("quill.settings"))["quill.settings"] as
          | Partial<Settings>
          | undefined;
        const settings = normalizeSettings(stored);
        setServerUrl(settings.resumeModel.baseUrl || DEFAULT_SETTINGS.resumeModel.baseUrl);
        setBetaCode(settings.resumeModel.betaCode ?? "");
        if (customModelReady(settings.model)) setMode("custom");
        else if (settings.setupMode) setMode(settings.setupMode);
      } catch {
        // A fresh install has no stored settings; the defaults are already set.
      }
    })();
  }, []);

  const openWorkbench = (hash: "resume" | "setup"): void => {
    void chrome.tabs.create({ url: chrome.runtime.getURL(`pages/workbench.html#${hash}`) });
  };

  const openOptions = (): void => {
    void chrome.runtime.openOptionsPage();
  };

  const start = async (): Promise<void> => {
    setError(undefined);

    if (mode === "custom") {
      // The workbench owns the full model form (protocol, URL, key, model).
      // Opening #setup directly avoids duplicating it here.
      openWorkbench("setup");
      return;
    }

    if (mode === "quill") {
      const url = serverUrl.trim().replace(/\/+$/, "");
      if (!/^https?:\/\//i.test(url)) {
        setError("请填写识别服务器地址，并以 http:// 或 https:// 开头。");
        return;
      }
    }

    setBusy(true);
    try {
      const stored = (await chrome.storage.local.get("quill.settings"))["quill.settings"] as
        | Partial<Settings>
        | undefined;
      const base = normalizeSettings(stored);
      const next: Settings =
        mode === "quill"
          ? {
              ...base,
              resumeModel: {
                ...base.resumeModel,
                enabled: true,
                baseUrl: serverUrl.trim().replace(/\/+$/, ""),
                betaCode: betaCode.trim(),
                consentShown: false,
              },
              // Choosing one recognition path disables the other; both can be
              // re-enabled later in the workbench settings.
              model: { ...DEFAULT_MODEL_CONFIG, ...base.model, enabled: false },
              setupCompleted: true,
              setupMode: "quill",
            }
          : {
              ...base,
              resumeModel: { ...base.resumeModel, enabled: false },
              model: { ...DEFAULT_MODEL_CONFIG, ...base.model, enabled: false },
              setupCompleted: true,
              setupMode: "local",
            };
      await chrome.storage.local.set({ "quill.settings": next });
      openWorkbench("resume");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败，请重试。");
    } finally {
      setBusy(false);
    }
  };

  const primaryLabel =
    mode === "quill"
      ? "保存并打开工作台"
      : mode === "custom"
        ? "去配置我的模型"
        : "仅本机使用";

  return (
    <main className="q-welcome">
      <div className="q-welcome-inner">
        <div className="q-welcome-mark q-reveal" style={{ "--i": 0 } as React.CSSProperties}>
          <QuillMark />
        </div>

        <h1 className="q-welcome-title q-reveal" style={{ "--i": 1 } as React.CSSProperties}>
          让网申填写变得体面一点。
        </h1>

        <p className="q-welcome-lead q-reveal" style={{ "--i": 2 } as React.CSSProperties}>
          Quill 读取你正在填写的表单，对照你的简历给出填写方案；遇到资料里没有的字段，它会安静地记住你自己填的答案。
          在开始之前，先决定识别简历时把文字交给谁。
        </p>

        <section
          className="q-welcome-setup q-reveal"
          style={{ "--i": 3 } as React.CSSProperties}
          aria-labelledby="welcome-setup-title"
        >
          <div className="q-eyebrow" id="welcome-setup-title">
            第一步 · 选择识别方式
          </div>

          <div className="q-welcome-modes" role="radiogroup" aria-labelledby="welcome-setup-title">
            {MODES.map((item) => (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={mode === item.id}
                className="q-welcome-mode"
                data-active={mode === item.id}
                onClick={() => {
                  setMode(item.id);
                  setError(undefined);
                }}
              >
                <span className="q-welcome-mode-label">{item.label}</span>
                <span className="q-welcome-mode-detail">{item.detail}</span>
              </button>
            ))}
          </div>

          {mode === "quill" && (
            <div className="q-welcome-fields">
              <label className="q-field-group">
                <span className="q-label">识别服务器地址</span>
                <input
                  className="q-input"
                  value={serverUrl}
                  onChange={(event) => setServerUrl(event.target.value)}
                  placeholder="https://your-quill-server.example.com"
                  spellCheck={false}
                  autoComplete="off"
                />
              </label>
              <label className="q-field-group">
                <span className="q-label">访问码（如有）</span>
                <input
                  className="q-input"
                  value={betaCode}
                  onChange={(event) => setBetaCode(event.target.value)}
                  placeholder="向服务方获取，可留空"
                  spellCheck={false}
                  autoComplete="off"
                />
              </label>
              <p className="q-hint">
                访问码只用于限制服务访问，不是模型平台的 API Key。没有访问码可以先用本机规则，或在设置里配置自己的模型。
              </p>
            </div>
          )}

          {mode === "custom" && (
            <p className="q-welcome-note">
              下一步会打开工作台的模型设置，填写 Base URL、API Key 和模型名称。请求直接从浏览器发往你填写的地址，
              Quill 的服务器看不到密钥。
            </p>
          )}

          {mode === "local" && (
            <p className="q-welcome-note">
              不会产生任何网络请求。字段只由本机规则解析，准确度低于模型，扫描件和图片无法读取。
            </p>
          )}

          {error && (
            <div className="q-welcome-error" role="alert">
              <Warning size={15} />
              <span>{error}</span>
            </div>
          )}

          <div className="q-welcome-actions">
            <button type="button" className="q-btn q-btn-primary q-btn-lg" onClick={() => void start()} disabled={busy}>
              {mode === "custom" ? <Sparkle size={16} /> : <Upload size={16} />}
              {busy ? "正在保存…" : primaryLabel}
              {!busy && <ArrowRight size={15} />}
            </button>
            <button type="button" className="q-btn q-btn-ghost q-btn-lg" onClick={openOptions}>
              高级设置
            </button>
          </div>
        </section>

        <div className="q-steps">
          {STEPS.map((step, index) => (
            <div className="q-step q-reveal" key={step.title} style={{ "--i": index + 4 } as React.CSSProperties}>
              <div className="q-step-num">{String(index + 1).padStart(2, "0")}</div>
              <div>
                <div className="q-step-title">{step.title}</div>
                <p className="q-step-body">{step.body}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="q-consent q-reveal" style={{ "--i": 7, marginTop: "var(--s-10)" } as React.CSSProperties}>
          <Lock />
          <div>
            <strong>关于你的隐私。</strong>
            资料、填写内容与浏览记录只保存在这台设备的浏览器扩展存储里，你随时可以导出或彻底删除。
            只有你选择的识别方式会收到相应文字：简历识别会发送新上传简历的文字，岗位分析会发送你粘贴的岗位描述。
            可以随时在设置里改成本机模式。只有在你点击“填写”时，内容才会写入当前页面。
          </div>
        </div>
      </div>
    </main>
  );
}

const container = document.getElementById("root");
if (container) createRoot(container).render(<Welcome />);
