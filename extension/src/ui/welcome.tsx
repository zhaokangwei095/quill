/**
 * First-run page.
 *
 * Itsonly job is to explain the privacy model before anything is captured, and
 * to get the person to upload one resume. Everything the product can do depends
 * on that one file, so this page is short on purpose: three steps, one button.
 */

import type { JSX } from "react";
import { createRoot } from "react-dom/client";
import { ArrowRight, Lock, QuillMark, Sparkle, Upload } from "./icons.js";

const STEPS: Array<{ title: string; body: string }> = [
  {
    title: "上传一份简历",
    body: "Quill 会读取其中的姓名、联系方式、教育与经历，形成你自己的资料库。这一步在本地完成，不上传任何服务器。",
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
  const openWorkbench = (): void => {
    void chrome.tabs.create({ url: chrome.runtime.getURL("pages/workbench.html#resume") });
  };

  const openOptions = (): void => {
    void chrome.runtime.openOptionsPage();
  };

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
          所有内容都保存在这台设备的浏览器里。
        </p>

        <div className="q-steps">
          {STEPS.map((step, index) => (
            <div className="q-step q-reveal" key={step.title} style={{ "--i": index + 3 } as React.CSSProperties}>
              <div className="q-step-num">{String(index + 1).padStart(2, "0")}</div>
              <div>
                <div className="q-step-title">{step.title}</div>
                <p className="q-step-body">{step.body}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="q-consent q-reveal" style={{ "--i": 6, marginTop: "var(--s-10)" } as React.CSSProperties}>
          <Lock />
          <div>
            <strong>关于你的隐私。</strong>
            Quill 不会把简历、填写内容或浏览记录发送到任何服务器。所有数据都存放在 Chrome 的本地存储中，
            你可以随时在设置里导出或彻底删除。只有在你点击“填写”时，内容才会写入当前页面。
          </div>
        </div>

        <div style={{ display: "flex", gap: "var(--s-3)", marginTop: "var(--s-8)", flexWrap: "wrap" }}>
          <button type="button" className="q-btn q-btn-primary q-btn-lg" onClick={openWorkbench}>
            <Upload size={16} />
            上传简历，开始使用
            <ArrowRight size={15} />
          </button>
          <button type="button" className="q-btn q-btn-outline q-btn-lg" onClick={openOptions}>
            <Sparkle size={15} />
            先看看设置
          </button>
        </div>
      </div>
    </main>
  );
}

const container = document.getElementById("root");
if (container) createRoot(container).render(<Welcome />);
