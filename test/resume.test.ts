import assert from "node:assert/strict";
import test from "node:test";

import { parseResume, segmentResume, splitEntries, summarizeProfile } from "@quill/core";

/** A fairly typical Chinese campus-recruitment resume. */
const RESUME_CN = `
张三
男 | 汉族 | 中共党员 | 1999.03 | 籍贯：浙江杭州
手机：13800138000    邮箱：zhangsan@example.com
现居：杭州市西湖区    微信：zs_dev
github.com/zhangsan

求职意向
意向岗位：后端开发工程师    意向城市：杭州、上海
期望薪资：25-35万/年        到岗时间：2026年7月

教育经历
浙江大学 计算机科学与技术 本科 2017.09 - 2021.06
GPA 3.8/4.0，专业排名 5/120
主修课程：数据结构、操作系统、计算机网络、数据库系统
2020年 国家奖学金

浙江大学 计算机技术 硕士 2021.09 - 2024.06
GPA 3.9/4.0
2023年 校级优秀研究生

实习经历
阿里巴巴 | 后端开发实习生 | 杭州 | 2023.06 - 2023.12
• 负责订单中心的高并发接口重构，将平均响应时间从 120ms 降低到 45ms
• 主导设计基于 Kafka 的异步对账链路，日均处理 2000 万笔交易，故障率下降 80%
• 使用 Redis 缓存热点数据，QPS 从 3000 提升到 12000

字节跳动 | 服务端开发实习生 | 北京 | 2022.07 - 2022.10
• 参与推荐系统特征平台开发，基于 Flink 实现实时特征计算
• 优化 Hive SQL 任务，将离线任务耗时从 4 小时缩短到 40 分钟

项目经历
分布式文件存储系统 | 核心开发 | 2022.03 - 2022.06
• 基于 Go 实现 Raft 共识算法，支持 3 节点集群故障自动恢复
• 设计分片策略，单节点写入吞吐达到 8000 QPS

专业技能
编程语言：Java、Go、Python、JavaScript、TypeScript
框架与中间件：Spring Boot、MyBatis、Kafka、Redis、MySQL、Kubernetes
证书：CET-6 (585)、软件设计师
获奖：2021年 中国大学生计算机设计大赛 一等奖
兴趣爱好：长跑、摄影

自我评价
对分布式系统和高并发场景有浓厚兴趣，具备扎实的计算机基础。
习惯用数据衡量结果，在实习中多次通过性能优化带来可量化的收益。
乐于分享，曾在团队内做过 5 次技术分享。
`;

test("segmentResume finds the standard Chinese sections", () => {
  const { sections, header } = segmentResume(RESUME_CN);
  const found = sections.map((section) => section.section);
  assert.ok(header.length > 0, "header should capture the contact block");
  for (const expected of ["preference", "education", "experience", "project", "skill", "essay"]) {
    assert.ok(found.includes(expected as never), `missing section ${expected}`);
  }
});

test("parseResume extracts identity and contact", () => {
  const { profile, warnings } = parseResume(RESUME_CN);
  assert.equal(profile.identity.fullName, "张三");
  assert.equal(profile.identity.gender, "男");
  assert.equal(profile.identity.ethnicity, "汉族");
  assert.equal(profile.identity.politicalStatus, "中共党员");
  assert.equal(profile.identity.birthDate, "1999-03");
  assert.equal(profile.contact.phone, "13800138000");
  assert.equal(profile.contact.email, "zhangsan@example.com");
  assert.equal(profile.contact.wechat, "zs_dev");
  assert.equal(profile.contact.github, "github.com/zhangsan");
  assert.ok(warnings.length <= 2, `unexpected warnings: ${warnings.join(" / ")}`);
});

test("parseResume splits education entries and finds dates", () => {
  const { profile } = parseResume(RESUME_CN);
  assert.equal(profile.education.length, 2, "should find bachelor and master");
  const [bachelor, master] = profile.education;
  assert.equal(bachelor?.school, "浙江大学");
  assert.equal(bachelor?.major, "计算机科学与技术");
  assert.equal(bachelor?.degree, "本科");
  assert.deepEqual(bachelor?.dates, { start: "2017-09", end: "2021-06", current: false });
  assert.equal(bachelor?.gpa, "3.8/4.0");
  assert.equal(master?.degree, "硕士");
});

test("parseResume keeps experience highlights verbatim", () => {
  const { profile } = parseResume(RESUME_CN);
  assert.equal(profile.experience.length, 2);
  const first = profile.experience[0];
  assert.equal(first?.company, "阿里巴巴");
  assert.equal(first?.title, "后端开发实习生");
  assert.equal(first?.city, "杭州");
  assert.deepEqual(first?.dates, { start: "2023-06", end: "2023-12", current: false });
  assert.equal(first?.highlights.length, 3);
  assert.ok(
    first?.highlights[0]?.includes("120ms"),
    "the quantified detail must survive parsing unchanged",
  );
});

test("parseResume finds projects and their stack", () => {
  const { profile } = parseResume(RESUME_CN);
  assert.equal(profile.projects.length, 1);
  const project = profile.projects[0];
  assert.equal(project?.name, "分布式文件存储系统");
  assert.equal(project?.role, "核心开发");
  assert.ok(project?.stack?.includes("Go"));
  assert.equal(project?.highlights.length, 2);
});

test("parseResume collects skills, certificates and awards", () => {
  const { profile } = parseResume(RESUME_CN);
  for (const skill of ["Java", "Go", "Python", "Kafka", "Redis", "MySQL", "Kubernetes"]) {
    assert.ok(profile.skills.items.includes(skill), `missing skill ${skill}`);
  }
  assert.ok(profile.skills.certificates.some((item) => item.includes("CET-6")));
  assert.ok(profile.skills.awards.some((item) => item.includes("计算机设计大赛")));
  assert.ok(profile.skills.interests.includes("长跑"));
});

test("parseResume reads the job preference block", () => {
  const { profile } = parseResume(RESUME_CN);
  assert.equal(profile.preference.position, "后端开发工程师");
  assert.deepEqual(profile.preference.cities, ["杭州", "上海"]);
  assert.equal(profile.preference.salary, "25-35万/年");
});

test("parseResume keeps self evaluation as an essay", () => {
  const { profile } = parseResume(RESUME_CN);
  assert.ok(profile.essays.selfIntro?.includes("分布式系统"));
  assert.ok((profile.essays.selfIntro?.length ?? 0) > 40);
});

test("summarizeProfile produces a short readable digest", () => {
  const { profile } = parseResume(RESUME_CN);
  const lines = summarizeProfile(profile);
  assert.ok(lines.some((line) => line.includes("张三")));
  assert.ok(lines.length >= 3 && lines.length <= 8);
});

test("parseResume handles an English resume", () => {
  const english = `
Li Wei
li.wei@example.com | +86 139 0000 0000 | linkedin.com/in/liwei

EDUCATION
Shanghai Jiao Tong University, Shanghai
Master of Science in Computer Science, 2021 - 2024

WORK EXPERIENCE
ByteDance, Data Engineer Intern, Shanghai, 2023.06 - 2023.12
- Built a Flink pipeline processing 5 million events per hour
- Reduced Spark job runtime by 60% through partitioning

SKILLS
Python, Spark, Flink, SQL, Kubernetes
`;
  const { profile } = parseResume(english);
  assert.equal(profile.identity.fullName, "Li Wei");
  assert.equal(profile.contact.email, "li.wei@example.com");
  assert.equal(profile.contact.linkedin, "linkedin.com/in/liwei");
  assert.equal(profile.education.length, 1);
  assert.equal(profile.education[0]?.school, "Shanghai Jiao Tong University");
  assert.equal(profile.experience.length, 1);
  assert.equal(profile.experience[0]?.company, "ByteDance");
  assert.ok(profile.skills.items.includes("Flink"));
});

test("parseResume does not invent values from empty text", () => {
  const { profile, warnings } = parseResume("");
  assert.equal(profile.identity.fullName, undefined);
  assert.equal(profile.education.length, 0);
  assert.equal(profile.experience.length, 0);
  assert.ok(warnings.length > 0, "an empty resume must produce warnings");
});

test("splitEntries separates entries that begin with a date line", () => {
  const entries = splitEntries(
    [
      "腾讯 | 前端开发实习生 | 深圳 | 2023.07 - 2023.10",
      "• 维护后台管理系统",
      "美团 | 前端实习生 | 北京 | 2022.07 - 2022.09",
      "• 开发订单页面",
    ],
    "experience",
  );
  assert.equal(entries.length, 2);
  assert.ok(entries[0]?.[0]?.includes("腾讯"));
  assert.ok(entries[1]?.[0]?.includes("美团"));
});

test("parseResume tolerates a resume with only work experience", () => {
  const sparse = `
王芳
wangfang@example.com

工作经历
华为技术有限公司 | 软件开发工程师 | 深圳 | 2019.07 - 至今
• 负责基站软件的模块开发
`;
  const { profile } = parseResume(sparse);
  assert.equal(profile.identity.fullName, "王芳");
  assert.equal(profile.contact.email, "wangfang@example.com");
  assert.equal(profile.experience.length, 1);
  assert.equal(profile.experience[0]?.dates?.current, true);
});
