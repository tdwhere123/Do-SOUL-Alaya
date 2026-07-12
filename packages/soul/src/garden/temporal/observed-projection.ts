import { normalizeTemporalIsoString } from "../temporal-date.js";
import {
  resolveTemporalProjection,
  timeConcernPattern
} from "../time-concern-projection.js";

const TIME_PRECISIONS = new Set([
  "day", "month", "year", "range", "relative", "unknown"
]);
const TIME_SOURCES = new Set([
  "explicit", "session_timestamp", "relative_resolved"
]);

export interface OfficialApiTemporalProjectionDraft {
  readonly event_time_start?: string;
  readonly event_time_end?: string;
  readonly valid_from?: string;
  readonly valid_to?: string;
  readonly time_precision: "day" | "month" | "year" | "range" | "relative" | "unknown";
  readonly time_source: "explicit" | "session_timestamp" | "relative_resolved";
  readonly projection_schema_version: 1;
}

export function parseOfficialApiTemporalProjection(
  value: unknown
): OfficialApiTemporalProjectionDraft | null {
  if (!isRecord(value)) return null;
  const version = value.projection_schema_version ?? value.version;
  if ((version !== 1 && version !== "1") ||
      !isTimePrecision(value.time_precision) || !isTimeSource(value.time_source)) {
    return null;
  }
  const dates = parseProjectionDates(value);
  if (dates === null || !hasCompleteDatePair(dates) || !isChronological(dates)) return null;
  return Object.freeze({
    projection_schema_version: 1,
    ...dates,
    time_precision: value.time_precision,
    time_source: value.time_source
  });
}

export function selectObservedTemporalProjection(
  matchedText: string,
  _extracted: OfficialApiTemporalProjectionDraft | undefined,
  sourceObservedAt: string | undefined
): OfficialApiTemporalProjectionDraft | undefined {
  const anchor = sourceTemporalAnchor(sourceObservedAt);
  const matches = sourceTemporalMatches(matchedText, anchor);
  const range = sourceRangeProjection(matchedText, matches);
  if (range !== undefined) return range;
  return matches.length === 1 ? matches[0]!.projection : undefined;
}

function sourceTemporalAnchor(value: string | undefined): string | undefined {
  if (value === undefined || normalizeSourceObservedAt(value) === undefined) return undefined;
  return value.trim();
}

interface SourceTemporalMatch {
  readonly start: number;
  readonly end: number;
  readonly projection: OfficialApiTemporalProjectionDraft;
}

function sourceTemporalMatches(
  source: string,
  anchor: string | undefined
): readonly SourceTemporalMatch[] {
  const matches: SourceTemporalMatch[] = [];
  for (const match of source.matchAll(timeConcernPattern())) {
    const projection = resolveTemporalProjection(match[0], anchor ?? "1970-01-01T00:00:00.000Z");
    if (projection === null || (projection.time_source !== "explicit" && anchor === undefined)) continue;
    matches.push({
      start: match.index,
      end: match.index + match[0].length,
      projection
    });
  }
  return matches;
}

export function normalizeSourceObservedAt(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return normalizeTemporalIsoString(value) ?? undefined;
}

function sourceRangeProjection(
  source: string,
  matches: readonly SourceTemporalMatch[]
): OfficialApiTemporalProjectionDraft | undefined {
  if (matches.length !== 2) return undefined;
  const [left, right] = matches;
  const connector = source.slice(left!.end, right!.start);
  if (!/^\s*(?:to|through|until|[-–—]|至|到)\s*$/iu.test(connector)) return undefined;
  const start = left!.projection.event_time_start;
  const end = right!.projection.event_time_end;
  if (start === undefined || end === undefined || Date.parse(start) > Date.parse(end)) return undefined;
  return Object.freeze({
    projection_schema_version: 1,
    event_time_start: start,
    event_time_end: end,
    time_precision: "range",
    time_source: left!.projection.time_source === "explicit" &&
      right!.projection.time_source === "explicit" ? "explicit" : "relative_resolved"
  });
}

function parseProjectionDates(
  record: Readonly<Record<string, unknown>>
): Pick<OfficialApiTemporalProjectionDraft,
  "event_time_start" | "event_time_end" | "valid_from" | "valid_to"> | null {
  const output: Record<string, string> = {};
  for (const field of ["event_time_start", "event_time_end", "valid_from", "valid_to"] as const) {
    if (record[field] === undefined) continue;
    if (typeof record[field] !== "string") return null;
    const normalized = normalizeTemporalIsoString(record[field]);
    if (normalized === null) return null;
    output[field] = normalized;
  }
  return output;
}

function hasCompleteDatePair(dates: Readonly<Record<string, string>>): boolean {
  const eventPair = dates.event_time_start !== undefined && dates.event_time_end !== undefined;
  const validPair = dates.valid_from !== undefined && dates.valid_to !== undefined;
  const partialEvent = (dates.event_time_start === undefined) !== (dates.event_time_end === undefined);
  const partialValid = (dates.valid_from === undefined) !== (dates.valid_to === undefined);
  return !partialEvent && !partialValid && (eventPair || validPair);
}

function isChronological(dates: Readonly<Record<string, string>>): boolean {
  return isOrdered(dates.event_time_start, dates.event_time_end) &&
    isOrdered(dates.valid_from, dates.valid_to);
}

function isOrdered(start: string | undefined, end: string | undefined): boolean {
  return start === undefined || end === undefined || Date.parse(start) <= Date.parse(end);
}

function isTimePrecision(value: unknown): value is OfficialApiTemporalProjectionDraft["time_precision"] {
  return typeof value === "string" && TIME_PRECISIONS.has(value);
}

function isTimeSource(value: unknown): value is OfficialApiTemporalProjectionDraft["time_source"] {
  return typeof value === "string" && TIME_SOURCES.has(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
