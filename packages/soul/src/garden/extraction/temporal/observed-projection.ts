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
const ROLE_CLAUSE_SEPARATOR =
  /(?:[;,.!?\n；，。！？]+|\b(?:and|but|while|whereas|then)\b|(?:并且|而|但|然后|同时))/giu;

export interface OfficialApiTemporalProjectionDraft {
  readonly event_time_start?: string;
  readonly event_time_end?: string;
  readonly valid_from?: string;
  readonly valid_to?: string;
  readonly time_precision: "day" | "month" | "year" | "range" | "relative" | "unknown";
  readonly time_source: "explicit" | "session_timestamp" | "relative_resolved";
  readonly projection_schema_version: 1;
}

export type OfficialApiTemporalProjectionAudit = Readonly<{
  readonly status: "formed" | "unavailable" | "rejected";
  readonly reason:
    | "temporal_projection_missing"
    | "temporal_projection_invalid"
    | "temporal_projection_parsed"
    | "source_event_time_derived"
    | "event_time_source_verified"
    | "valid_time_source_verified"
    | "dual_time_source_verified"
    | "temporal_projection_not_source_grounded"
    | "valid_time_role_not_source_grounded";
}>;

export interface OfficialApiTemporalProjectionInspection {
  readonly projection?: OfficialApiTemporalProjectionDraft;
  readonly audit: OfficialApiTemporalProjectionAudit;
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

export function inspectOfficialApiTemporalProjection(
  value: unknown
): OfficialApiTemporalProjectionInspection {
  if (value === undefined || value === null) {
    return temporalInspection(undefined, "unavailable", "temporal_projection_missing");
  }
  const projection = parseOfficialApiTemporalProjection(value);
  return projection === null
    ? temporalInspection(undefined, "rejected", "temporal_projection_invalid")
    : temporalInspection(projection, "formed", "temporal_projection_parsed");
}

export function selectObservedTemporalProjection(
  matchedText: string,
  extracted: OfficialApiTemporalProjectionDraft | undefined,
  sourceObservedAt: string | undefined
): OfficialApiTemporalProjectionDraft | undefined {
  return inspectObservedTemporalProjection(
    matchedText, extracted, sourceObservedAt
  ).projection;
}

export function inspectObservedTemporalProjection(
  matchedText: string,
  extracted: OfficialApiTemporalProjectionDraft | undefined,
  sourceObservedAt: string | undefined,
  parseAudit?: OfficialApiTemporalProjectionAudit
): OfficialApiTemporalProjectionInspection {
  const anchor = sourceTemporalAnchor(sourceObservedAt);
  const matches = sourceTemporalMatches(matchedText, anchor);
  const rangeMatch = sourceRangeMatch(matchedText, matches);
  const sourceProjection = rangeMatch?.projection ??
    (matches.length === 1 ? matches[0]!.projection : undefined);
  if (extracted === undefined) {
    if (parseAudit?.status === "rejected") {
      return temporalInspection(sourceProjection, "rejected", parseAudit.reason);
    }
    return sourceProjection === undefined
      ? temporalInspection(undefined, "unavailable", "temporal_projection_missing")
      : temporalInspection(sourceProjection, "formed", "source_event_time_derived");
  }
  const candidates = rangeMatch === undefined ? matches : [...matches, rangeMatch];
  const eventSource = candidates.find((candidate) =>
    verifiesEventProjection(extracted, candidate.projection)
  );
  const validSource = candidates.find((candidate) =>
    verifiesValidProjection(extracted, candidate, matchedText, matches)
  );
  const eventVerified = eventSource !== undefined;
  const validVerified = validSource !== undefined;
  if (hasValidProjection(extracted) && !validVerified) {
    return temporalInspection(
      eventSource?.projection ?? sourceProjection,
      "rejected",
      "valid_time_role_not_source_grounded"
    );
  }
  if (!eventVerified && !validVerified) {
    return temporalInspection(
      sourceProjection, "rejected", "temporal_projection_not_source_grounded"
    );
  }
  const projection = verifiedProjection(extracted, eventSource?.projection, validSource?.projection);
  return temporalInspection(
    projection,
    "formed",
    eventVerified && validVerified
      ? "dual_time_source_verified"
      : validVerified ? "valid_time_source_verified" : "event_time_source_verified"
  );
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

function sourceRangeMatch(
  source: string,
  matches: readonly SourceTemporalMatch[]
): SourceTemporalMatch | undefined {
  if (matches.length !== 2) return undefined;
  const [left, right] = matches;
  const connector = source.slice(left!.end, right!.start);
  if (!/^\s*(?:to|through|until|[-–—]|至|到)\s*$/iu.test(connector)) return undefined;
  const start = left!.projection.event_time_start;
  const end = right!.projection.event_time_end;
  if (start === undefined || end === undefined || Date.parse(start) > Date.parse(end)) return undefined;
  return Object.freeze({
    start: left!.start,
    end: right!.end,
    projection: Object.freeze({
      projection_schema_version: 1,
      event_time_start: start,
      event_time_end: end,
      time_precision: "range",
      time_source: left!.projection.time_source === "explicit" &&
        right!.projection.time_source === "explicit" ? "explicit" : "relative_resolved"
    })
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
  const validForm = dates.valid_from !== undefined;
  const partialEvent = (dates.event_time_start === undefined) !== (dates.event_time_end === undefined);
  const invalidOpenEnd = dates.valid_from === undefined && dates.valid_to !== undefined;
  return !partialEvent && !invalidOpenEnd && (eventPair || validForm);
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

function verifiesEventProjection(
  extracted: OfficialApiTemporalProjectionDraft,
  source: OfficialApiTemporalProjectionDraft
): boolean {
  if (extracted.event_time_start === undefined || extracted.event_time_end === undefined) {
    return false;
  }
  return extracted.event_time_start === source.event_time_start &&
    verifiesSourceEnd(extracted.event_time_end, source.event_time_end);
}

function verifiesValidProjection(
  extracted: OfficialApiTemporalProjectionDraft,
  source: SourceTemporalMatch,
  matchedText: string,
  matches: readonly SourceTemporalMatch[]
): boolean {
  if (!hasValidProjection(extracted) || extracted.valid_from !== source.projection.event_time_start) {
    return false;
  }
  if (extracted.valid_to !== undefined &&
      !verifiesSourceEnd(extracted.valid_to, source.projection.event_time_end)) {
    return false;
  }
  return hasValidityCue(
    sourceRoleWindow(matchedText, source, matches),
    extracted.valid_to !== undefined
  );
}

function verifiesSourceEnd(nominated: string, sourceEnd: string | undefined): boolean {
  if (sourceEnd === undefined) return false;
  if (nominated === sourceEnd) return true;
  return nominated.endsWith("T00:00:00.000Z") &&
    nominated.slice(0, 10) === sourceEnd.slice(0, 10);
}

function sourceRoleWindow(
  source: string,
  candidate: SourceTemporalMatch,
  matches: readonly SourceTemporalMatch[]
): string {
  const previous = [...matches]
    .filter((match) => match.end <= candidate.start)
    .sort((left, right) => right.end - left.end)[0];
  const next = matches
    .filter((match) => match.start >= candidate.end)
    .sort((left, right) => left.start - right.start)[0];
  // A role word may sit on either side of its date, but it must not cross the
  // clause boundary that separates this date from a neighboring date.
  const start = previous === undefined
    ? Math.max(0, candidate.start - 96)
    : clauseStartAfter(source, previous.end, candidate.start);
  const end = next === undefined
    ? Math.min(source.length, candidate.end + 96)
    : clauseEndBefore(source, candidate.end, next.start);
  return source.slice(start, end);
}

function clauseStartAfter(source: string, start: number, end: number): number {
  const separators = [...source.slice(start, end).matchAll(ROLE_CLAUSE_SEPARATOR)];
  const separator = separators[separators.length - 1];
  return separator === undefined
    ? end
    : start + (separator.index ?? 0) + separator[0].length;
}

function clauseEndBefore(source: string, start: number, end: number): number {
  const separator = source.slice(start, end).matchAll(ROLE_CLAUSE_SEPARATOR).next().value;
  return separator === undefined ? start : start + (separator.index ?? 0);
}

function hasValidProjection(projection: OfficialApiTemporalProjectionDraft): boolean {
  return projection.valid_from !== undefined;
}

function hasValidityCue(source: string, bounded: boolean): boolean {
  if (/\b(?:since|effective(?:\s+from|\s+on)?|valid\s+(?:from|since)|as\s+of|in\s+effect\s+since)\b/iu.test(source) ||
      /(?:生效|有效|适用).{0,48}(?:自|从|起)/u.test(source)) {
    return true;
  }
  return bounded && (
    /\b(?:effective|valid|in\s+effect|appl(?:y|ies))\b[\s\S]{0,96}\b(?:to|through|until)\b/iu.test(source) ||
    /(?:有效期|生效|适用).{0,96}(?:至|到|截至)/u.test(source)
  );
}

function verifiedProjection(
  extracted: OfficialApiTemporalProjectionDraft,
  eventSource: OfficialApiTemporalProjectionDraft | undefined,
  validSource: OfficialApiTemporalProjectionDraft | undefined
): OfficialApiTemporalProjectionDraft {
  const semanticSource = eventSource ?? validSource!;
  return Object.freeze({
    projection_schema_version: 1,
    ...(eventSource === undefined ? {} : {
      event_time_start: eventSource.event_time_start,
      event_time_end: eventSource.event_time_end
    }),
    ...(validSource === undefined ? {} : {
      valid_from: validSource.event_time_start,
      ...(extracted.valid_to === undefined ? {} : { valid_to: validSource.event_time_end })
    }),
    time_precision: semanticSource.time_precision,
    time_source: semanticSource.time_source
  });
}

function temporalInspection(
  projection: OfficialApiTemporalProjectionDraft | undefined,
  status: OfficialApiTemporalProjectionAudit["status"],
  reason: OfficialApiTemporalProjectionAudit["reason"]
): OfficialApiTemporalProjectionInspection {
  return Object.freeze({
    ...(projection === undefined ? {} : { projection }),
    audit: Object.freeze({ status, reason })
  });
}
