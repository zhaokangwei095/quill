/**
 * Tests derived from what the browser probe found on a real form.
 *
 * The synthetic descriptors in `classify.test.ts` are necessary but not
 * sufficient: they have no `name` or `id` attributes, and a real form has both.
 * Every regression below was first observed on the real fixture in
 * `test/fixtures/apply-form.html` and only then reduced to a unit test.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { classifyField, type FieldDescriptor } from "@quill/core";

/** The exact attributes the fixture's name input carries. */
function fixtureField(overrides: Partial<FieldDescriptor>): FieldDescriptor {
  return {
    ref: "id:name",
    kind: "text",
    label: "",
    labelSource: "label-for",
    required: false,
    disabled: false,
    readOnly: false,
    section: "unknown",
    ...overrides,
  };
}

test("a name field is the full name even when its name attribute contains 'name'", () => {
  /*
   * Regression: `identity.fullName` used to exclude the bare word "name", and
   * exclusions were tested against every evidence channel including the `name`
   * attribute. Almost every form names its text inputs something containing
   * "name" (`userName`, `companyName`), so full name was disqualified on
   * virtually every real form — the field fell through to `identity.lastName`
   * via the alias "姓", and the person's surname was typed where their full name
   * belonged.
   */
  const result = classifyField(
    fixtureField({
      label: "姓名",
      name: "userName",
      id: "name",
      section: "identity",
      groupHeading: "基本信息",
    }),
  );
  assert.equal(result.key, "identity.fullName", `got ${result.key} (score ${result.score})`);
});

test("a company name field is not mistaken for the applicant's name", () => {
  const result = classifyField(
    fixtureField({
      label: "公司名称",
      name: "companyName",
      section: "experience",
      groupHeading: "实习或工作经历",
    }),
  );
  assert.equal(result.key, "work.company");
});

test("a school name field is not mistaken for the applicant's name", () => {
  const result = classifyField(
    fixtureField({
      label: "学校名称",
      name: "school[0]",
      section: "education",
      groupHeading: "教育经历",
    }),
  );
  assert.equal(result.key, "education.school");
});

test("an emergency phone field is still separated from the applicant's own", () => {
  /*
   * The other half of the same fix: exclusions must keep working, including when
   * the only signal is a camelCase attribute. "emergencyPhone" splits into the
   * tokens emergency + phone, so the exclusion still fires.
   */
  const byAttribute = classifyField(
    fixtureField({ label: "电话", name: "emergencyPhone", id: "emergencyPhone" }),
  );
  assert.equal(byAttribute.key, "contact.emergencyPhone");

  const byLabel = classifyField(fixtureField({ label: "紧急联系人电话" }));
  assert.equal(byLabel.key, "contact.emergencyPhone");

  const owner = classifyField(fixtureField({ label: "手机号码", name: "mobilePhone", id: "phone" }));
  assert.equal(owner.key, "contact.phone");
});

test("the applicant's own phone is not claimed by a reference-phone field", () => {
  assert.equal(classifyField(fixtureField({ label: "证明人电话" })).key, "work.refereePhone");
  assert.equal(classifyField(fixtureField({ label: "固定电话" })).key, "contact.landline");
});

test("radio groups take their question from the nearest text, not the fieldset legend", () => {
  /*
   * Regression: `groupLegend` returned the enclosing `<fieldset>`'s `<legend>`
   * first. On the fixture, the relatives radio group sits inside the 基本信息
   * fieldset, so its question was read as "基本信息" — the section heading — and
   * the field was classified as an identity field with no key, then handed a
   * default value. The question is a sibling `<span>`, which must win.
   */
  const result = classifyField(
    fixtureField({
      ref: "name:relatives#abc",
      kind: "radio-group",
      label: "是否有亲属在本单位任职",
      labelSource: "wrapper",
      section: "identity",
      groupHeading: "基本信息",
      options: [
        { value: "yes", label: "是" },
        { value: "no", label: "否" },
      ],
    }),
  );
  assert.equal(result.key, "identity.relativesInCompany");
});

test("a consent checkbox is never classified as a fillable answer", () => {
  const result = classifyField(
    fixtureField({
      ref: "name:agree",
      kind: "checkbox",
      label: "我已阅读并同意隐私政策",
      labelSource: "wrapper",
    }),
  );
  assert.equal(result.key, "meta.agreement");
});

test("a field inside a section is classified by that section when its label is generic", () => {
  // "结束时间" appears in both education and experience on the fixture.
  assert.equal(
    classifyField(fixtureField({ label: "结束时间", section: "education", name: "gradDate[0]" })).key,
    "education.endDate",
  );
  assert.equal(
    classifyField(fixtureField({ label: "结束时间", section: "experience", name: "workEnd[0]" })).key,
    "work.endDate",
  );
  assert.equal(
    classifyField(fixtureField({ label: "开始时间", section: "experience", name: "workStart[0]" })).key,
    "work.startDate",
  );
});

test("bracketed repeat indices do not confuse the classifier", () => {
  for (const name of ["school[0]", "school[1]", "school[]"]) {
    assert.equal(
      classifyField(fixtureField({ label: "学校名称", name, section: "education" })).key,
      "education.school",
      `failed for name="${name}"`,
    );
  }
});

test("a captcha is classified but marked unfillable", () => {
  assert.equal(classifyField(fixtureField({ label: "验证码", name: "captcha", id: "code" })).key, "meta.captcha");
});
