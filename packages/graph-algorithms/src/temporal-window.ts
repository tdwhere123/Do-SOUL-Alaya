type RelativeTemporalUnit = "day" | "week" | "month" | "year";
type SeasonName = "spring" | "summer" | "autumn" | "fall" | "winter";
export type RelativeWeekday =
  | "monday" | "tuesday" | "wednesday" | "thursday"
  | "friday" | "saturday" | "sunday";

export type RelativeTemporalTerm =
  | { readonly kind: "offset"; readonly unit: RelativeTemporalUnit; readonly amount: number }
  | { readonly kind: "season"; readonly season: SeasonName; readonly yearOffset: number }
  | { readonly kind: "weekday"; readonly weekday: RelativeWeekday; readonly weekOffset: number };

export interface TemporalWindow {
  readonly startMs: number;
  readonly endMs: number;
  readonly precision: "day" | "month" | "year" | "range";
}

const DAY_MS = 86_400_000;

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12
};

const WEEKDAY_INDEX: Readonly<Record<RelativeWeekday, number>> = {
  monday: 0, tuesday: 1, wednesday: 2, thursday: 3,
  friday: 4, saturday: 5, sunday: 6
};

const SEASON_START_MONTH0: Readonly<Record<SeasonName, number>> = {
  spring: 2,
  summer: 5,
  autumn: 8,
  fall: 8,
  winter: 11
};

const FIXED_RELATIVE_TERMS: ReadonlyMap<string, RelativeTemporalTerm> = new Map([
  ["today", dayOffset(0)], ["今天", dayOffset(0)],
  ["yesterday", dayOffset(-1)], ["昨天", dayOffset(-1)],
  ["tomorrow", dayOffset(1)], ["明天", dayOffset(1)],
  ["tonight", dayOffset(0)], ["今晚", dayOffset(0)],
  ["this week", unitOffset("week", 0)],
  ["last week", unitOffset("week", -1)], ["上周", unitOffset("week", -1)],
  ["next week", unitOffset("week", 1)], ["下周", unitOffset("week", 1)],
  ["this month", unitOffset("month", 0)],
  ["last month", unitOffset("month", -1)], ["上个月", unitOffset("month", -1)],
  ["next month", unitOffset("month", 1)], ["下个月", unitOffset("month", 1)],
  ["this year", unitOffset("year", 0)], ["今年", unitOffset("year", 0)],
  ["last year", unitOffset("year", -1)], ["去年", unitOffset("year", -1)],
  ["next year", unitOffset("year", 1)], ["明年", unitOffset("year", 1)]
]);

export function parseRelativeTemporalTerm(raw: string): RelativeTemporalTerm | null {
  const normalized = raw.trim().replace(/\s+/gu, " ").toLowerCase();
  return FIXED_RELATIVE_TERMS.get(normalized)
    ?? parseAgoTerm(normalized)
    ?? parseSeasonTerm(normalized)
    ?? parseWeekdayTerm(normalized);
}

export function resolveRelativeTemporalWindow(
  term: RelativeTemporalTerm,
  anchorMs: number,
  offsetMinutes = 0
): TemporalWindow {
  if (term.kind === "season") {
    return seasonWindow(term.season, anchorMs, term.yearOffset, offsetMinutes);
  }
  if (term.kind === "weekday") {
    return weekdayWindow(term.weekday, anchorMs, term.weekOffset, offsetMinutes);
  }
  switch (term.unit) {
    case "day":
      return dayOffsetWindow(anchorMs, term.amount, offsetMinutes);
    case "week":
      return weekOffsetWindow(anchorMs, term.amount, offsetMinutes);
    case "month":
      return monthOffsetWindow(anchorMs, term.amount, offsetMinutes);
    case "year":
      return yearOffsetWindow(anchorMs, term.amount, offsetMinutes);
  }
}

function parseAgoTerm(normalized: string): RelativeTemporalTerm | null {
  const match =
    /^(\d{1,3}|[a-z]+) (days?|weeks?|months?|years?) ago$/u.exec(normalized) ??
    /^(\d{1,3})(天|周|个月|年)前$/u.exec(normalized);
  if (match === null) {
    return null;
  }
  const unit = agoUnit(match[2]!);
  const amount = parseRelativeCount(match[1]!);
  return unit === null || amount === null ? null : unitOffset(unit, -amount);
}

function parseRelativeCount(token: string): number | null {
  if (/^\d{1,3}$/u.test(token)) {
    return Number(token);
  }
  return NUMBER_WORDS[token] ?? null;
}

function agoUnit(token: string): RelativeTemporalUnit | null {
  if (token === "天" || token.startsWith("day")) return "day";
  if (token === "周" || token.startsWith("week")) return "week";
  if (token === "个月" || token.startsWith("month")) return "month";
  if (token === "年" || token.startsWith("year")) return "year";
  return null;
}

function parseSeasonTerm(normalized: string): RelativeTemporalTerm | null {
  const match = /^(last|this|next) (spring|summer|autumn|fall|winter)$/u.exec(normalized);
  if (match === null) {
    return null;
  }
  const yearOffset = match[1] === "last" ? -1 : match[1] === "next" ? 1 : 0;
  return { kind: "season", season: match[2] as SeasonName, yearOffset };
}

function parseWeekdayTerm(normalized: string): RelativeTemporalTerm | null {
  const match = /^(last|this|next) (monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/u
    .exec(normalized);
  if (match === null) return null;
  return {
    kind: "weekday",
    weekday: match[2] as RelativeWeekday,
    weekOffset: match[1] === "last" ? -1 : match[1] === "next" ? 1 : 0
  };
}

function dayOffsetWindow(anchorMs: number, amount: number, offsetMinutes: number): TemporalWindow {
  const date = civilDate(anchorMs, offsetMinutes);
  const startMs = civilMidnightMs(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + amount, offsetMinutes);
  return { startMs, endMs: startMs + DAY_MS - 1, precision: "day" };
}

function weekOffsetWindow(anchorMs: number, amount: number, offsetMinutes: number): TemporalWindow {
  const date = civilDate(anchorMs, offsetMinutes);
  const dayStartMs = civilMidnightMs(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), offsetMinutes);
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  const startMs = dayStartMs - daysSinceMonday * DAY_MS + amount * 7 * DAY_MS;
  return { startMs, endMs: startMs + 7 * DAY_MS - 1, precision: "range" };
}

function weekdayWindow(
  weekday: RelativeWeekday,
  anchorMs: number,
  weekOffset: number,
  offsetMinutes: number
): TemporalWindow {
  const date = civilDate(anchorMs, offsetMinutes);
  const dayStartMs = civilMidnightMs(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), offsetMinutes);
  const anchorWeekday = (date.getUTCDay() + 6) % 7;
  const targetWeekday = WEEKDAY_INDEX[weekday];
  const dayOffset = weekOffset === 0
    ? targetWeekday - anchorWeekday
    : weekOffset < 0
      ? -(((anchorWeekday - targetWeekday + 6) % 7) + 1)
      : ((targetWeekday - anchorWeekday + 6) % 7) + 1;
  const startMs = dayStartMs + dayOffset * DAY_MS;
  return { startMs, endMs: startMs + DAY_MS - 1, precision: "day" };
}

function monthOffsetWindow(anchorMs: number, amount: number, offsetMinutes: number): TemporalWindow {
  const date = civilDate(anchorMs, offsetMinutes);
  const startMs = civilMidnightMs(date.getUTCFullYear(), date.getUTCMonth() + amount, 1, offsetMinutes);
  const endMs = civilMidnightMs(date.getUTCFullYear(), date.getUTCMonth() + amount + 1, 1, offsetMinutes) - 1;
  return { startMs, endMs, precision: "month" };
}

function yearOffsetWindow(anchorMs: number, amount: number, offsetMinutes: number): TemporalWindow {
  const year = civilDate(anchorMs, offsetMinutes).getUTCFullYear() + amount;
  return {
    startMs: civilMidnightMs(year, 0, 1, offsetMinutes),
    endMs: civilMidnightMs(year + 1, 0, 1, offsetMinutes) - 1,
    precision: "year"
  };
}

function seasonWindow(
  season: SeasonName,
  anchorMs: number,
  yearOffset: number,
  offsetMinutes: number
): TemporalWindow {
  const anchor = civilDate(anchorMs, offsetMinutes);
  const winterAdjustment = season === "winter" && anchor.getUTCMonth() < 2 ? -1 : 0;
  const seasonYear = anchor.getUTCFullYear() + winterAdjustment + yearOffset;
  const startMonth0 = SEASON_START_MONTH0[season];
  const startMs = civilMidnightMs(seasonYear, startMonth0, 1, offsetMinutes);
  const endMs = civilMidnightMs(seasonYear, startMonth0 + 3, 1, offsetMinutes) - 1;
  return { startMs, endMs, precision: "range" };
}

function civilDate(anchorMs: number, offsetMinutes: number): Date {
  return new Date(anchorMs + offsetMinutes * 60_000);
}

function civilMidnightMs(year: number, month0: number, day: number, offsetMinutes: number): number {
  return Date.UTC(year, month0, day) - offsetMinutes * 60_000;
}

function dayOffset(amount: number): RelativeTemporalTerm {
  return { kind: "offset", unit: "day", amount };
}

function unitOffset(unit: RelativeTemporalUnit, amount: number): RelativeTemporalTerm {
  return { kind: "offset", unit, amount };
}
