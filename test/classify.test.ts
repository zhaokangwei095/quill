import assert from "node:assert/strict";
import test from "node:test";

import { classifyField, classifyFields, matchOption, scoreOption, detectSection } from "@quill/core";
import type { FieldDescriptor, FieldOption } from "@quill/core";

function field(label: string, extra: Partial<FieldDescriptor> = {}): FieldDescriptor {
  return {
    ref: "r1",
    kind: "text",
    label,
    labelSource: "label-for",
    required: false,
    disabled: false,
    readOnly: false,
    section: "unknown",
    ...extra,
  };
}

test("classifyField maps Chinese labels to canonical keys", () => {
  const cases: Array<[string, string]> = [
    ["姓名", "identity.fullName"],
    ["真实姓名", "identity.fullName"],
    ["手机号码", "contact.phone"],
    ["电子邮箱", "contact.email"],
    ["性别", "identity.gender"],
    ["出生日期", "identity.birthDate"],
    ["政治面貌", "identity.politicalStatus"],
    ["民族", "identity.ethnicity"],
    ["籍贯", "identity.nativePlace"],
    ["身份证号", "identity.idNumber"],
    ["毕业院校", "education.school"],
    ["所学专业", "education.major"],
    ["学历", "education.degree"],
    ["公司名称", "work.company"],
    ["期望薪资", "preference.salary"],
    ["意向城市", "preference.city"],
    ["自我介绍", "essay.selfIntro"],
  ];
  for (const [label, expected] of cases) {
    const result = classifyField(field(label));
    assert.equal(result.key, expected, `"${label}" should map to ${expected}, got ${result.key}`);
  }
});

test("classifyField maps English labels to the same keys", () => {
  const cases: Array<[string, string]> = [
    ["Full Name", "identity.fullName"],
    ["Mobile Phone", "contact.phone"],
    ["Email Address", "contact.email"],
    ["Date of Birth", "identity.birthDate"],
    ["University", "education.school"],
    ["Major", "education.major"],
    ["Job Title", "work.title"],
    ["Expected Salary", "preference.salary"],
    ["Why do you want to work here", "essay.whyCompany"],
  ];
  for (const [label, expected] of cases) {
    const result = classifyField(field(label));
    assert.equal(result.key, expected, `"${label}" should map to ${expected}, got ${result.key}`);
  }
});

test("classifyField is not fooled by excluded neighbours", () => {
  // The applicant's own phone must not be confused with an emergency contact.
  assert.equal(classifyField(field("紧急联系人电话")).key, "contact.emergencyPhone");
  assert.equal(classifyField(field("紧急联系电话")).key, "contact.emergencyPhone");
  assert.equal(classifyField(field("证明人电话")).key, "work.refereePhone");
  assert.equal(classifyField(field("公司名称")).key, "work.company");
  assert.equal(classifyField(field("学校名称")).key, "education.school");
  // A generic 名称 in no section is genuinely ambiguous; it must not silently
  // become the applicant's name.
  assert.notEqual(classifyField(field("名称")).key, "identity.fullName");
});

test("classifyField uses the section to disambiguate short labels", () => {
  const inEducation = classifyField(field("名称", { section: "education", groupHeading: "教育经历" }));
  assert.equal(inEducation.key, "education.school");

  const inWork = classifyField(field("名称", { section: "experience", groupHeading: "工作经历" }));
  assert.equal(inWork.key, "work.company");

  const startEdu = classifyField(field("开始时间", { section: "education" }));
  assert.equal(startEdu.key, "education.startDate");

  const startWork = classifyField(field("开始时间", { section: "experience" }));
  assert.equal(startWork.key, "work.startDate");
});

test("classifyField recognises section-scoped 至今 checkboxes", () => {
  assert.equal(classifyField(field("至今", { kind: "checkbox", section: "education" })).key, "education.current");
  assert.equal(classifyField(field("至今", { kind: "checkbox", section: "experience" })).key, "work.current");
  assert.equal(classifyField(field("至今", { kind: "checkbox", section: "project" })).key, "project.current");
});

test("an absence checkbox is never read as its section's text field", () => {
  const cases: Array<[string, string, FieldDescriptor["section"]]> = [
    ["无实习经历", "meta.noExperience", "experience"],
    ["无项目经历", "meta.noProjects", "project"],
    ["无获奖信息", "meta.noAwards", "skill"],
  ];
  for (const [label, expected, section] of cases) {
    const classified = classifyFields([field(label, { kind: "checkbox", section })])[0];
    assert.equal(classified?.key, expected, `"${label}" should be ${expected}, got ${classified?.key}`);
    // Hands-off means the resolver must never invent a value for it.
    assert.equal(classified?.keyConfidence, 0);
  }
});

test("Tencent's 外语考试/等级 dropdown is the language field", () => {
  assert.equal(
    classifyField(field("外语考试/等级", { kind: "combobox", section: "skill" })).key,
    "skill.language",
  );
});

test("classifyField treats 个人证件 as the document type", () => {
  assert.equal(classifyField(field("个人证件", { kind: "combobox" })).key, "identity.idType");
  // The neighbouring free-text input is the number, not a second type field.
  assert.equal(classifyField(field("证件号码", { section: "identity" })).key, "identity.idNumber");
});

test("classifyField recognises Tencent's AI application questions", () => {
  assert.equal(
    classifyField(field("请列出你常用的 AI 工具&模型", { kind: "textarea", section: "essay" })).key,
    "essay.aiTools",
  );
  assert.equal(
    classifyField(
      field("请描述一个或多个你与AI协作完成的项目或任务", { kind: "textarea", section: "essay" }),
    ).key,
    "essay.aiProjects",
  );
});

test("classifyFields pairs split dates that share one container label", () => {
  const classified = classifyFields([
    field("起止时间", { ref: "start", section: "education", placeholder: "选择日期" }),
    field("起止时间", { ref: "end", section: "education", placeholder: "选择日期" }),
  ]);
  assert.equal(classified[0]?.key, "education.startDate");
  assert.equal(classified[1]?.key, "education.endDate");
  assert.equal(classified[0]?.label, "起止时间（开始）");
  assert.equal(classified[1]?.label, "起止时间（结束）");
});

test("classifyField trusts the autocomplete attribute", () => {
  const result = classifyField(field("", { autocomplete: "email", labelSource: "none" }));
  assert.equal(result.key, "contact.email");
  assert.ok(result.score > 0.9);
});

test("classifyField falls back to attribute names", () => {
  assert.equal(classifyField(field("", { name: "userName", labelSource: "none" })).key, "identity.fullName");
  assert.equal(classifyField(field("", { id: "mobilePhone", labelSource: "none" })).key, "contact.phone");
  assert.equal(classifyField(field("", { name: "graduationSchool" })).key, "education.school");
});

test("classifyField recognises verification codes but marks them unfillable", () => {
  const result = classifyField(field("验证码"));
  assert.equal(result.key, "meta.captcha");
});

test("classifyFields zeroes confidence for never-autofill keys", () => {
  const classified = classifyFields([
    field("验证码", { ref: "a" }),
    field("手机号码", { ref: "b" }),
  ]);
  const captcha = classified.find((item) => item.ref === "a");
  const phone = classified.find((item) => item.ref === "b");
  assert.equal(captcha?.keyConfidence, 0);
  assert.ok((phone?.keyConfidence ?? 0) > 0.8);
});

test("classifyFields numbers repeated section rows", () => {
  const classified = classifyFields([
    field("学校名称", { ref: "s1", section: "education" }),
    field("学校名称", { ref: "s2", section: "education" }),
  ]);
  assert.equal(classified[0]?.repeatIndex, undefined);
  assert.equal(classified[1]?.repeatIndex, 2);
});

test("detectSection reads bilingual headings", () => {
  assert.equal(detectSection("教育经历 Education"), "education");
  assert.equal(detectSection("实习经历"), "experience");
  assert.equal(detectSection("项目经验"), "project");
  assert.equal(detectSection("个人信息"), "identity");
  assert.equal(detectSection("联系方式"), "contact");
  assert.equal(detectSection("乱七八糟"), "unknown");
});

/* ------------------------------------------------------------------ options */

function opt(value: string, label?: string): FieldOption {
  return { value, label: label ?? value };
}

test("matchOption agrees across synonym families", () => {
  const genderOptions = [opt("M", "男"), opt("F", "女")];
  assert.equal(matchOption({ text: "男" }, genderOptions)?.value, "M");
  assert.equal(matchOption({ text: "男性" }, genderOptions)?.value, "M");
  assert.equal(matchOption({ text: "male" }, genderOptions)?.value, "M");
  assert.equal(matchOption({ text: "女" }, genderOptions)?.value, "F");

  const degreeOptions = [opt("bachelor", "本科"), opt("master", "硕士"), opt("phd", "博士")];
  assert.equal(matchOption({ text: "本科" }, degreeOptions)?.value, "bachelor");
  assert.equal(matchOption({ text: "硕士研究生" }, degreeOptions)?.value, "master");
  assert.equal(matchOption({ text: "学士学位" }, degreeOptions)?.value, "bachelor");
  assert.equal(matchOption({ text: "博士研究生" }, degreeOptions)?.value, "phd");
});

test("matchOption handles yes/no question options", () => {
  const yesNo = [opt("1", "是"), opt("0", "否")];
  assert.equal(matchOption({ text: "是" }, yesNo)?.value, "1");
  assert.equal(matchOption({ text: "否" }, yesNo)?.value, "0");
  assert.equal(matchOption({ text: "无" }, yesNo)?.value, "0");
  assert.equal(matchOption({ text: "接受" }, yesNo)?.value, "1");
});

test("matchOption refuses when nothing is close enough", () => {
  const options = [opt("北京"), opt("上海"), opt("深圳")];
  assert.equal(matchOption({ text: "杭州" }, options), undefined);
});

test("matchOption matches numeric salary bands", () => {
  const options = [opt("a", "8000元以下"), opt("b", "8000-12000元"), opt("c", "12000元以上")];
  assert.equal(matchOption({ text: "8000" }, options)?.value, "b");
  assert.equal(matchOption({ text: "8k" }, options)?.value, "b");
});

test("matchOption converts a class rank into a percentile band", () => {
  const options = [opt("top5", "前5%"), opt("top10", "前10%"), opt("top20", "前20%"), opt("other", "其他")];
  assert.equal(matchOption({ text: "6/140" }, options)?.value, "top5");
  assert.equal(matchOption({ text: "12/100" }, options)?.value, "top20");
  assert.equal(matchOption({ text: "30/100" }, options)?.value, "other");
  assert.equal(matchOption({ text: "前10%" }, options)?.value, "top10");
  // A select with no percentile vocabulary is untouched by the pre-pass.
  const cities = [opt("bj", "北京"), opt("sh", "上海")];
  assert.equal(matchOption({ text: "6/140" }, cities), undefined);
});

test("scoreOption prefers exact label matches over fuzzy", () => {
  const options = [opt("x", "本科"), opt("y", "本科生及以上")];
  const exact = scoreOption({ text: "本科" }, options[0]!);
  const partial = scoreOption({ text: "本科" }, options[1]!);
  assert.ok(exact > partial, `exact ${exact} should beat partial ${partial}`);
});

test("matchOption respects disabled options", () => {
  const options: FieldOption[] = [{ value: "a", label: "是", disabled: true }, opt("b", "否")];
  assert.equal(matchOption({ text: "是" }, options), undefined);
});
