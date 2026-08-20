export type DurationUnit =
  | "second"
  | "minute"
  | "hour"
  | "day"
  | "week"
  | "month"
  | "year";

const ENGLISH_AMOUNT_SOURCE =
  String.raw`\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|a|an|half`;
const CJK_NUMERAL_SOURCE = String.raw`[一二三四五六七八九十两零半]{1,3}`;
const ENGLISH_UNIT_SOURCE =
  String.raw`seconds?|minutes?|hours?|days?|weeks?|months?|years?`;
const CJK_UNIT_SOURCE = String.raw`分钟|小时|秒|天|星期|周|月|年`;
const ENGLISH_DURATION_VALUE_SOURCE =
  String.raw`\b(?:(?:over|under|about|around|nearly|more\s+than|less\s+than)\s+)?(?:${ENGLISH_AMOUNT_SOURCE})(?:\s+an)?\s+(?:${ENGLISH_UNIT_SOURCE})\b`;
const CJK_DURATION_VALUE_SOURCE =
  String.raw`(?<amount>${ENGLISH_AMOUNT_SOURCE}|${CJK_NUMERAL_SOURCE})\s*个?\s*(?<unit>${CJK_UNIT_SOURCE})`;

export const DURATION_AMOUNT_SOURCE =
  `(?:${ENGLISH_AMOUNT_SOURCE}|${CJK_NUMERAL_SOURCE})`;
export const DURATION_UNIT_SOURCE =
  `(?:${ENGLISH_UNIT_SOURCE}|${CJK_UNIT_SOURCE})`;
export const DURATION_VALUE_SOURCE =
  `(?:${ENGLISH_DURATION_VALUE_SOURCE}|${CJK_DURATION_VALUE_SOURCE})`;

const CJK_DIGIT: Readonly<Record<string, number>> = Object.freeze({
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9
});

const DURATION_AMOUNT_WORDS: Readonly<Record<string, number>> = Object.freeze({
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10, half: 0.5, 半: 0.5
});

// 岁/点 stay out so age and clock cannot enter this family.
const DURATION_UNIT_ALIASES: Readonly<Record<string, DurationUnit>> = Object.freeze({
  second: "second", seconds: "second", 秒: "second",
  minute: "minute", minutes: "minute", 分钟: "minute",
  hour: "hour", hours: "hour", 小时: "hour",
  day: "day", days: "day", 天: "day",
  week: "week", weeks: "week", 周: "week", 星期: "week",
  month: "month", months: "month", 月: "month",
  year: "year", years: "year", 年: "year"
});

const DURATION_CLASSIFIER_TOKENS: ReadonlySet<string> = new Set(["个"]);

export function normalizeDurationUnit(alias: string): DurationUnit | undefined {
  return DURATION_UNIT_ALIASES[alias];
}

export function isDurationClassifierToken(token: string): boolean {
  return DURATION_CLASSIFIER_TOKENS.has(token);
}

export function parseDurationAmount(raw: string): number | null {
  const named = DURATION_AMOUNT_WORDS[raw];
  if (named !== undefined) return named;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  return parseCjkNumeral(raw);
}

function parseCjkNumeral(raw: string): number | null {
  if (raw === "十") return 10;
  if (!raw.includes("十")) {
    if (raw.length !== 1) return null;
    const digit = CJK_DIGIT[raw];
    return digit !== undefined && digit > 0 ? digit : null;
  }
  const parts = raw.split("十");
  if (parts.length !== 2) return null;
  const [tensPart, onesPart] = parts;
  const tens = tensPart === "" ? 1 : CJK_DIGIT[tensPart ?? ""];
  const ones = onesPart === "" ? 0 : CJK_DIGIT[onesPart ?? ""];
  if (tens === undefined || ones === undefined || tens < 1 || tens > 9) return null;
  if (onesPart !== "" && ones < 1) return null;
  return tens * 10 + ones;
}
