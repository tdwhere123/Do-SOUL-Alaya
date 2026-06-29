import { parseStrictCalendarDateToUtcDay } from "./temporal-date.js";

export interface TemporalProjection {
  readonly event_time_start: string;
  readonly event_time_end: string;
  readonly time_precision: "day" | "month" | "year" | "range" | "relative" | "unknown";
  readonly time_source: "explicit" | "session_timestamp" | "relative_resolved";
  readonly projection_schema_version: 1;
}

const DAY_MS = 86_400_000;

function eventTimeExtractEnabled(): boolean {
  return /^(?:1|true|on|yes)$/iu.test(process.env.ALAYA_RECALL_EVENT_TIME_EXTRACT ?? "");
}

export function normalizeWindowDigest(matchedText: string): string {
  return matchedText.trim().toLowerCase().replace(/\s+/gu, "_");
}

const BASE_TIME_CONCERN_PATTERN =
  /\b(?:today|yesterday|tomorrow|tonight|last\s+(?:week|month|year)|next\s+(?:week|month|year)|this\s+(?:week|month|year)|\d{4}-\d{2}(?:-\d{2})?)\b|(?:今天|昨天|明天|今晚|上周|上个月|去年|下周|下个月|明年|今年|\d{4}年\d{1,2}月(?:\d{1,2}日)?|\d{4}-\d{2}(?:-\d{2})?)/giu;

// Superset: adds seasons and "N units ago" so the widened resolver can project them.
const WIDENED_TIME_CONCERN_PATTERN =
  /\b(?:today|yesterday|tomorrow|tonight|last\s+(?:week|month|year)|next\s+(?:week|month|year)|this\s+(?:week|month|year)|(?:last|this|next)\s+(?:spring|summer|autumn|fall|winter)|\d{1,3}\s+(?:days?|weeks?|months?|years?)\s+ago|\d{4}-\d{2}(?:-\d{2})?)\b|(?:今天|昨天|明天|今晚|上周|上个月|去年|下周|下个月|明年|今年|\d{1,3}(?:天|周|个月|年)前|\d{4}年\d{1,2}月(?:\d{1,2}日)?|\d{4}-\d{2}(?:-\d{2})?)/giu;

export function timeConcernPattern(): RegExp {
  return eventTimeExtractEnabled() ? WIDENED_TIME_CONCERN_PATTERN : BASE_TIME_CONCERN_PATTERN;
}

// Flag-off: base day/explicit resolutions only (byte-equivalent). Flag-on: widened ranges take precedence, base as fallback.
export function resolveTemporalProjection(matchedText: string, anchorIso: string): TemporalProjection | null {
  const anchor = new Date(anchorIso);
  if (Number.isNaN(anchor.getTime())) {
    return null;
  }
  const normalized = normalizeWindowDigest(matchedText);
  const base = resolveBaseProjection(normalized, anchor);
  if (!eventTimeExtractEnabled()) {
    return base;
  }
  return resolveWidenedProjection(normalized, anchor) ?? base;
}

function resolveBaseProjection(normalized: string, anchor: Date): TemporalProjection | null {
  if (normalized === "yesterday" || normalized === "昨天") {
    return buildDayProjection(addUtcDays(anchor, -1), "relative_resolved");
  }
  if (normalized === "today" || normalized === "今天") {
    return buildDayProjection(anchor, "relative_resolved");
  }
  if (normalized === "tomorrow" || normalized === "明天") {
    return buildDayProjection(addUtcDays(anchor, 1), "relative_resolved");
  }
  const explicit = parseStrictCalendarDateToUtcDay(normalized);
  return explicit === null ? null : buildDayProjection(explicit, "explicit");
}

function resolveWidenedProjection(normalized: string, anchor: Date): TemporalProjection | null {
  return (
    resolveOffsetProjection(normalized, anchor) ??
    resolveAgoProjection(normalized, anchor) ??
    resolveSeasonProjection(normalized, anchor) ??
    resolveAbsoluteMonthProjection(normalized)
  );
}

const WEEK_OFFSETS = new Map<string, number>([
  ["this_week", 0], ["last_week", -1], ["next_week", 1], ["上周", -1], ["下周", 1]
]);
const MONTH_OFFSETS = new Map<string, number>([
  ["this_month", 0], ["last_month", -1], ["next_month", 1], ["上个月", -1], ["下个月", 1]
]);
const YEAR_OFFSETS = new Map<string, number>([
  ["this_year", 0], ["last_year", -1], ["next_year", 1], ["今年", 0], ["去年", -1], ["明年", 1]
]);

function resolveOffsetProjection(normalized: string, anchor: Date): TemporalProjection | null {
  const weekOffset = WEEK_OFFSETS.get(normalized);
  if (weekOffset !== undefined) {
    return buildWeekProjection(anchor, weekOffset);
  }
  const monthOffset = MONTH_OFFSETS.get(normalized);
  if (monthOffset !== undefined) {
    return buildMonthProjection(anchor.getUTCFullYear(), anchor.getUTCMonth() + monthOffset, "relative_resolved");
  }
  const yearOffset = YEAR_OFFSETS.get(normalized);
  if (yearOffset !== undefined) {
    return buildYearProjection(anchor.getUTCFullYear() + yearOffset, "relative_resolved");
  }
  return null;
}

type AgoUnit = "day" | "week" | "month" | "year";

function resolveAgoProjection(normalized: string, anchor: Date): TemporalProjection | null {
  const match =
    /^(\d{1,3})_(days?|weeks?|months?|years?)_ago$/u.exec(normalized) ??
    /^(\d{1,3})(天|周|个月|年)前$/u.exec(normalized);
  if (match === null) {
    return null;
  }
  const unit = agoUnit(match[2]!);
  if (unit === null) {
    return null;
  }
  const count = Number(match[1]);
  switch (unit) {
    case "day":
      return buildDayProjection(addUtcDays(anchor, -count), "relative_resolved");
    case "week":
      return buildWeekProjection(anchor, -count);
    case "month":
      return buildMonthProjection(anchor.getUTCFullYear(), anchor.getUTCMonth() - count, "relative_resolved");
    case "year":
      return buildYearProjection(anchor.getUTCFullYear() - count, "relative_resolved");
  }
}

function agoUnit(token: string): AgoUnit | null {
  if (token === "天" || token.startsWith("day")) return "day";
  if (token === "周" || token.startsWith("week")) return "week";
  if (token === "个月" || token.startsWith("month")) return "month";
  if (token === "年" || token.startsWith("year")) return "year";
  return null;
}

// Northern-hemisphere seasons keyed by their first month; season-year = year of that first month, shifted by last/this/next.
const SEASON_START_MONTH0: Readonly<Record<string, number>> = {
  spring: 2, summer: 5, autumn: 8, fall: 8, winter: 11
};

function resolveSeasonProjection(normalized: string, anchor: Date): TemporalProjection | null {
  const match = /^(last|this|next)_(spring|summer|autumn|fall|winter)$/u.exec(normalized);
  if (match === null) {
    return null;
  }
  const yearOffset = match[1] === "last" ? -1 : match[1] === "next" ? 1 : 0;
  const seasonYear = anchor.getUTCFullYear() + yearOffset;
  const startMonth0 = SEASON_START_MONTH0[match[2]!]!;
  const startMs = Date.UTC(seasonYear, startMonth0, 1);
  const endMs = Date.UTC(seasonYear, startMonth0 + 3, 1) - 1;
  return rangeProjection(startMs, endMs, "range", "relative_resolved");
}

function resolveAbsoluteMonthProjection(normalized: string): TemporalProjection | null {
  const iso = /^(\d{4})-(\d{2})$/u.exec(normalized);
  if (iso !== null) {
    return buildAbsoluteMonth(Number(iso[1]), Number(iso[2]));
  }
  const cjk = /^(\d{4})年(\d{1,2})月$/u.exec(normalized);
  if (cjk !== null) {
    return buildAbsoluteMonth(Number(cjk[1]), Number(cjk[2]));
  }
  return null;
}

function buildAbsoluteMonth(year: number, month: number): TemporalProjection | null {
  if (month < 1 || month > 12) {
    return null;
  }
  return buildMonthProjection(year, month - 1, "explicit");
}

function buildDayProjection(date: Date, timeSource: TemporalProjection["time_source"]): TemporalProjection {
  const startMs = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return rangeProjection(startMs, startMs + DAY_MS - 1, "day", timeSource);
}

function buildWeekProjection(anchor: Date, weekOffset: number): TemporalProjection {
  const dayStartMs = Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate());
  const daysSinceMonday = (anchor.getUTCDay() + 6) % 7;
  const startMs = dayStartMs - daysSinceMonday * DAY_MS + weekOffset * 7 * DAY_MS;
  return rangeProjection(startMs, startMs + 7 * DAY_MS - 1, "range", "relative_resolved");
}

function buildMonthProjection(
  year: number,
  month0: number,
  timeSource: TemporalProjection["time_source"]
): TemporalProjection {
  const startMs = Date.UTC(year, month0, 1);
  return rangeProjection(startMs, Date.UTC(year, month0 + 1, 1) - 1, "month", timeSource);
}

function buildYearProjection(year: number, timeSource: TemporalProjection["time_source"]): TemporalProjection {
  return rangeProjection(Date.UTC(year, 0, 1), Date.UTC(year + 1, 0, 1) - 1, "year", timeSource);
}

function rangeProjection(
  startMs: number,
  endMs: number,
  timePrecision: TemporalProjection["time_precision"],
  timeSource: TemporalProjection["time_source"]
): TemporalProjection {
  return {
    event_time_start: new Date(startMs).toISOString(),
    event_time_end: new Date(endMs).toISOString(),
    time_precision: timePrecision,
    time_source: timeSource,
    projection_schema_version: 1
  };
}

function addUtcDays(anchor: Date, deltaDays: number): Date {
  return new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate() + deltaDays));
}
