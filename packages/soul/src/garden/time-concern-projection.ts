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

// Flag-off: base same-day/explicit resolutions only (byte-equivalent). Flag-on: widened ranges win, base as fallback.
export function resolveTemporalProjection(matchedText: string, anchorIso: string): TemporalProjection | null {
  const anchor = new Date(anchorIso);
  if (Number.isNaN(anchor.getTime())) {
    return null;
  }
  const base = resolveBaseProjection(matchedText, anchor);
  if (!eventTimeExtractEnabled()) {
    return base;
  }
  return resolveWidenedProjection(matchedText, anchor) ?? base;
}

function resolveBaseProjection(matchedText: string, anchor: Date): TemporalProjection | null {
  const term = parseRelativeTemporalTerm(matchedText);
  if (term !== null && term.kind === "offset" && term.unit === "day") {
    return projectionFromWindow(resolveRelativeTemporalWindow(term, anchor.getTime()), "relative_resolved");
  }
  const explicit = parseStrictCalendarDateToUtcDay(normalizeWindowDigest(matchedText));
  return explicit === null ? null : explicitDayProjection(explicit);
}

function resolveWidenedProjection(matchedText: string, anchor: Date): TemporalProjection | null {
  const term = parseRelativeTemporalTerm(matchedText);
  if (term !== null) {
    return projectionFromWindow(resolveRelativeTemporalWindow(term, anchor.getTime()), "relative_resolved");
  }
  return resolveAbsoluteMonthProjection(normalizeWindowDigest(matchedText));
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
  return null;
}

function absoluteMonthProjection(year: number, month: number): TemporalProjection | null {
  if (month < 1 || month > 12) {
    return null;
  }
  const startMs = Date.UTC(year, month - 1, 1);
  return projection(startMs, Date.UTC(year, month, 1) - 1, "month", "explicit");
}

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
