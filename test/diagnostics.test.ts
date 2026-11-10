import assert from "node:assert/strict";
import test from "node:test";

import {
  appendDiagnosticEvent,
  buildDiagnosticBundle,
  compactDiagnosticEvents,
  createDiagnosticEvent,
  DIAGNOSTIC_BYTE_LIMIT,
  diagnosticId,
  redactData,
  redactEvent,
  redactText,
  sanitizePageUrl,
  type DiagnosticEvent,
} from "@quill/core";

/* -------------------------------------------------------------- redaction */

test("redactText masks identity patterns and tokens", () => {
  assert.equal(redactText("联系我 zhangsan@example.com"), "联系我 [email]");
  assert.equal(redactText("手机 13800138000"), "手机 [phone]");
  assert.equal(redactText("身份证 110101199001011234"), "身份证 [id]");
  assert.equal(redactText("Authorization: Bearer abc.def.ghi"), "Authorization: Bearer [token]");
  assert.equal(redactText("key abcdefghijklmnopqrstuvwxyz012345"), "key [token]");
});

test("redactText keeps short, meaningful text intact", () => {
  assert.equal(redactText("教育经历 学校名称 未识别"), "教育经历 学校名称 未识别");
});

test("redactText strips query strings from URLs", () => {
  const masked = redactText("see https://example.com/job/1?token=secret&email=a@b.com now");
  assert.equal(masked, "see https://example.com/job/1 now");
});

test("redactData removes values by key, recursively", () => {
  const masked = redactData({
    label: "手机号码",
    confidence: 0.92,
    value: "13800138000",
    nested: { password: "hunter2", proposedValues: ["a"], note: "ok" },
    list: [{ answer: "我的回答", key: "phone" }],
  }) as Record<string, unknown>;

  assert.equal(masked.label, "手机号码");
  assert.equal(masked.confidence, 0.92);
  assert.equal(masked.value, "[redacted]");
  assert.deepEqual(masked.nested, { password: "[redacted]", proposedValues: "[redacted]", note: "ok" });
  assert.deepEqual(masked.list, [{ answer: "[redacted]", key: "phone" }]);
});

test("redactData bounds runaway depth", () => {
  let deep: Record<string, unknown> = { leaf: 1 };
  for (let index = 0; index < 10; index += 1) deep = { next: deep };
  assert.match(JSON.stringify(redactData(deep)), /depth-limited/);
});

test("redactEvent scrubs its data bag", () => {
  const event = createDiagnosticEvent({
    scope: "content",
    event: "test",
    data: { value: "张三", note: "call 13800138000", label: "姓名" },
  });
  const redacted = redactEvent(event);
  assert.equal(redacted.data?.value, "[redacted]");
  assert.equal(redacted.data?.note, "call [phone]");
  assert.equal(redacted.data?.label, "姓名");
});

/* ------------------------------------------------------------------- urls */

test("sanitizePageUrl keeps origin, path and safe hash route", () => {
  assert.deepEqual(
    sanitizePageUrl("https://user:pass@zhaopin.kuaishou.cn/recruit/e/#/official/trainee/job-apply/32271"),
    {
      url: "https://zhaopin.kuaishou.cn/recruit/e/#/official/trainee/job-apply/32271",
      siteKey: "zhaopin.kuaishou.cn",
    },
  );
});

test("sanitizePageUrl drops query strings and hash queries", () => {
  assert.deepEqual(sanitizePageUrl("https://example.com/job/1?email=a@b.com&token=x"), {
    url: "https://example.com/job/1",
    siteKey: "example.com",
  });
  assert.deepEqual(sanitizePageUrl("https://example.com/app#/apply?token=x"), {
    url: "https://example.com/app",
    siteKey: "example.com",
  });
});

test("sanitizePageUrl survives non-URL input", () => {
  assert.deepEqual(sanitizePageUrl("not a url?with=query"), {
    url: "not a url",
    siteKey: "",
  });
});

/* ------------------------------------------------------------- ring buffer */

test("diagnosticId returns distinct sortable ids", () => {
  const ids = new Set(Array.from({ length: 200 }, () => diagnosticId("ev")));
  assert.equal(ids.size, 200);
  assert.ok([...ids].every((id) => id.startsWith("ev-")));
});

test("appendDiagnosticEvent keeps the newest events within the limit", () => {
  const events: DiagnosticEvent[] = [];
  for (let index = 0; index < 10; index += 1) {
    events.push(createDiagnosticEvent({ scope: "worker", event: `e${index}` }));
  }
  const next = appendDiagnosticEvent(events, createDiagnosticEvent({ scope: "worker", event: "newest" }), 5);
  assert.equal(next.length, 5);
  assert.equal(next.at(-1)?.event, "newest");
  assert.equal(next[0]?.event, "e6");
});

test("compactDiagnosticEvents enforces the event limit", () => {
  const events = Array.from({ length: 20 }, (_, index) =>
    createDiagnosticEvent({ scope: "worker", event: `e${index}` }),
  );
  const next = compactDiagnosticEvents(events, DIAGNOSTIC_BYTE_LIMIT, 5);
  assert.equal(next.length, 5);
  assert.equal(next.at(-1)?.event, "e19");
});

test("compactDiagnosticEvents enforces the byte budget from the tail", () => {
  const events = Array.from({ length: 200 }, (_, index) =>
    createDiagnosticEvent({
      scope: "content",
      event: `e${index}`,
      data: { note: "x".repeat(2_000) },
    }),
  );
  const before = JSON.stringify(events).length;
  const next = compactDiagnosticEvents(events, 50_000, 500);
  assert.ok(next.length > 0);
  assert.ok(next.length < events.length);
  assert.ok(JSON.stringify(next).length <= 50_000, `still ${JSON.stringify(next).length} bytes`);
  assert.ok(before > 50_000);
  assert.equal(next.at(-1)?.event, "e199");
});

/* ----------------------------------------------------------------- bundle */

test("buildDiagnosticBundle redacts description, snapshot and events", () => {
  const bundle = buildDiagnosticBundle({
    reportId: diagnosticId("diag"),
    createdAt: 1_700_000_000_000,
    description: "我的邮箱 a@b.com，手机 13800138000",
    environment: {
      browser: "Mozilla/5.0 https://example.com/x?token=1",
      platform: "Win32",
      language: "zh-CN",
      extensionVersion: "0.1.0",
    },
    snapshot: {
      page: {
        siteKey: "example.com",
        url: "https://example.com/job/1?token=secret",
        title: "岗位详情",
      },
      scan: {
        fieldCount: 2,
        fields: [
          { label: "姓名", key: "name", confidence: 0.9, kind: "text" },
          { label: "手机号码", key: "phone", confidence: 0.8, kind: "tel" },
        ],
      },
      fill: {
        filled: 1,
        failed: 0,
        skipped: 1,
        outcomes: [{ label: "姓名", ok: true }],
      },
    },
    events: [
      createDiagnosticEvent({
        scope: "content",
        event: "fill.completed",
        data: { filled: 1, value: "张三", note: "a@b.com" },
      }),
    ],
  });

  assert.equal(bundle.schemaVersion, 1);
  assert.ok(bundle.reportId.startsWith("diag-"));
  assert.equal(bundle.description, "我的邮箱 [email]，手机 [phone]");
  assert.equal(bundle.snapshot.page?.url, "https://example.com/job/1");
  assert.equal(bundle.snapshot.scan?.fields[0]?.label, "姓名");
  assert.equal(bundle.environment.browser, "Mozilla/5.0 https://example.com/x");
  assert.equal(bundle.events[0]?.data?.value, "[redacted]");
  assert.equal(bundle.events[0]?.data?.note, "[email]");
  assert.ok(!JSON.stringify(bundle).includes("13800138000"));
  assert.ok(!JSON.stringify(bundle).includes("a@b.com"));
  assert.ok(!JSON.stringify(bundle).includes("张三"));
  assert.ok(!JSON.stringify(bundle).includes("token=secret"));
});

test("buildDiagnosticBundle omits a blank description", () => {
  const bundle = buildDiagnosticBundle({
    reportId: "diag-1",
    createdAt: 0,
    description: "   ",
    environment: { browser: "b", platform: "p", language: "l", extensionVersion: "v" },
    snapshot: {},
    events: [],
  });
  assert.equal("description" in bundle, false);
});
