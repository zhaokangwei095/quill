import assert from "node:assert/strict";
import test from "node:test";

import {
  clampToLength,
  countChars,
  diceCoefficient,
  formatRange,
  normalize,
  parseDateRange,
  termScore,
  toHalfWidth,
} from "@quill/core";

test("toHalfWidth folds full-width punctuation and digits", () => {
  assert.equal(toHalfWidth("（必填）１２３"), "(必填)123");
  assert.equal(toHalfWidth("姓名：张三。"), "姓名:张三.");
});

test("normalize removes punctuation and whitespace but keeps CJK", () => {
  assert.equal(normalize("手机 号码（必填）*"), "手机号码必填");
  assert.equal(normalize("E-Mail Address"), "emailaddress");
});

test("termScore prefers exact and boundary matches", () => {
  assert.equal(termScore("手机号码", "手机号码"), 1);
  assert.ok(termScore("请填写手机号码", "手机号码") > 0.9);
  assert.ok(termScore("紧急联系电话", "手机号码") < 0.2);
});

test("diceCoefficient handles CJK bigrams", () => {
  assert.equal(diceCoefficient("教育经历", "教育经历"), 1);
  assert.ok(diceCoefficient("教育经历", "教育背景") > 0.2);
  assert.ok(diceCoefficient("教育经历", "专业技能") < 0.2);
});

test("parseDateRange reads Chinese and numeric ranges", () => {
  assert.deepEqual(parseDateRange("2018.09 - 2022.06"), { start: "2018-09", end: "2022-06", current: false });
  assert.deepEqual(parseDateRange("2023年7月至今"), { start: "2023-07", current: true });
  assert.deepEqual(parseDateRange("2020/03/01~2021/05/12"), {
    start: "2020-03-01",
    end: "2021-05-12",
    current: false,
  });
  assert.equal(parseDateRange("无"), undefined);
});

test("formatRange renders 至今 for current roles", () => {
  assert.equal(formatRange({ start: "2023-07", current: true }), "2023.07 - 至今");
  assert.equal(formatRange({ start: "2018-09", end: "2022-06" }), "2018.09 - 2022.06");
});

test("clampToLength cuts at a sentence boundary", () => {
  const text = "第一句话。第二句话。第三句话。";
  assert.equal(clampToLength(text, 6), "第一句话。");
  assert.equal(clampToLength(text, 100), text);
});

test("countChars counts CJK as characters and ignores whitespace", () => {
  assert.equal(countChars("你好 世界"), 4);
  assert.equal(countChars("hello world"), 10);
});
