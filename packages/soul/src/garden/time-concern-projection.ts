import {
  parseRelativeTemporalTerm,
  resolveRelativeTemporalWindow,
  type TemporalWindow
} from "../shared/temporal-window.js";
import { parseStrictCalendarDateToUtcDay } from "./temporal-date.js";

export interface TemporalProjection {
  readonly event_time_start: string;
  readonly event_time_end: string;
  readonly time_precision: "day" | "month" | "year" | "range" | "relative" | "unknown";
  readonly time_source: "explicit" | "session_timestamp" | "relative_resolved";
  readonly projection_schema_version: 1;
}

const DAY_MS = 86_400_000;

export function normalizeWindowDigest(matchedText: string): string {
  return matchedText.trim().toLowerCase().replace(/\s+/gu, "_");
}

const TIME_CONCERN_PATTERN =
  /\b(?:today|yesterday|tomorrow|tonight|(?:last|this|next)\s+(?:week|month|year|spring|summer|autumn|fall|winter|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|(?:\d{1,3}|a|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:days?|weeks?|months?|years?)\s+ago|(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+(?:\d{1,2}(?:st|nd|rd|th)?(?:,\s*|\s+)\d{4}|\d{4})|\d{1,2}(?:st|nd|rd|th)?\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4}|\d{4}-\d{2}(?:-\d{2})?)\b|(?:今天|昨天|明天|今晚|上周|上个月|去年|下周|下个月|明年|今年|\d{1,3}(?:天|周|个月|年)前|\d{4}年\d{1,2}月(?:\d{1,2}日)?|\d{4}-\d{2}(?:-\d{2})?)/giu;

export function timeConcernPattern(): RegExp {
  return new RegExp(TIME_CONCERN_PATTERN.source, TIME_CONCERN_PATTERN.flags);
}

export function resolveTemporalProjection(matchedText: string, anchorIso: string): TemporalProjection | null {
  const anchor = new Date(anchorIso);
  if (Number.isNaN(anchor.getTime())) {
    return null;
  }
  const offsetMinutes = parseFixedOffsetMinutes(anchorIso) ?? 0;
  const term = parseRelativeTemporalTerm(normalizeRelativeArticle(matchedText));
  if (term !== null) {
    return projectionFromWindow(
      resolveRelativeTemporalWindow(term, anchor.getTime(), offsetMinutes),
      "relative_resolved"
    );
  }
  const normalized = normalizeWindowDigest(matchedText);
  const month = resolveAbsoluteMonthProjection(normalized);
  if (month !== null) return month;
  const explicit = parseEnglishCalendarDate(matchedText) ?? parseStrictCalendarDateToUtcDay(normalized);
  return explicit === null ? null : explicitDayProjection(explicit);
}

function parseFixedOffsetMinutes(value: string): number | null {
  if (/z$/iu.test(value)) return 0;
  const match = /([+-])(\d{2}):(\d{2})$/u.exec(value);
  if (match === null) return null;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (hours > 23 || minutes > 59) return null;
  const total = hours * 60 + minutes;
  return match[1] === "-" ? -total : total;
}

function normalizeRelativeArticle(value: string): string {
  const normalized = value.trim();
  if (/^(?:tonight|今晚)$/iu.test(normalized)) return /今晚/u.test(normalized) ? "今天" : "today";
  return normalized.replace(/^a\s+(?=(?:day|week|month|year)s?\s+ago$)/iu, "one ");
}

function resolveAbsoluteMonthProjection(normalized: string): TemporalProjection | null {
  const iso = /^(\d{4})-(\d{2})$/u.exec(normalized);
  if (iso !== null) {
    return absoluteMonthProjection(Number(iso[1]), Number(iso[2]));
  }
  const cjk = /^(\d{4})年(\d{1,2})月$/u.exec(normalized);
  if (cjk !== null) {
    return absoluteMonthProjection(Number(cjk[1]), Number(cjk[2]));
  }
  const english = /^([a-z]+)_(\d{4})$/u.exec(normalized);
  const englishMonth = english === null ? undefined : ENGLISH_MONTHS[english[1] ?? ""];
  if (english !== null && englishMonth !== undefined) {
    return absoluteMonthProjection(Number(english[2]), englishMonth + 1);
  }
  return null;
}

function absoluteMonthProjection(year: number, month: number): TemporalProjection | null {
  if (month < 1 || month > 12) {
    return null;
  }
  const startMs = Date.UTC(year, month - 1, 1);
  return projection(startMs, Date.UTC(year, month, 1) - 1, "month", "explicit");
}

function parseEnglishCalendarDate(value: string): Date | null {
  const normalized = value.trim().toLowerCase().replace(/(\d)(?:st|nd|rd|th)\b/gu, "$1");
  const monthFirst = /^(\w+)\s+(\d{1,2})(?:,\s*|\s+)(\d{4})$/u.exec(normalized);
  const dayFirst = /^(\d{1,2})\s+(\w+)\s+(\d{4})$/u.exec(normalized);
  const parts = monthFirst === null
    ? dayFirst === null ? null : [dayFirst[3], dayFirst[2], dayFirst[1]]
    : [monthFirst[3], monthFirst[1], monthFirst[2]];
  if (parts === null) return null;
  const month = ENGLISH_MONTHS[parts[1] ?? ""];
  if (month === undefined) return null;
  const year = Number(parts[0]);
  const day = Number(parts[2]);
  const date = new Date(Date.UTC(year, month, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month && date.getUTCDate() === day
    ? date
    : null;
}

const ENGLISH_MONTHS: Readonly<Record<string, number>> = Object.freeze({
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11
});

function explicitDayProjection(date: Date): TemporalProjection {
  const startMs = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return projection(startMs, startMs + DAY_MS - 1, "day", "explicit");
}

function projectionFromWindow(
  window: TemporalWindow,
  timeSource: TemporalProjection["time_source"]
): TemporalProjection {
  return projection(window.startMs, window.endMs, window.precision, timeSource);
}

function projection(
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
