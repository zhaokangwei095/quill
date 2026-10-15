import assert from "node:assert/strict";
import test from "node:test";

import {
  addNote,
  advanceStage,
  analyzeGaps,
  analyzeJd,
  createRecord,
  draftCoverLetter,
  extractHardRequirements,
  extractKeywords,
  filterRecords,
  ledgerInsights,
  ledgerStats,
  ledgerToCsv,
  nextSteps,
  parseResume,
  sortRecords,
  splitRequirements,
  tailorResume,
  upcomingDeadlines,
  type Profile,
} from "@quill/core";

const RESUME = `
陈默
男 | 1998.11 | 手机：13700001111 | 邮箱：chenmo@example.com

求职意向
意向岗位：后端开发工程师    意向城市：深圳

教育经历
华中科技大学 计算机科学与技术 本科 2016.09 - 2020.06
GPA 3.6/4.0

工作经历
腾讯科技（深圳）有限公司 | 后端开发工程师 | 深圳 | 2020.07 - 至今
• 负责微信支付对账系统的开发与维护，日均处理 5000 万笔交易
• 主导将核心服务从单体拆分为微服务，接口平均延迟从 200ms 降到 60ms
• 使用 Go 与 Kubernetes 搭建高可用集群，线上可用性达到 99.99%
• 推动团队引入单元测试，核心模块覆盖率从 40% 提升到 85%

项目经历
分布式订单系统 | 技术负责人 | 2021.03 - 2021.11
• 基于 Kafka 与 Redis 设计异步下单链路，峰值 QPS 达到 30000
• 实现分布式锁与幂等方案，重复下单率降为 0

专业技能
编程语言：Go、Java、Python
中间件：Kafka、Redis、MySQL、Kubernetes、Docker
证书：CET-6 (540)
`;

const JD = `
招聘岗位：高级后端开发工程师
工作地点：深圳
公司：某大型互联网公司

岗位职责
1. 负责核心交易系统的架构设计与开发
2. 主导系统性能优化与稳定性建设
3. 参与技术方案评审，推动工程规范落地

任职要求
1. 本科及以上学历，计算机相关专业
2. 3 年以上后端开发经验，精通 Go 或 Java
3. 熟悉 MySQL、Redis、Kafka 等常用中间件
4. 熟悉 Kubernetes 与 Docker，有容器化落地经验
5. 有高并发、分布式系统设计经验
6. 具备良好的沟通能力与团队协作精神

加分项
1. 有支付或金融相关业务经验
2. 熟悉 Flink 等实时计算框架
`;

function profileOf(): Profile {
  return parseResume(RESUME).profile;
}

/* ---------------------------------------------------------------------- JD */

test("analyzeJd separates requirements from responsibilities", () => {
  const jd = analyzeJd(JD);
  assert.equal(jd.role, "高级后端开发工程师");
  assert.ok(jd.requirements.length >= 6, `only found ${jd.requirements.length} requirements`);
  assert.ok(jd.requirements.some((item) => item.text.includes("Kubernetes")));
  // A responsibility line must not be treated as a requirement.
  assert.ok(!jd.requirements.some((item) => item.text.includes("架构设计与开发")));
});

test("analyzeJd weights must-haves above nice-to-haves", () => {
  const jd = analyzeJd(JD);
  const kubernetes = jd.requirements.find((item) => item.text.includes("Kubernetes"));
  const flink = jd.requirements.find((item) => item.text.includes("Flink"));
  assert.ok(kubernetes, "Kubernetes requirement should exist");
  assert.ok(flink, "Flink nice-to-have should exist");
  assert.equal(kubernetes?.mustHave, true);
  assert.equal(flink?.mustHave, false);
  assert.ok((kubernetes?.weight ?? 0) > (flink?.weight ?? 0));
});

test("extractHardRequirements reads degrees, years and cities", () => {
  const hard = extractHardRequirements(JD);
  assert.ok(hard.degrees.includes("本科"));
  assert.equal(hard.minYears, 3);
  assert.ok(hard.cities.includes("深圳"));
});

test("extractKeywords finds technology names", () => {
  const { keywords, derived } = extractKeywords("熟悉 Kafka、Redis 与 Kubernetes，精通 Go 或 Java");
  assert.equal(derived, false, "curated vocabulary should have matched");
  for (const expected of ["Kafka", "Redis", "Kubernetes", "Go", "Java"]) {
    assert.ok(keywords.includes(expected), `missing ${expected}`);
  }
});

test("extractKeywords falls back to derived terms for unknown industries", () => {
  const { keywords, derived } = extractKeywords("熟悉临床试验数据管理规范");
  assert.equal(derived, true);
  assert.ok(keywords.length > 0, "a fallback must still produce something to look for");
  assert.ok(keywords.some((term) => term.includes("临床") || term.includes("数据") || term.includes("试验")));
});

test("splitRequirements handles numbered and bulleted blocks", () => {
  const requirements = splitRequirements("1. 本科及以上学历；2. 精通 Go；• 熟悉 Redis");
  assert.equal(requirements.length, 3);
  assert.ok(requirements[0]?.includes("本科"));
});

/* ------------------------------------------------------------------- gaps */

test("analyzeGaps distinguishes matched, partial and missing", () => {
  const profile = profileOf();
  const jd = analyzeJd(JD);
  const gaps = analyzeGaps(profile, jd);
  assert.ok(gaps.length > 0);

  const go = gaps.find((gap) => gap.requirement.includes("Go"));
  assert.equal(go?.verdict, "matched", "the resume proves Go experience");

  const flink = gaps.find((gap) => gap.requirement.includes("Flink"));
  assert.equal(flink?.verdict, "gap", "Flink is genuinely absent");
  assert.ok(flink?.suggestion.includes("如实"), "a gap must be stated honestly");

  // Gaps come first so the person sees the blockers.
  const firstGapIndex = gaps.findIndex((gap) => gap.verdict === "gap");
  const lastMatchIndex = gaps.map((gap) => gap.verdict).lastIndexOf("matched");
  if (firstGapIndex >= 0 && lastMatchIndex >= 0) assert.ok(firstGapIndex < lastMatchIndex);
});

test("analyzeGaps finds the closest evidence for a partial match", () => {
  const profile = profileOf();
  const jd = analyzeJd("任职要求\n1. 熟悉支付与金融相关业务");
  const gaps = analyzeGaps(profile, jd);
  const payment = gaps.find((gap) => gap.requirement.includes("支付"));
  assert.equal(payment?.verdict, "matched", "the resume mentions 支付");
  assert.ok(payment?.closest.includes("支付"));
});

/* --------------------------------------------------------------- tailoring */

test("tailorResume ranks bullets by relevance to the posting", () => {
  const profile = profileOf();
  const jd = analyzeJd(JD);
  const report = tailorResume(profile, jd, { maxBullets: 3 });
  const experience = report.sections.find((section) => section.heading.includes("腾讯"));
  assert.ok(experience, "experience section should exist");
  assert.ok(experience.bullets.length <= 3);
  // The Go/Kubernetes/MySQL bullets are more relevant than the coverage line.
  const combined = experience.bullets.map((bullet) => bullet.text).join(" ");
  assert.ok(/Kubernetes|Kafka|Redis|Go/.test(combined));
});

test("tailorResume never invents experience", () => {
  const profile = profileOf();
  const jd = analyzeJd(JD);
  const report = tailorResume(profile, jd);
  const allText = report.sections
    .flatMap((section) => section.bullets.map((bullet) => bullet.text))
    .join(" ");
  // Flink is required-adjacent and NOT in the resume — it must not appear.
  assert.ok(!allText.includes("Flink"), "a missing skill must not be fabricated into a bullet");
});

test("tailorResume keeps every original bullet traceable", () => {
  const profile = profileOf();
  const report = tailorResume(profile, analyzeJd(JD));
  for (const section of report.sections) {
    for (const bullet of section.bullets) {
      if (section.heading.includes("技能")) continue; // generated from the skill list
      assert.ok(bullet.source, `bullet "${bullet.text.slice(0, 20)}" has no source`);
      assert.ok(
        bullet.note.length > 0,
        "every rewritten bullet must explain what changed",
      );
    }
  }
});

test("tailorResume reports a coverage ratio between 0 and 1", () => {
  const report = tailorResume(profileOf(), analyzeJd(JD));
  assert.ok(report.coverage >= 0 && report.coverage <= 1);
  assert.ok(report.coverage > 0.4, `coverage should be substantial, got ${report.coverage}`);
});

test("tailorResume orders skills by relevance, without adding any", () => {
  const profile = profileOf();
  const report = tailorResume(profile, analyzeJd(JD));
  const skills = report.sections.find((section) => section.heading === "专业技能");
  assert.ok(skills);
  const listed = skills.bullets[0]?.text.split("、") ?? [];
  for (const skill of listed) {
    assert.ok(
      profile.skills.items.includes(skill),
      `tailored skills added "${skill}" which is not in the profile`,
    );
  }
  // The JD's own technologies should come first.
  assert.ok(["Go", "Kafka", "Redis", "MySQL", "Kubernetes", "Docker"].includes(listed[0] ?? ""));
});

test("tailorResume asks for interview prep on real gaps", () => {
  const report = tailorResume(profileOf(), analyzeJd(JD));
  assert.ok(report.interviewPrompts.length > 0);
  assert.ok(report.interviewPrompts.some((prompt) => prompt.includes("Flink") || prompt.includes("学历")));
});

test("draftCoverLetter quotes the candidate's own evidence", () => {
  const profile = profileOf();
  const jd = analyzeJd(JD);
  const letter = draftCoverLetter(profile, jd);
  assert.ok(letter.includes("陈默"), "the letter should be signed");
  assert.ok(letter.includes("高级后端开发工程师"));
  assert.ok(/Kafka|Redis|Kubernetes|Go/.test(letter), "the letter should cite real skills");
  assert.ok(!letter.includes("Flink"), "the letter must not claim a missing skill");
});

test("tailorResume survives a profile with no experience", () => {
  const bare: Profile = {
    ...profileOf(),
    experience: [],
    projects: [],
  };
  const report = tailorResume(bare, analyzeJd(JD));
  assert.ok(report.gaps.length > 0);
  assert.ok(report.coverage < 0.8, "without experience coverage should be low");
});

/* ----------------------------------------------------------------- ledger */

test("createRecord starts a timeline", () => {
  const record = createRecord({ company: "腾讯", role: "后端开发", url: "https://x" }, );
  assert.equal(record.company, "腾讯");
  assert.ok(record.timeline.length >= 1);
  assert.equal(record.stage, "submitted");
});

test("createRecord honours a draft stage", () => {
  const record = createRecord({ company: "A", role: "B", stage: "draft" });
  assert.equal(record.stage, "draft");
  assert.equal(record.appliedAt, undefined);
});

test("advanceStage records history without losing data", () => {
  const record = createRecord({ company: "腾讯", role: "后端开发" });
  const advanced = advanceStage(record, "interview-1", "约到一面", 5000);
  assert.equal(advanced.stage, "interview-1");
  assert.equal(advanced.timeline.length, record.timeline.length + 1);
  assert.equal(advanced.timeline.at(-1)?.note, "约到一面");
  // Advancing to the same stage is a no-op, not a spurious timeline entry.
  assert.equal(advanceStage(advanced, "interview-1"), advanced);
});

test("ledgerStats counts stages, staleness and response rate", () => {
  const now = 1_700_000_000_000;
  const records = [
    { ...createRecord({ company: "A", role: "R" }, ), updatedAt: now - 1000 },
    advanceStage(createRecord({ company: "B", role: "R" }), "interview-1"),
    advanceStage(createRecord({ company: "C", role: "R" }), "rejected"),
    { ...createRecord({ company: "D", role: "R" }, ), updatedAt: now - 40 * 24 * 3600 * 1000 },
  ];
  const stats = ledgerStats(records, now);
  assert.equal(stats.total, 4);
  assert.equal(stats.byStage["interview-1"], 1);
  assert.equal(stats.byStage.rejected, 1);
  assert.equal(stats.upcoming, 1);
  assert.equal(stats.stale.length, 1, "only the 40-day-old active record is stale");
  assert.ok(stats.responseRate > 0 && stats.responseRate <= 1);
});

test("ledgerInsights flags stale applications with company names", () => {
  const now = 1_700_000_000_000;
  const records = [
    { ...createRecord({ company: "美团", role: "R" }), stage: "screening" as const, updatedAt: now - 30 * 24 * 3600 * 1000 },
  ];
  const insights = ledgerInsights(records, now);
  assert.ok(insights.some((insight) => insight.detail.includes("美团")));
});

test("sortRecords orders by urgency", () => {
  const now = 1_700_000_000_000;
  const urgent = { ...createRecord({ company: "Urgent", role: "R" }), nextAction: { what: "回复", dueAt: now + 1000 } };
  const later = { ...createRecord({ company: "Later", role: "R" }), nextAction: { what: "跟进", dueAt: now + 900_000_000 } };
  const sorted = sortRecords([later, urgent], "urgency");
  assert.equal(sorted[0]?.company, "Urgent");
});

test("filterRecords searches across company, role and notes", () => {
  const records = [
    addNote(createRecord({ company: "腾讯", role: "后端" }), "面试官问了分布式"),
    createRecord({ company: "阿里", role: "前端", city: "杭州" }),
  ];
  assert.equal(filterRecords(records, "腾讯").length, 1);
  assert.equal(filterRecords(records, "分布式").length, 1);
  assert.equal(filterRecords(records, "杭州").length, 1);
  assert.equal(filterRecords(records, "").length, 2);
});

test("upcomingDeadlines surfaces only near-term open items", () => {
  const now = 1_700_000_000_000;
  const records = [
    { ...createRecord({ company: "A", role: "R" }), nextAction: { what: "笔试", dueAt: now + 2 * 24 * 3600 * 1000 } },
    { ...createRecord({ company: "B", role: "R" }), nextAction: { what: "远", dueAt: now + 30 * 24 * 3600 * 1000 } },
    { ...createRecord({ company: "C", role: "R" }), stage: "rejected" as const, nextAction: { what: "已结束", dueAt: now + 1000 } },
  ];
  const upcoming = upcomingDeadlines(records, 7, now);
  assert.equal(upcoming.length, 1);
  assert.equal(upcoming[0]?.company, "A");
});

test("ledgerToCsv escapes commas and quotes", () => {
  const record = createRecord({ company: 'Acme, "Inc"', role: "后端" });
  const csv = ledgerToCsv([record]);
  const [header, row] = csv.split("\r\n");
  assert.ok(header?.startsWith("公司,"));
  assert.ok(row?.includes('"Acme, ""Inc"""'));
});

test("nextSteps tells a brand-new user to upload a resume", () => {
  const steps = nextSteps({
    documents: [],
    analyses: [],
    reports: [],
    records: [],
    settings: {
      appearance: "system",
      autoScan: true,
      autoApplyConfident: false,
      learnFromUserInput: true,
      confirmLearned: true,
      preserveExisting: true,
      highlightFilled: true,
      composeEssays: true,
    },
    memoryCount: 0,
  });
  assert.equal(steps[0]?.action, "upload-resume");
});

test("nextSteps moves on once a profile exists", () => {
  const profile = profileOf();
  const steps = nextSteps({
    profile,
    documents: [],
    analyses: [],
    reports: [],
    records: [],
    settings: {
      appearance: "system",
      autoScan: true,
      autoApplyConfident: false,
      learnFromUserInput: true,
      confirmLearned: true,
      preserveExisting: true,
      highlightFilled: true,
      composeEssays: true,
    },
    memoryCount: 0,
  });
  assert.ok(!steps.some((step) => step.action === "upload-resume"));
  assert.ok(steps.some((step) => step.action === "new-analysis"));
});
