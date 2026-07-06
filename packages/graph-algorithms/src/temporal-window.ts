type RelativeTemporalUnit = "day" | "week" | "month" | "year";
type SeasonName = "spring" | "summer" | "autumn" | "fall" | "winter";

export type RelativeTemporalTerm =
  | { readonly kind: "offset"; readonly unit: RelativeTemporalUnit; readonly amount: number }
  | { readonly kind: "season"; readonly season: SeasonName; readonly yearOffset: number };

export interface TemporalWindow {
  readonly startMs: number;
  readonly endMs: number;
  readonly precision: "day" | "month" | "year" | "range";
}

const DAY_MS = 86_400_000;

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
  return FIXED_RELATIVE_TERMS.get(normalized) ?? parseAgoTerm(normalized) ?? parseSeasonTerm(normalized);
}

export function resolveRelativeTemporalWindow(term: RelativeTemporalTerm, anchorMs: number): TemporalWindow {
  if (term.kind === "season") {
    return seasonWindow(term.season, anchorMs, term.yearOffset);
  }
  switch (term.unit) {
    case "day":
      return dayOffsetWindow(anchorMs, term.amount);
    case "week":
      return weekOffsetWindow(anchorMs, term.amount);
    case "month":
      return monthOffsetWindow(anchorMs, term.amount);
    case "year":
      return yearOffsetWindow(anchorMs, term.amount);
  }
}

function parseAgoTerm(normalized: string): RelativeTemporalTerm | null {
  const match =
    /^(\d{1,3}) (days?|weeks?|months?|years?) ago$/u.exec(normalized) ??
    /^(\d{1,3})(天|周|个月|年)前$/u.exec(normalized);
  if (match === null) {
    return null;
  }
  const unit = agoUnit(match[2]!);
  return unit === null ? null : unitOffset(unit, -Number(match[1]));
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

function dayOffsetWindow(anchorMs: number, amount: number): TemporalWindow {
  const date = new Date(anchorMs);
  const startMs = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + amount);
  return { startMs, endMs: startMs + DAY_MS - 1, precision: "day" };
}

function weekOffsetWindow(anchorMs: number, amount: number): TemporalWindow {
  const date = new Date(anchorMs);
  const dayStartMs = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  const startMs = dayStartMs - daysSinceMonday * DAY_MS + amount * 7 * DAY_MS;
  return { startMs, endMs: startMs + 7 * DAY_MS - 1, precision: "range" };
}

function monthOffsetWindow(anchorMs: number, amount: number): TemporalWindow {
  const date = new Date(anchorMs);
  const startMs = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + amount, 1);
  const endMs = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + amount + 1, 1) - 1;
  return { startMs, endMs, precision: "month" };
}

function yearOffsetWindow(anchorMs: number, amount: number): TemporalWindow {
  const year = new Date(anchorMs).getUTCFullYear() + amount;
  return { startMs: Date.UTC(year, 0, 1), endMs: Date.UTC(year + 1, 0, 1) - 1, precision: "year" };
}

function seasonWindow(season: SeasonName, anchorMs: number, yearOffset: number): TemporalWindow {
  const seasonYear = new Date(anchorMs).getUTCFullYear() + yearOffset;
  const startMonth0 = SEASON_START_MONTH0[season];
  const startMs = Date.UTC(seasonYear, startMonth0, 1);
  const endMs = Date.UTC(seasonYear, startMonth0 + 3, 1) - 1;
  return { startMs, endMs, precision: "range" };
}

function dayOffset(amount: number): RelativeTemporalTerm {
  return { kind: "offset", unit: "day", amount };
}

function unitOffset(unit: RelativeTemporalUnit, amount: number): RelativeTemporalTerm {
  return { kind: "offset", unit, amount };
}
