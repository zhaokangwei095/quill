/**
 * Semantic checks shared by the resume parser.
 *
 * The parser used to be positional: whatever sat under a heading was assumed
 * to belong to that section, and the first regex that matched a line won. That
 * breaks on real resumes, where one line carries several facts
 * (“张三 目前在京，可一周内到岗”) and where a value's *shape* is not enough to
 * know its field (“18%” is a rank, not a GPA; “多个城市均可” is a preference,
 * not a city).
 *
 * This module supplies the missing layer: field-level recognisers and
 * validators. Callers use them to accept, reject, or re-route a candidate
 * instead of writing it into the first field whose label matched.
 */

import { normalize, parseDateRange } from "../text.js";

/* ------------------------------------------------------------------- names */

/**
 * The hundred most common Chinese surnames. It is not exhaustive on purpose:
 * it is used to *raise* confidence for a short CJK token, not to reject a name
 * that arrived with an explicit label and a clear boundary.
 */
const COMMON_SURNAMES = new Set(
  [
    "赵", "钱", "孙", "李", "周", "吴", "郑", "王", "冯", "陈", "褚", "卫", "蒋", "沈", "韩", "杨",
    "朱", "秦", "尤", "许", "何", "吕", "施", "张", "孔", "曹", "严", "华", "金", "魏", "陶", "姜",
    "戚", "谢", "邹", "喻", "柏", "水", "窦", "章", "云", "苏", "潘", "葛", "奚", "范", "彭", "郎",
    "鲁", "韦", "昌", "马", "苗", "凤", "花", "方", "俞", "任", "袁", "柳", "酆", "鲍", "史", "唐",
    "费", "廉", "岑", "薛", "雷", "贺", "倪", "汤", "滕", "殷", "罗", "毕", "郝", "邬", "安", "常",
    "乐", "于", "时", "傅", "皮", "卞", "齐", "康", "伍", "余", "元", "卜", "顾", "孟", "平", "黄",
    "和", "穆", "萧", "尹", "姚", "邵", "湛", "汪", "祁", "毛", "禹", "狄", "米", "贝", "明", "臧",
    "计", "伏", "成", "戴", "谈", "宋", "茅", "庞", "熊", "纪", "舒", "屈", "项", "祝", "董", "梁",
    "杜", "阮", "蓝", "闵", "席", "季", "麻", "强", "贾", "路", "娄", "危", "江", "童", "颜", "郭",
    "梅", "盛", "林", "刁", "钟", "徐", "邱", "骆", "高", "夏", "蔡", "田", "樊", "胡", "凌", "霍",
    "虞", "万", "支", "柯", "昝", "管", "卢", "莫", "经", "房", "裘", "缪", "干", "解", "应", "宗",
    "丁", "宣", "贲", "邓", "郁", "单", "杭", "洪", "包", "诸", "左", "石", "崔", "吉", "钮", "龚",
    "程", "嵇", "邢", "滑", "裴", "陆", "荣", "翁", "荀", "羊", "於", "惠", "甄", "曲", "家", "封",
    "芮", "羿", "储", "靳", "汲", "邴", "糜", "松", "井", "段", "富", "巫", "乌", "焦", "巴", "弓",
    "牧", "隗", "山", "谷", "车", "侯", "宓", "蓬", "全", "郗", "班", "仰", "秋", "仲", "伊", "宫",
    "宁", "仇", "栾", "暴", "甘", "钭", "厉", "戎", "祖", "武", "符", "刘", "景", "詹", "束", "龙",
    "叶", "幸", "司", "韶", "郜", "黎", "蓟", "薄", "印", "宿", "白", "怀", "蒲", "邰", "从", "鄂",
    "索", "咸", "籍", "赖", "卓", "蔺", "屠", "蒙", "池", "乔", "阴", "郁", "胥", "能", "苍", "双",
    "闻", "莘", "党", "翟", "谭", "贡", "劳", "逄", "姬", "申", "扶", "堵", "冉", "宰", "郦", "雍",
    "却", "璩", "桑", "桂", "濮", "牛", "寿", "通", "边", "扈", "燕", "冀", "郏", "浦", "尚", "农",
    "温", "别", "庄", "晏", "柴", "瞿", "阎", "充", "慕", "连", "茹", "习", "宦", "艾", "鱼", "容",
    "向", "古", "易", "慎", "戈", "廖", "庾", "终", "暨", "居", "衡", "步", "都", "耿", "满", "弘",
    "匡", "国", "文", "寇", "广", "禄", "阙", "东", "欧", "殳", "沃", "利", "蔚", "越", "夔", "隆",
    "师", "巩", "厍", "聂", "晁", "勾", "敖", "融", "冷", "訾", "辛", "阚", "那", "简", "饶", "空",
    "曾", "毋", "沙", "乜", "养", "鞠", "须", "丰", "巢", "关", "蒯", "相", "查", "后", "荆", "红",
    "游", "竺", "权", "逯", "盖", "益", "桓", "公",
  ],
);

const COMPOUND_SURNAMES = [
  "欧阳", "太史", "端木", "上官", "司马", "东方", "独孤", "南宫", "万俟", "闻人", "夏侯", "诸葛",
  "尉迟", "公羊", "赫连", "澹台", "皇甫", "宗政", "濮阳", "公冶", "太叔", "申屠", "公孙", "慕容",
  "仲孙", "钟离", "长孙", "宇文", "司徒", "鲜于", "司空", "闾丘", "子车", "亓官", "司寇", "巫马",
  "公西", "颛孙", "壤驷", "公良", "漆雕", "乐正", "宰父", "谷梁", "拓跋", "夹谷", "轩辕", "令狐",
  "段干", "百里", "呼延", "东郭", "南门", "羊舌", "微生", "公户", "公玉", "公仪", "梁丘", "公仲",
  "公上", "公门", "公山", "公坚", "左丘", "公伯", "西门", "公祖", "第五", "公乘", "贯丘", "公皙",
];

/** Words that end a name in a resume header and begin other information. */
const NAME_BOUNDARY =
  /(目前|现在|现居|现住|当前|在职|在读|应届|求职|期望|意向|手机|电话|邮箱|微信|到岗|入职|可随时|可一周|一周内|立即|随时|男|女|党员|团员|本科|硕士|博士|研究生|大学|学院|学校|专业|学历|学位)/;

const NOT_A_NAME = /^(个人简历|求职简历|应聘简历|简历|履历|resume|curriculum vitae|cv|个人资料|基本信息)$/i;
const NOT_NAME_CONTENT = /(大学|学院|学校|公司|集团|科技|有限|医院|银行|研究院|实验室|中心|简历|求职|招聘)/;

/**
 * Split a labelled value such as “赵康伟 目前在京，可一周内到岗” into the
 * person's name and whatever followed it. The residue is returned so the
 * caller can route it to the city / availability fields instead of losing it.
 */
export function cleanPersonName(value: string): { name?: string; residue?: string } {
  const raw = value.trim().replace(/^[\s:：]+/, "");
  if (!raw) return {};

  // Latin names: “Li Wei”, “San Zhang”, optionally followed by a status.
  const latin = raw.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})(?=$|[\s,，。;；|｜/])/);
  if (latin?.[1]) {
    return { name: latin[1].trim(), residue: raw.slice(latin[0].length).trim() };
  }

  // Cut at the first status word or separator. This is what turns
  // “赵康伟目前在京，可一周内到岗” into “赵康伟” plus a residue.
  let cut = raw.length;
  const statusAt = raw.search(NAME_BOUNDARY);
  if (statusAt >= 2) cut = Math.min(cut, statusAt);
  const separatorAt = raw.search(/[\s,，。;；|｜/]/);
  if (separatorAt >= 2) cut = Math.min(cut, separatorAt);

  const candidate = raw
    .slice(0, cut)
    .replace(/^(姓名|名字|name)[:：]?\s*/i, "")
    .trim();

  if (
    candidate.length >= 2 &&
    candidate.length <= 4 &&
    /^[一-鿿]+$/.test(candidate) &&
    !NOT_A_NAME.test(normalize(candidate)) &&
    !NOT_NAME_CONTENT.test(candidate) &&
    !NAME_BOUNDARY.test(candidate)
  ) {
    const at = raw.indexOf(candidate);
    return { name: candidate, residue: at >= 0 ? raw.slice(at + candidate.length).trim() : "" };
  }

  // No clean boundary: take the longest surname-led prefix. A four-character
  // token starting with an uncommon character is far more likely to be
  // “浙江大学” than a name, hence the surname guard.
  const compound = COMPOUND_SURNAMES.find((item) => raw.startsWith(item));
  const maxLength = compound ? 4 : 3;
  for (let length = Math.min(maxLength, raw.length); length >= 2; length -= 1) {
    const part = raw.slice(0, length).trim();
    if (!/^[一-鿿]+$/.test(part)) continue;
    if (NOT_A_NAME.test(normalize(part)) || NOT_NAME_CONTENT.test(part) || NAME_BOUNDARY.test(part)) continue;
    const hasSurname = compound ? part.startsWith(compound) && part.length > compound.length : COMMON_SURNAMES.has(part[0] ?? "");
    if (hasSurname) return { name: part, residue: raw.slice(length).trim() };
  }

  return { residue: raw };
}

/* ------------------------------------------------------------------- cities */

const CITY_NAMES = new Set(
  [
    "北京", "上海", "天津", "重庆", "石家庄", "唐山", "秦皇岛", "邯郸", "保定", "太原", "大同", "阳泉",
    "长治", "呼和浩特", "包头", "沈阳", "大连", "鞍山", "抚顺", "长春", "吉林", "哈尔滨", "齐齐哈尔",
    "南京", "无锡", "徐州", "常州", "苏州", "南通", "连云港", "扬州", "镇江", "泰州", "宿迁", "杭州",
    "宁波", "温州", "嘉兴", "湖州", "绍兴", "金华", "衢州", "舟山", "台州", "丽水", "合肥", "芜湖",
    "蚌埠", "淮南", "马鞍山", "安庆", "福州", "厦门", "泉州", "漳州", "南昌", "景德镇", "九江", "赣州",
    "济南", "青岛", "淄博", "枣庄", "东营", "烟台", "潍坊", "济宁", "泰安", "威海", "日照", "临沂",
    "德州", "聊城", "滨州", "菏泽", "郑州", "开封", "洛阳", "平顶山", "安阳", "新乡", "焦作", "许昌",
    "南阳", "武汉", "黄石", "十堰", "宜昌", "襄阳", "鄂州", "荆门", "孝感", "荆州", "黄冈", "长沙",
    "株洲", "湘潭", "衡阳", "邵阳", "岳阳", "常德", "益阳", "郴州", "永州", "怀化", "广州", "韶关",
    "深圳", "珠海", "汕头", "佛山", "江门", "湛江", "茂名", "肇庆", "惠州", "梅州", "汕尾", "河源",
    "阳江", "清远", "东莞", "中山", "潮州", "揭阳", "云浮", "南宁", "柳州", "桂林", "梧州", "北海",
    "防城港", "钦州", "贵港", "玉林", "海口", "三亚", "成都", "自贡", "攀枝花", "泸州", "德阳", "绵阳",
    "广元", "遂宁", "内江", "乐山", "南充", "眉山", "宜宾", "广安", "达州", "雅安", "巴中", "资阳",
    "贵阳", "六盘水", "遵义", "昆明", "曲靖", "玉溪", "保山", "昭通", "丽江", "普洱", "临沧", "拉萨",
    "西安", "铜川", "宝鸡", "咸阳", "渭南", "延安", "汉中", "榆林", "安康", "商洛", "兰州", "嘉峪关",
    "金昌", "白银", "天水", "武威", "张掖", "平凉", "酒泉", "庆阳", "定西", "陇南", "西宁", "银川",
    "石嘴山", "吴忠", "固原", "中卫", "乌鲁木齐", "克拉玛依", "香港", "澳门", "台北", "高雄", "新北",
    "桃园", "台中", "台南", "雄安", "远程",
  ],
);

const PROVINCE_NAMES = new Set([
  "河北", "山西", "辽宁", "吉林", "黑龙江", "江苏", "浙江", "安徽", "福建", "江西", "山东", "河南",
  "湖北", "湖南", "广东", "海南", "四川", "贵州", "云南", "陕西", "甘肃", "青海", "台湾", "内蒙古",
  "广西", "西藏", "宁夏", "新疆",
]);

/** Colloquial one-character city abbreviations used in headers. */
const CITY_ALIASES: Record<string, string> = {
  京: "北京",
  沪: "上海",
  穗: "广州",
  深: "深圳",
  杭: "杭州",
  蓉: "成都",
  渝: "重庆",
  汉: "武汉",
  宁: "南京",
  津: "天津",
  苏: "苏州",
  锡: "无锡",
  甬: "宁波",
  厦: "厦门",
  榕: "福州",
  泉: "泉州",
  青: "青岛",
  连: "大连",
  沈: "沈阳",
  郑: "郑州",
  济: "济南",
  肥: "合肥",
  昆: "昆明",
  筑: "贵阳",
  邕: "南宁",
  兰: "兰州",
};

const CITY_LOOKUP = [...CITY_NAMES, ...PROVINCE_NAMES].sort((a, b) => b.length - a.length);

/**
 * Return the city/province named in a value, or undefined when the value is a
 * preference statement rather than a place. “北京市朝阳区” → “北京”;
 * “多个城市均可” → undefined.
 */
export function findCity(value: string): string | undefined {
  let cleaned = value
    .trim()
    .replace(/^[在于是位于地处：:\s]+/, "")
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/[。；;，,].*$/, "")
    .trim();
  if (!cleaned) return undefined;

  // “目前在京” → “京” → 北京.
  const withoutStatus = cleaned.replace(
    /^(目前|现在|当前|现居|现住|现居住地|现居地|所在地|所在城市|目前所在)[:：]?\s*(?:在|于)?\s*/,
    "",
  );
  if (withoutStatus !== cleaned) cleaned = withoutStatus.trim();

  if (isFlexibleLocation(cleaned) && !CITY_NAMES.has(cleaned)) return undefined;
  const alias = CITY_ALIASES[cleaned];
  if (alias) return alias;

  const base = cleaned.replace(/市$/, "");
  if (CITY_NAMES.has(base)) return base;
  if (PROVINCE_NAMES.has(base)) return base;
  if (CITY_NAMES.has(cleaned)) return cleaned;

  return CITY_LOOKUP.find((city) => cleaned.includes(city));
}

/** A statement about location flexibility, not a city name. */
export function isFlexibleLocation(value: string): boolean {
  return /(多个城市|全国|各地|不限|任意|均可|可调剂|接受调剂|服从调剂|一线|新一线|江浙沪|长三角|珠三角|京津冀|remote|远程|海外)/i.test(
    value,
  );
}

/** The phrase itself, so a header does not become a page-long relocation note. */
export function extractFlexibleLocation(value: string): string | undefined {
  const match = value.match(
    /((?:多个城市|全国|各地|不限城市|城市不限|任意城市|均可|接受调剂|服从调剂|可调剂|一线城市|新一线城市|江浙沪|长三角|珠三角|京津冀|远程|remote|海外)[^,，。；;|｜\n]{0,16})/i,
  );
  return match?.[1]?.trim() || undefined;
}

export interface CitySelection {
  cities: string[];
  /** “多个城市均可、可调剂” and similar notes, preserved as a preference. */
  flexible?: string;
  /** Tokens that are neither a city nor a recognisable flexibility note. */
  rejected: string[];
}

export function parseCities(value: string): CitySelection {
  const parts = value
    .split(/[、,，;；/|｜\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const cities: string[] = [];
  const flexible: string[] = [];
  const rejected: string[] = [];

  for (const part of parts) {
    const city = findCity(part);
    if (city) {
      if (!cities.includes(city)) cities.push(city);
      continue;
    }
    if (isFlexibleLocation(part)) flexible.push(part);
    else rejected.push(part);
  }

  return {
    cities,
    flexible: flexible.length > 0 ? flexible.join("、") : undefined,
    rejected,
  };
}

/** “目前在京，可一周内到岗” → 北京. */
export function extractCurrentCity(text: string): string | undefined {
  const match = text.match(
    /(?:现居地|现居住地|当前所在地|所在城市|目前所在|所在地|现居|现住|目前|现在|当前)[:：]?\s*(?:在|于)?\s*([^\s,，。；;|｜\n]{1,12})/,
  );
  if (!match?.[1]) return undefined;
  return findCity(match[1]);
}

/* ----------------------------------------------------------- availability */

const RELATIVE_AVAILABILITY =
  /(随时|即刻|立即|马上|一周内|1周内|两周内|2周内|一个月内|1个月内|三个月内|3个月内|半年内)\s*(?:到岗|入职|上岗|实习|工作)?/;

/**
 * A relative availability is stronger evidence than a date: “可一周内到岗”
 * answers the form's question directly, while “预计2029年7月” is usually a
 * graduation date that happens to sit under the same label.
 */
export function extractAvailability(text: string): string | undefined {
  const relative = text.match(RELATIVE_AVAILABILITY);
  if (relative?.[0]) {
    return relative[0].replace(/^[可\s]+/, "").trim();
  }

  const labelled = text.match(
    /(?:到岗时间|入职时间|最早到岗|最早入职|可到岗|available(?:\s*from)?)\s*[:：]?\s*([^,，。；;|｜\n]{1,30}?)(?=\s{2,}|[，,。；;|｜\n]|$|\s*(?:期望薪资|意向城市|求职类型|期望岗位|薪资))/i,
  );
  return labelled?.[1]?.trim() || undefined;
}

/** Values that describe graduation rather than the day someone can start. */
export function looksLikeGraduation(value: string | undefined): boolean {
  if (!value) return false;
  if (/(毕业|预计|获得学位|取得学位|应届)/.test(value)) return true;
  /*
   * “2029年7月” without the word 毕业 is still more likely a graduation date
   * than an availability. Only flag dates at least two years out, and the
   * caller keeps the value (with a warning) when no relative statement exists.
   */
  const year = value.match(/(?:19|20)\d{2}/)?.[0];
  return Boolean(year && Number(year) >= new Date().getFullYear() + 2);
}

/** “预计 2029年7月毕业” → “2029-07”. */
export function extractGraduationDate(text: string): string | undefined {
  const labelled = text.match(
    /(?:毕业时间|预计毕业|预计于|将于)[:：]?\s*((?:19|20)\d{2}\s*[年./-]\s*\d{1,2}\s*月?)/,
  );
  if (labelled?.[1]) return parseDateRange(labelled[1])?.start;

  const inline = text.match(
    /((?:19|20)\d{2}\s*[年./-]\s*\d{1,2}\s*月?)\s*(?:毕业|获得学位|取得学位)/,
  );
  return inline?.[1] ? parseDateRange(inline[1])?.start : undefined;
}

export function extractPosition(text: string): string | undefined {
  const match = text.match(
    /(?:求职意向|意向岗位|期望岗位|应聘岗位|目标岗位|求职方向|期望职位|意向职位|岗位意向)[:：]?\s*([^,，。；;|｜\n]{2,30})/,
  );
  if (!match?.[1]) return undefined;
  const value = match[1]
    .split(/\s{2,}|(?:意向城市|期望城市|期望薪资|到岗时间|入职时间|求职类型)/)[0]
    ?.trim();
  if (!value || value.length > 30) return undefined;
  if (/^\d{4}/.test(value) || /(城市|薪资|到岗|入职|毕业)/.test(value)) return undefined;
  return value;
}

export interface ResumeSemantics {
  currentCity?: string;
  availableFrom?: string;
  position?: string;
  graduation?: string;
  flexibleLocation?: string;
}

/** Facts that can be read from the header without knowing section boundaries. */
export function extractHeaderSemantics(text: string): ResumeSemantics {
  return {
    currentCity: extractCurrentCity(text),
    availableFrom: extractAvailability(text),
    position: extractPosition(text),
    graduation: extractGraduationDate(text),
    flexibleLocation: extractFlexibleLocation(text),
  };
}

/** Copy non-empty hints from `source` into `target` without overwriting. */
export function mergeSemantics(target: ResumeSemantics, source: ResumeSemantics): ResumeSemantics {
  for (const key of Object.keys(source) as Array<keyof ResumeSemantics>) {
    if (!target[key] && source[key]) target[key] = source[key];
  }
  return target;
}

/* --------------------------------------------------------------- education */

export type EducationMetric = "gpa" | "rank";

export function isGpaValue(value: string): boolean {
  const text = value.trim();
  if (!text || /%/.test(text)) return false;
  const ratio = text.match(/^(\d{1,3}(?:\.\d{1,2})?)\s*\/\s*(\d{1,3}(?:\.\d{1,2})?)$/);
  if (ratio) {
    const score = Number(ratio[1]);
    const base = Number(ratio[2]);
    // A denominator above 100 is a class size, not a GPA scale: 5/120 is a rank.
    return (
      Number.isFinite(score) &&
      Number.isFinite(base) &&
      base > 0 &&
      base <= 100 &&
      score >= 0 &&
      score <= base + 0.001
    );
  }
  return /^\d{1,3}(?:\.\d{1,2})?$/.test(text) && Number(text) <= 100;
}

/**
 * A rank, not a score. “3.8/4.0” and “88/100” are GPAs; “5/120” and “前18%”
 * are ranks. The denominator is the deciding signal.
 */
export function looksLikeRank(value: string): boolean {
  const text = value.trim();
  if (/^前\s*\d/.test(text) || /第\s*\d+\s*名/.test(text)) return true;
  if (/^\d+(?:\.\d+)?%$/.test(text)) return true;

  const ratio = text.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (!ratio) return false;
  const numerator = Number(ratio[1]);
  const denominator = Number(ratio[2]);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return false;
  if (denominator === 100 && numerator > 10) return false;
  return denominator >= 10 && numerator <= denominator;
}

/**
 * Decide whether a labelled education value is a GPA or a rank. The label wins
 * first (“成绩排名” is a rank even when the value is just “18%”); the value's
 * shape is only used when the label is ambiguous.
 */
export function classifyEducationMetric(key: string, value: string): EducationMetric | undefined {
  const normalized = normalize(key);
  const text = value.trim();
  if (!normalized || !text) return undefined;

  if (/(排名|rank)/.test(normalized)) return "rank";

  if (/(gpa|绩点|平均分|平均成绩|加权)/.test(normalized)) {
    // “GPA 88%” may be a percentage score; without a scale, writing it into a
    // GPA field would be a guess. Only accept values that pass the scale check.
    return isGpaValue(text) ? "gpa" : undefined;
  }

  if (/成绩/.test(normalized)) {
    // “成绩排名 18%” never reaches here (rank wins above), but “成绩 18%”
    // does. A ratio or “前18%” is a rank; a bare percentage is ambiguous and
    // is left out rather than put in the wrong field.
    if (/^前/.test(text)) return "rank";
    const ratio = text.match(/^\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?$/);
    if (ratio && looksLikeRank(text)) return "rank";
    return isGpaValue(text) ? "gpa" : undefined;
  }

  return undefined;
}

export function inferAcademicDegree(degree: string | undefined): string | undefined {
  if (!degree) return undefined;
  if (/博士/.test(degree)) return "博士";
  if (/硕士|研究生|mba|emba/i.test(degree)) return "硕士";
  if (/本科|学士/.test(degree)) return "学士";
  return undefined;
}
