import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPlan,
  compactMemory,
  composeAnswer,
  considerObservation,
  decideForField,
  indexMemory,
  maskValue,
  parseResume,
  planSummary,
  readProfile,
  resolveField,
  selectDecisions,
  suggestPromotions,
  type FieldDescriptor,
  type MemoryEntry,
  type PageScan,
  type Profile,
} from "@quill/core";

const RESUME = `
李思远
女 | 汉族 | 共青团员 | 2000.07 | 籍贯：江苏南京
手机：13912345678    邮箱：lisiyuan@example.com
现居：上海市浦东新区

求职意向
意向岗位：前端开发工程师    意向城市：上海、杭州
期望薪资：20-30万/年

教育经历
同济大学 软件工程 本科 2018.09 - 2022.06
GPA 3.7/4.0，专业排名 8/95

实习经历
哔哩哔哩 | 前端开发实习生 | 上海 | 2021.07 - 2021.12
• 负责投稿页重构，首屏加载时间从 2.4s 优化到 1.1s
• 使用 React 与 TypeScript 开发组件库，被 6 个业务线复用

项目经历
在线协作白板 | 前端负责人 | 2021.03 - 2021.06
• 基于 Canvas 实现多人实时协同绘制，支持 50 人同时在线

专业技能
编程语言：JavaScript、TypeScript、Python
框架：React、Vue、Next.js
证书：CET-6 (560)
兴趣爱好：攀岩、手冲咖啡

自我评价
喜欢把复杂的交互拆成可复用的组件，对性能和可访问性有洁癖。
`;

function profileOf(): Profile {
  return parseResume(RESUME).profile;
}

function field(label: string, extra: Partial<FieldDescriptor> = {}): FieldDescriptor {
  return {
    ref: `ref-${label}`,
    kind: "text",
    label,
    labelSource: "label-for",
    required: false,
    disabled: false,
    readOnly: false,
    section: "unknown",
    key: undefined,
    ...extra,
  };
}

/* ------------------------------------------------------------ reading profile */

test("readProfile returns resume values for canonical keys", () => {
  const profile = profileOf();
  assert.equal(readProfile(profile, "identity.fullName")?.value.text, "李思远");
  assert.equal(readProfile(profile, "identity.gender")?.value.text, "女");
  assert.equal(readProfile(profile, "contact.phone")?.value.text, "13912345678");
  assert.equal(readProfile(profile, "contact.email")?.value.text, "lisiyuan@example.com");
  assert.equal(readProfile(profile, "education.school")?.value.text, "同济大学");
  assert.equal(readProfile(profile, "education.major")?.value.text, "软件工程");
  assert.equal(readProfile(profile, "work.company")?.value.text, "哔哩哔哩");
  assert.equal(readProfile(profile, "work.title")?.value.text, "前端开发实习生");
  assert.equal(readProfile(profile, "preference.city")?.value.multiple?.[0], "上海");
});

test("readProfile derives age from the birth date rather than storing it", () => {
  const profile = profileOf();
  const age = readProfile(profile, "identity.age")?.value.text;
  assert.ok(age, "age should be derivable");
  const year = Number.parseInt(age ?? "0", 10);
  assert.ok(year >= 24 && year <= 27, `unexpected age ${age}`);
});

test("readProfile splits a Chinese name into family and given", () => {
  const profile = profileOf();
  assert.equal(readProfile(profile, "identity.lastName")?.value.text, "李");
  assert.equal(readProfile(profile, "identity.firstName")?.value.text, "思远");
});

test("readProfile returns the highest degree when a form asks once", () => {
  const profile = profileOf();
  assert.equal(readProfile(profile, "education.degree")?.value.text, "本科");
});

test("readProfile returns nothing for keys the resume cannot answer", () => {
  const profile = profileOf();
  assert.equal(readProfile(profile, "identity.idNumber"), undefined);
  assert.equal(readProfile(profile, "contact.postalCode"), undefined);
  assert.equal(readProfile(profile, "work.leaveReason"), undefined);
});

/* ------------------------------------------------------------------ deciding */

const baseContext = (profile: Profile, memory: MemoryEntry[] = []) => ({
  profile,
  memory,
  siteKey: "example.com",
  composeEssays: true,
});

test("decideForField produces a ready decision from the profile", () => {
  const profile = profileOf();
  const decision = decideForField(field("手机号码", { key: "contact.phone" }), baseContext(profile));
  assert.equal(decision.status, "ready");
  assert.equal(decision.value?.text, "13912345678");
  assert.equal(decision.evidence.source, "profile");
  assert.ok(decision.confidence >= 0.85);
  assert.ok(decision.rationale.includes("简历"));
});

test("decideForField marks missing when nothing can answer the field", () => {
  const profile = profileOf();
  const decision = decideForField(
    field("身份证号", { key: "identity.idNumber", required: true }),
    baseContext(profile),
  );
  assert.equal(decision.status, "missing");
  assert.equal(decision.value, undefined);
  assert.equal(decision.required, true);
  assert.equal(decision.confidence, 0);
});

test("decideForField never proposes a value for a captcha", () => {
  const profile = profileOf();
  const decision = decideForField(field("验证码", { key: "meta.captcha", required: true }), baseContext(profile));
  assert.equal(decision.status, "missing");
});

test("decideForField preserves content the person already typed", () => {
  const profile = profileOf();
  const target = field("手机号码", { key: "contact.phone" });
  const decision = decideForField(target, {
    ...baseContext(profile),
    existingValues: new Map([[target.ref, "13800000000"]]),
  });
  assert.equal(decision.value?.text, "13800000000");
  assert.ok(decision.rationale.includes("不变"));
});

test("decideForField adapts a value to a select's options", () => {
  const profile = profileOf();
  const decision = decideForField(
    field("性别", {
      key: "identity.gender",
      kind: "select",
      options: [
        { value: "1", label: "男" },
        { value: "2", label: "女" },
      ],
    }),
    baseContext(profile),
  );
  assert.equal(decision.status, "ready");
  assert.equal(decision.value?.raw, "2");
  assert.equal(decision.value?.text, "女");
});

test("decideForField refuses a select whose options cannot express the value", () => {
  const profile = profileOf();
  const decision = decideForField(
    field("政治面貌", {
      key: "identity.politicalStatus",
      kind: "select",
      options: [
        { value: "1", label: "中共党员" },
        { value: "2", label: "群众" },
      ],
    }),
    baseContext(profile),
  );
  // The resume says 共青团员 and the select has no matching option.
  assert.notEqual(decision.status, "ready");
});

test("memory outranks the profile and is cited as such", () => {
  const profile = profileOf();
  const memory: MemoryEntry[] = [
    {
      id: "m1",
      key: "contact.phone",
      labelSnapshot: "手机号码",
      value: "13700000000",
      origin: "learned",
      hits: 2,
      createdAt: 0,
      updatedAt: 10,
      reviewed: false,
    },
  ];
  const decision = decideForField(field("手机号码", { key: "contact.phone" }), baseContext(profile, memory));
  assert.equal(decision.value?.text, "13700000000");
  assert.equal(decision.evidence.source, "memory");
  assert.ok(decision.rationale.includes("填写记录"));
});

test("site-specific memory wins over general memory", () => {
  const profile = profileOf();
  const memory: MemoryEntry[] = [
    {
      id: "general",
      key: "preference.source",
      labelSnapshot: "获取渠道",
      value: "BOSS直聘",
      origin: "learned",
      hits: 5,
      createdAt: 0,
      updatedAt: 20,
      reviewed: true,
    },
    {
      id: "site",
      key: "preference.source",
      labelSnapshot: "获取渠道",
      value: "官网",
      origin: "learned",
      siteKey: "example.com",
      hits: 1,
      createdAt: 0,
      updatedAt: 5,
      reviewed: false,
    },
  ];
  const decision = decideForField(field("获取渠道", { key: "preference.source" }), baseContext(profile, memory));
  assert.equal(decision.value?.text, "官网");
  assert.equal(decision.evidence.source, "site-memory");
});

test("a conflicting memory value surfaces as a choice", () => {
  const profile = profileOf();
  const memory: MemoryEntry[] = [
    {
      id: "a",
      key: "preference.city",
      labelSnapshot: "意向城市",
      value: "北京",
      origin: "confirmed",
      hits: 4,
      createdAt: 0,
      updatedAt: 30,
      reviewed: true,
    },
    {
      id: "b",
      key: "preference.city",
      labelSnapshot: "意向城市",
      value: "深圳",
      origin: "confirmed",
      hits: 4,
      createdAt: 0,
      updatedAt: 25,
      reviewed: true,
    },
  ];
  const decision = decideForField(field("意向城市", { key: "preference.city" }), baseContext(profile, memory));
  assert.equal(decision.status, "choice");
  assert.ok((decision.candidates?.length ?? 0) >= 2);
});

test("inferred values arrive as review, not ready", () => {
  const profile = profileOf();
  const decision = decideForField(
    field("是否接受调剂", { key: "preference.relocation" }),
    baseContext(profile),
  );
  assert.equal(decision.status, "review");
  assert.equal(decision.evidence.source, "default");
  assert.ok(decision.caution, "a default must be disclosed");
});

test("a composed essay is labelled and carries a caution", () => {
  const profile = profileOf();
  // Remove the explicit essay so composing is the only route.
  profile.essays.selfIntro = undefined;
  const decision = decideForField(field("自我介绍", { key: "essay.selfIntro", kind: "textarea" }), baseContext(profile));
  assert.ok(decision.value, "a self intro should be composable from the resume");
  assert.equal(decision.evidence.source, "composed");
  assert.equal(decision.status, "review");
  assert.ok(decision.caution?.includes("通读"));
});

test("mandatory fields are marked as required so the panel can prioritise", () => {
  const profile = profileOf();
  const decision = decideForField(
    field("身份证号", { key: "identity.idNumber", required: true }),
    baseContext(profile),
  );
  assert.equal(decision.required, true);
});

/* ------------------------------------------------------------------- planning */

function scanOf(fields: FieldDescriptor[]): PageScan {
  return {
    url: "https://example.com/apply",
    origin: "https://example.com",
    title: "Apply",
    siteKey: "example.com",
    scannedAt: Date.now(),
    fields,
  };
}

test("buildPlan orders work and reports a tally", () => {
  const profile = profileOf();
  const scan = scanOf([
    field("自我介绍", { ref: "f-essay", key: "essay.selfIntro", kind: "textarea", section: "essay" }),
    field("手机号码", { ref: "f-phone", key: "contact.phone", section: "contact" }),
    field("姓名", { ref: "f-name", key: "identity.fullName", section: "identity" }),
    field("身份证号", { ref: "f-id", key: "identity.idNumber", section: "identity", required: true }),
  ]);
  const plan = buildPlan(scan, baseContext(profile));
  assert.equal(plan.decisions.length, 4);
  assert.equal(plan.tally.ready + plan.tally.review + plan.tally.choice + plan.tally.missing, 4);
  // Identity is applied before essays.
  const order = plan.decisions.map((decision) => decision.ref);
  assert.ok(order.indexOf("f-name") < order.indexOf("f-essay"));
  assert.ok(plan.notes.length > 0, "the plan should explain what it could not do");
});

test("buildPlan indexes repeated rows so the 2nd school reads the 2nd entry", () => {
  const profile = profileOf();
  profile.education.push({
    id: "edu-2",
    school: "清华大学",
    major: "计算机技术",
    degree: "硕士",
  });
  const scan = scanOf([
    field("学校名称", { ref: "s1", key: "education.school", section: "education" }),
    field("学校名称", { ref: "s2", key: "education.school", section: "education" }),
  ]);
  const plan = buildPlan(scan, baseContext(profile));
  const [first, second] = plan.decisions;
  assert.equal(first?.value?.text, "同济大学");
  assert.equal(second?.value?.text, "清华大学");
});

test("selectDecisions applies only what was asked for", () => {
  const profile = profileOf();
  const scan = scanOf([
    field("姓名", { ref: "a", key: "identity.fullName" }),
    field("是否接受调剂", { ref: "b", key: "preference.relocation" }),
  ]);
  const plan = buildPlan(scan, baseContext(profile));
  assert.deepEqual(
    selectDecisions(plan).map((decision) => decision.ref),
    ["a"],
    "review items must not be included by default",
  );
  assert.deepEqual(
    selectDecisions(plan, { includeReview: true }).map((decision) => decision.ref).sort(),
    ["a", "b"],
  );
  assert.deepEqual(selectDecisions(plan, { refs: ["b"], includeReview: true }).map((d) => d.ref), ["b"]);
});

test("planSummary describes the plan in one line", () => {
  const profile = profileOf();
  const plan = buildPlan(
    scanOf([field("姓名", { key: "identity.fullName" }), field("身份证号", { key: "identity.idNumber", required: true })]),
    baseContext(profile),
  );
  const summary = planSummary(plan);
  assert.ok(summary.includes("可"), summary);
});

/* ------------------------------------------------------------------ learning */

test("considerObservation remembers a hand-typed answer", () => {
  const result = considerObservation(
    {
      field: field("身份证号", { key: "identity.idNumber", ref: "id" }),
      value: "320102200007150000",
      proposedValues: [],
      siteKey: "example.com",
      at: 1000,
    },
    [],
  );
  assert.equal(result.action, "new");
  assert.equal(result.entry?.key, "identity.idNumber");
  assert.equal(result.entry?.value, "320102200007150000");
  assert.equal(result.entry?.hits, 1);
});

test("considerObservation never learns the extension's own suggestion", () => {
  const result = considerObservation(
    {
      field: field("姓名", { key: "identity.fullName" }),
      value: "李思远",
      proposedValues: ["李思远"],
      siteKey: "example.com",
      at: 1000,
    },
    [],
  );
  assert.equal(result.action, "skip");
  assert.ok(result.reason.includes("扩展填写"));
});

test("considerObservation reinforces a repeated identical answer", () => {
  const existing: MemoryEntry[] = [
    {
      id: "m1",
      key: "identity.nativePlace",
      labelSnapshot: "籍贯",
      value: "江苏南京",
      origin: "learned",
      siteKey: "example.com",
      hits: 2,
      createdAt: 0,
      updatedAt: 0,
      reviewed: false,
    },
  ];
  const result = considerObservation(
    {
      field: field("籍贯", { key: "identity.nativePlace" }),
      value: "江苏南京",
      proposedValues: [],
      siteKey: "example.com",
      at: 500,
    },
    existing,
  );
  assert.equal(result.action, "reinforce");
  assert.equal(result.entry?.hits, 3);
});

test("considerObservation updates when the person types a new value", () => {
  const existing: MemoryEntry[] = [
    {
      id: "m1",
      key: "preference.city",
      labelSnapshot: "意向城市",
      value: "北京",
      origin: "learned",
      siteKey: "example.com",
      hits: 1,
      createdAt: 0,
      updatedAt: 0,
      reviewed: false,
    },
  ];
  const result = considerObservation(
    {
      field: field("意向城市", { key: "preference.city" }),
      value: "上海",
      proposedValues: ["北京"],
      siteKey: "example.com",
      at: 900,
    },
    existing,
  );
  assert.equal(result.action, "update");
  assert.equal(result.entry?.value, "上海");
  assert.ok(result.reason.includes("北京"));
});

test("considerObservation skips captchas and passwords", () => {
  assert.equal(
    considerObservation(
      {
        field: field("验证码", { key: "meta.captcha" }),
        value: "8a7b",
        proposedValues: [],
        siteKey: "example.com",
        at: 1,
      },
      [],
    ).action,
    "skip",
  );
  assert.equal(
    considerObservation(
      {
        field: field("密码", { kind: "text", inputType: "password" }),
        value: "hunter2",
        proposedValues: [],
        siteKey: "example.com",
        at: 1,
      },
      [],
    ).action,
    "skip",
  );
});

test("considerObservation classifies an unrecognised field by its label", () => {
  const result = considerObservation(
    {
      field: field("是否有亲属在本单位任职", { key: "unknown", ref: "rel" }),
      value: "无",
      proposedValues: [],
      siteKey: "example.com",
      at: 42,
    },
    [],
  );
  assert.equal(result.action, "new");
  assert.equal(result.entry?.key, "identity.relativesInCompany");
});

test("maskValue hides sensitive numbers while keeping their shape", () => {
  assert.equal(maskValue("320102200007150000"), "320••••••••••••000");
  assert.ok(maskValue("lisiyuan@example.com").startsWith("li"));
  assert.ok(!maskValue("lisiyuan@example.com").includes("siyuan"));
});

test("compactMemory merges duplicates and sums hits", () => {
  const memory: MemoryEntry[] = [
    {
      id: "a",
      key: "contact.wechat",
      labelSnapshot: "微信",
      value: "ab",
      origin: "learned",
      hits: 1,
      createdAt: 0,
      updatedAt: 1,
      reviewed: false,
    },
    {
      id: "b",
      key: "contact.wechat",
      labelSnapshot: "微信号",
      value: "ab",
      origin: "confirmed",
      hits: 2,
      createdAt: 2,
      updatedAt: 3,
      reviewed: true,
    },
  ];
  const compacted = compactMemory(memory);
  assert.equal(compacted.length, 1);
  assert.equal(compacted[0]?.hits, 3);
  assert.equal(compacted[0]?.origin, "confirmed");
  assert.equal(compacted[0]?.reviewed, true);
});

test("suggestPromotions surfaces often-repeated non-sensitive answers", () => {
  const memory: MemoryEntry[] = [
    {
      id: "a",
      key: "identity.maritalStatus",
      labelSnapshot: "婚姻状况",
      value: "未婚",
      origin: "learned",
      hits: 5,
      createdAt: 0,
      updatedAt: 1,
      reviewed: false,
    },
    {
      id: "b",
      key: "identity.idNumber",
      labelSnapshot: "身份证号",
      value: "320102200007150000",
      origin: "learned",
      hits: 9,
      createdAt: 0,
      updatedAt: 1,
      reviewed: false,
    },
  ];
  const promotions = suggestPromotions(memory, new Set());
  assert.ok(promotions.some((item) => item.key === "identity.maritalStatus"));
  assert.ok(!promotions.some((item) => item.key === "identity.idNumber"), "sensitive keys stay out");
});

test("indexMemory ranks confirmed entries above merely learned ones", () => {
  const memory: MemoryEntry[] = [
    {
      id: "learned",
      key: "k",
      labelSnapshot: "x",
      value: "learned",
      origin: "learned",
      hits: 9,
      createdAt: 0,
      updatedAt: 1,
      reviewed: false,
    },
    {
      id: "confirmed",
      key: "k",
      labelSnapshot: "x",
      value: "confirmed",
      origin: "confirmed",
      hits: 1,
      createdAt: 0,
      updatedAt: 1,
      reviewed: true,
    },
  ];
  const { byKey } = indexMemory(memory);
  assert.equal(byKey.get("k")?.[0]?.id, "confirmed");
});

/* ----------------------------------------------------------------- composing */

test("composeAnswer builds a self introduction from real resume facts", () => {
  const profile = profileOf();
  const text = composeAnswer("essay.selfIntro", profile, { pageRole: "前端开发工程师" });
  assert.ok(text, "should compose");
  assert.ok(text?.includes("同济大学"), "must use the real school");
  assert.ok(text?.includes("哔哩哔哩"), "must use the real employer");
  assert.ok(text?.includes("前端开发工程师"));
  // Composing must not fabricate a claim that is not in the resume.
  assert.ok(!/字节跳动|腾讯|阿里巴巴/.test(text ?? ""));
});

test("composeAnswer returns undefined rather than inventing content", () => {
  const empty: Profile = {
    ...profileOf(),
    education: [],
    experience: [],
    projects: [],
    skills: { items: [], certificates: [], awards: [], interests: [] },
    identity: {},
    essays: { unclassified: {} },
  };
  assert.equal(composeAnswer("essay.selfIntro", empty), undefined);
  assert.equal(composeAnswer("essay.whyCompany", empty), undefined);
  assert.equal(composeAnswer("essay.achievement", empty), undefined);
});

test("resolveField returns candidates in trust order", () => {
  const profile = profileOf();
  const candidates = resolveField(field("意向城市", { key: "preference.city" }), baseContext(profile));
  assert.ok(candidates.length >= 1);
  assert.equal(candidates[0]?.evidence.source, "profile");
  for (let i = 1; i < candidates.length; i += 1) {
    assert.ok(candidates[i - 1]!.confidence >= candidates[i]!.confidence);
  }
});
