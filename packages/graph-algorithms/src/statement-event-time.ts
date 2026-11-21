import { parseAbsoluteTemporalWindow } from "./absolute-temporal-window.js";
import { temporalTermMatches } from "./temporal-terms.js";
import { parseRelativeTemporalTerm, resolveRelativeTemporalWindow } from "./temporal-window.js";

/** Inclusive UTC civil-day interval as epoch milliseconds of each day's midnight. */
export type EventDayInterval = Readonly<{ startDay: number; endDay: number }>;

const DAY_MS = 86_400_000;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`;
const DAY = String.raw`([1-9]|[12]\d|3[01])(?:st|nd|rd|th)?`;
const DATED = [
  [new RegExp(String.raw`\b${MONTH}\.?\s+${DAY},?\s+(\d{4})\b`, "giu"), (m: RegExpMatchArray) => [+m[3]!, month(m[1]!), +m[2]!]],
  [new RegExp(String.raw`\b${DAY}\s+(?:of\s+)?${MONTH}\.?,?\s+(\d{4})\b`, "giu"), (m: RegExpMatchArray) => [+m[3]!, month(m[2]!), +m[1]!]]
] as const;
const YEARLESS = [
  [new RegExp(String.raw`\b${MONTH}\.?\s+${DAY}\b(?!,?\s*\d{4})`, "giu"), (m: RegExpMatchArray) => [month(m[1]!), +m[2]!]],
  [new RegExp(String.raw`\b${DAY}\s+of\s+${MONTH}\b`, "giu"), (m: RegExpMatchArray) => [month(m[2]!), +m[1]!]],
  [/(?<![\d/])(1[0-2]|0?[1-9])\/([12]\d|3[01]|0?[1-9])(?![\d/])/gu, (m: RegExpMatchArray) => [+m[1]! - 1, +m[2]!]],
  [/(?<!\d|年)(\d{1,2})月(\d{1,2})[日号]/gu, (m: RegExpMatchArray) => [+m[1]! - 1, +m[2]!]]
] as const;
const WEEKDAYS = [
  [/\b(sun|mon|tues|wednes|thurs|fri|satur)day\b/giu, (m: RegExpMatchArray) => ["sun", "mon", "tues", "wednes", "thurs", "fri", "satur"].indexOf(m[1]!.toLowerCase())],
  [/(?:周|星期|礼拜)([日天一二三四五六])/gu, (m: RegExpMatchArray) => "日一二三四五六".indexOf(m[1] === "天" ? "日" : m[1]!)]
] as const;
const CJK_DIGITS: Readonly<Record<string, number>> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CJK_RELATIVE = /([一二两三四五六七八九十]{1,3})(天|周|个月|年)前/gu;

function month(name: string): number { return MONTHS.indexOf(name.slice(0, 3).toLowerCase()); }

function cjkNumber(text: string): number | null {
  if (text === "十") return 10;
  const [tens, ones] = text.includes("十") ? text.split("十") : ["", text];
  const value = (text.includes("十") ? (tens === "" ? 1 : CJK_DIGITS[tens!] ?? NaN) * 10 : 0) + (ones === "" ? 0 : CJK_DIGITS[ones!] ?? NaN);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function validDay(year: number, month0: number, day: number): number | null {
  const ms = Date.UTC(year, month0, day);
  return month0 >= 0 && new Date(ms).getUTCDate() === day ? ms : null;
}

/** Event days a statement states, read against its session day: relative terms resolve from the session,
 * dated calendar terms stand, year-less dates and bare weekdays take their latest occurrence on or
 * before the session (a report of the past). No stated time yields none; unknown is not irrelevant. */
export function statementEventIntervals(text: string, sessionDay: number): readonly EventDayInterval[] {
  const out: EventDayInterval[] = [];
  const push = (startMs: number, endMs: number) => out.push({
    startDay: Math.floor(startMs / DAY_MS) * DAY_MS, endDay: Math.floor(endMs / DAY_MS) * DAY_MS });
  const consumed = new Uint8Array(text.length);
  const overlaps = (match: RegExpMatchArray) =>
    consumed.subarray(match.index!, match.index! + match[0].length).includes(1);
  const consume = (match: RegExpMatchArray) => consumed.fill(1, match.index!, match.index! + match[0].length);
  for (const [pattern, parts] of DATED) for (const match of text.matchAll(pattern)) {
    if (overlaps(match)) continue;
    consume(match);
    const [year, month0, day] = parts(match), ms = validDay(year!, month0!, day!);
    if (ms !== null) push(ms, ms);
  }
  takeChineseSpecificity(text, sessionDay, overlaps, consume, push);
  const terms = new Set<string>();
  for (const match of temporalTermMatches(text)) {
    if (overlaps(match)) continue;
    consume(match);
    const term = match[0].trim();
    if (terms.has(term) || terms.size >= 64) continue;
    terms.add(term);
    const relative = parseRelativeTemporalTerm(term.replace(/^a\s+(?=(?:day|week|month|year)s?\s+ago$)/iu, "one "));
    const window = relative === null ? parseAbsoluteTemporalWindow(term) : resolveRelativeTemporalWindow(relative, sessionDay);
    if (window !== null) push(window.startMs, window.endMs);
  }
  const year = new Date(sessionDay).getUTCFullYear();
  for (const [pattern, parts] of YEARLESS) for (const match of text.matchAll(pattern)) {
    if (overlaps(match)) continue;
    const [month0, day] = parts(match);
    const past = [year, year - 1].map(y => validDay(y, month0!, day!)).find(ms => ms !== null && ms <= sessionDay);
    if (past !== undefined && past !== null) push(past, past);
  }
  const weekday = new Date(sessionDay).getUTCDay();
  for (const [pattern, index] of WEEKDAYS) for (const match of text.matchAll(pattern)) {
    if (overlaps(match)) continue;
    const target = index(match);
    if (target >= 0) { const ms = sessionDay - ((weekday - target + 7) % 7) * DAY_MS; push(ms, ms); }
  }
  for (const match of text.matchAll(CJK_RELATIVE)) {
    if (overlaps(match)) continue;
    const amount = cjkNumber(match[1]!), unit = match[2] === "天" ? "day" : match[2] === "周" ? "week" : match[2] === "年" ? "year" : "month";
    if (amount !== null) { const window = resolveRelativeTemporalWindow({ kind: "offset", unit, amount: -amount }, sessionDay); push(window.startMs, window.endMs); }
  }
  return out;
}

/** Most specific Chinese calendar and relative-week spans first, so a day is not eaten by its month or week. */
function takeChineseSpecificity(
  text: string, sessionDay: number,
  overlaps: (match: RegExpMatchArray) => boolean, consume: (match: RegExpMatchArray) => void,
  push: (startMs: number, endMs: number) => void
): void {
  const take = (pattern: RegExp, bind: (match: RegExpMatchArray) => void) => {
    for (const match of text.matchAll(pattern)) {
      if (overlaps(match)) continue;
      consume(match);
      bind(match);
    }
  };
  take(/(\d{4})年(\d{1,2})月(\d{1,2})[日号]/gu, match => {
    const ms = validDay(+match[1]!, +match[2]! - 1, +match[3]!);
    if (ms !== null) push(ms, ms);
  });
  take(/(\d{4})年(\d{1,2})月/gu, match => {
    const month = +match[2]!;
    if (month >= 1 && month <= 12) push(Date.UTC(+match[1]!, month - 1, 1), Date.UTC(+match[1]!, month, 0));
  });
  take(/(\d{4})年/gu, match => { push(Date.UTC(+match[1]!, 0, 1), Date.UTC(+match[1]!, 11, 31)); });
  take(/(上|下|这)(周|星期|礼拜)([日天一二三四五六])/gu, match => {
    const weekday = (["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const)[
      "日一二三四五六".indexOf(match[3] === "天" ? "日" : match[3]!)
    ];
    if (weekday === undefined) return;
    const weekOffset = match[1] === "上" ? -1 : match[1] === "下" ? 1 : 0;
    const window = resolveRelativeTemporalWindow({ kind: "weekday", weekday, weekOffset }, sessionDay);
    push(window.startMs, window.endMs);
  });
  take(/(上|下|这)周/gu, match => {
    const amount = match[1] === "上" ? -1 : match[1] === "下" ? 1 : 0;
    const window = resolveRelativeTemporalWindow({ kind: "offset", unit: "week", amount }, sessionDay);
    push(window.startMs, window.endMs);
  });
}
