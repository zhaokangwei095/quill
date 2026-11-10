/**
 * Regressions found by probing saved real application pages.
 *
 * Every case below was first observed by `npm run probe` against a page in
 * `../测试html` (Tencent's campus resume editor, Baidu, Xiaomi), then reduced to
 * a descriptor here. The synthetic fixture cannot produce these layouts: they
 * depend on labels the vendors invented, and on hint text that is really an
 * autocomplete list.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { classifyField, classifyFields, type FieldDescriptor } from "@quill/core";

function field(overrides: Partial<FieldDescriptor>): FieldDescriptor {
  return {
    ref: "probe",
    kind: "text",
    label: "",
    labelSource: "preceding",
    required: false,
    disabled: false,
    readOnly: false,
    section: "unknown",
    ...overrides,
  };
}

function keyOf(overrides: Partial<FieldDescriptor>): string {
  return classifyField(field(overrides)).key;
}

/* --------------------------------------------------------------- Tencent */

test("a suggestion list in the hint does not veto the school field", () => {
  /*
   * Tencent's school input carries a datalist rendered as text:
   * 中国科学院大学中国科学院成都分院职工大学中国社会科学院大学
   * education.school excludes 学院 to keep 学院名称 out, and the list contains
   * the substring inside 科学院 — so the exclusion fired and the field became
   * unknown, even though its own label was an exact alias.
   */
  assert.equal(
    keyOf({
      label: "学校名称",
      section: "education",
      placeholder: "请输入学校名称",
      hint: "中国科学院大学中国科学院成都分院职工大学中国社会科学院大学",
    }),
    "education.school",
  );
});

test("Tencent's generic 描述 is the work description inside an experience row", () => {
  assert.equal(
    keyOf({ label: "描述", kind: "textarea", section: "experience", placeholder: "请输入描述内容" }),
    "work.description",
  );
  // The same word in a project row still means the project description.
  assert.equal(
    keyOf({ label: "描述", kind: "textarea", section: "project", placeholder: "请输入描述内容" }),
    "project.description",
  );
});

test("a split 起止时间 pair becomes a start/end date in its own section", () => {
  /*
   * element-ui renders the range question once ("起止时间") and then two date
   * inputs separated by "-". Six fields per resume were unclassified because
   * neither half says 开始 or 结束.
   */
  const classified = classifyFields([
    field({ ref: "edu-start", label: "起止时间", section: "education", placeholder: "选择日期" }),
    field({ ref: "edu-end", label: "-", section: "education", placeholder: "选择日期" }),
    field({ ref: "work-start", label: "起止时间", section: "experience", placeholder: "选择日期" }),
    field({ ref: "work-end", label: "-", section: "experience", placeholder: "选择日期" }),
    field({ ref: "project-start", label: "起止时间", section: "project", placeholder: "选择日期" }),
    field({ ref: "project-end", label: "-", section: "project", placeholder: "选择日期" }),
  ]);

  assert.deepEqual(
    classified.map((item) => item.key),
    [
      "education.startDate",
      "education.endDate",
      "work.startDate",
      "work.endDate",
      "project.startDate",
      "project.endDate",
    ],
  );
});

test("a second 起止时间 row is numbered instead of overwriting the first", () => {
  const classified = classifyFields([
    field({ ref: "a1", label: "起止时间", section: "education", placeholder: "选择日期" }),
    field({ ref: "a2", label: "-", section: "education", placeholder: "选择日期" }),
    field({ ref: "b1", label: "起止时间", section: "education", placeholder: "选择日期" }),
    field({ ref: "b2", label: "-", section: "education", placeholder: "选择日期" }),
  ]);
  assert.equal(classified[0]?.repeatIndex, undefined);
  assert.equal(classified[2]?.repeatIndex, 2);
});

test("a weak first-pass guess is corrected by a split date range", () => {
  /*
   * The experience row's group heading is 实习经历, which is enough to give both
   * date inputs a 0.44/0.33 guess of work.employmentType. The pair is stronger
   * evidence than either guess, so it must be allowed to overwrite them.
   */
  const classified = classifyFields([
    field({ ref: "start", label: "起止时间", groupHeading: "实习经历", placeholder: "选择日期" }),
    field({ ref: "end", label: "-", groupHeading: "实习经历", placeholder: "选择日期" }),
  ]);
  assert.deepEqual(classified.map((item) => item.key), ["work.startDate", "work.endDate"]);
});

test("an essay prompt that lists 专业技能 as a topic is still an essay", () => {
  /*
   * Tencent's 补充信息 placeholder suggests writing about 专业技能、爱好特长,
   * and the word 技能 used to make the whole field a skills summary.
   */
  const [classified] = classifyFields([
    field({
      label: "补充信息",
      kind: "textarea",
      placeholder:
        "请输入其他相关信息，如自我评价，爱好特长，补充信息等。您可以按照如下建议格式填写：1、自我评价：您可以从专业技能、软性素质几个方面对自己的情况进行综合评价",
    }),
  ]);
  assert.equal(classified?.key, "essay.additional");
  assert.equal(classified?.section, "essay");
});

test("成绩排名 is a rank, not a GPA", () => {
  assert.equal(keyOf({ label: "成绩排名", section: "education" }), "education.rank");
});

test("availability questions do not borrow a past role's dates or type", () => {
  // 最早可入职时间 was answered with the start date of a previous job.
  assert.equal(
    keyOf({ label: "最早可入职时间", section: "experience", placeholder: "选择日期" }),
    "preference.availableFrom",
  );
  // 实习时长 was answered with "实习" from the employment-type synonyms.
  assert.equal(
    keyOf({ label: "实习时长", section: "experience", placeholder: "请选择时长" }),
    "preference.internshipDuration",
  );
  assert.equal(
    keyOf({ label: "每周可出勤天数", section: "experience", placeholder: "请选择天数" }),
    "preference.internshipDays",
  );
});

test("Tencent's preference fields get canonical keys", () => {
  assert.equal(keyOf({ label: "当前所处地", placeholder: "请选择当前所处地" }), "contact.currentCity");
  assert.equal(keyOf({ label: "目前就读地", placeholder: "请选择目前就读地" }), "education.city");
  assert.equal(keyOf({ label: "参加面试城市", placeholder: "请输入面试城市" }), "preference.interviewCity");
  assert.equal(keyOf({ label: "感兴趣的事业群", placeholder: "请选择感兴趣的事业群" }), "preference.businessUnit");
  assert.equal(keyOf({ label: "内推串码", placeholder: "如有内推串码可在此填写" }), "preference.referralCode");
});

test("graduate-school extras are classified instead of dropped", () => {
  assert.equal(keyOf({ label: "导师", placeholder: "请输入导师" }), "education.advisor");
  assert.equal(keyOf({ label: "实验室", placeholder: "请输入实验室" }), "education.lab");
  assert.equal(keyOf({ label: "研究方向", placeholder: "请输入研究方向" }), "education.researchDirection");
  assert.equal(keyOf({ label: "论文", kind: "textarea", placeholder: "请输入已发表论文，如未发表则无需填写" }), "education.papers");
});

test("a reference block answers the reference questions, not the applicant's", () => {
  assert.equal(keyOf({ label: "证明人身份", placeholder: "请输入证明人身份" }), "work.refereeTitle");
  /*
   * The label is only 联系电话; the placeholder is what says whose phone it is.
   * contact.phone correctly rejects it as 证明人, and emergencyPhone used to win
   * the vacuum that left.
   */
  assert.equal(
    keyOf({ label: "联系电话", placeholder: "请输入证明人联系电话" }),
    "work.refereePhone",
  );
});

test("awards and programming languages are not left as unknown", () => {
  assert.equal(keyOf({ label: "获奖类型", placeholder: "请选择" }), "skill.awardLevel");
  assert.equal(keyOf({ label: "获奖时间", placeholder: "请选择获奖时间" }), "skill.awardDate");
  assert.equal(keyOf({ label: "开发语言", placeholder: "请输入你擅长的开发语言" }), "skill.programming");
  assert.equal(keyOf({ label: "在项目中担任的角色", section: "project" }), "project.role");
});

/* ------------------------------------------------------------- guards */

test("the new exclusions did not break the fields they were named for", () => {
  // The applicant's own numbers still win when nothing says otherwise.
  assert.equal(keyOf({ label: "手机号码", section: "contact" }), "contact.phone");
  assert.equal(keyOf({ label: "联系电话", section: "contact" }), "contact.phone");
  assert.equal(keyOf({ label: "紧急联系人电话", section: "contact" }), "contact.emergencyPhone");
  // A past role's dates still belong to that role.
  assert.equal(keyOf({ label: "开始时间", section: "experience" }), "work.startDate");
  assert.equal(keyOf({ label: "结束时间", section: "experience" }), "work.endDate");
  // 实习 as an employment type is still an employment type.
  assert.equal(keyOf({ label: "实习", section: "experience" }), "work.employmentType");
  // A hint short enough to be the field's own label still vetoes.
  assert.equal(
    keyOf({ label: "电话", section: "contact", hint: "紧急联系人电话" }),
    "contact.emergencyPhone",
  );
});
