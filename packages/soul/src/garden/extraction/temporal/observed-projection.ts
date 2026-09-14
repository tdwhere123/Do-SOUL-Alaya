import { normalizeTemporalIsoString } from "../temporal-date.js";
import { parseOfficialApiTemporalProjection, type OfficialApiTemporalProjectionDraft } from "./projection-draft.js";
import { resolveSourceTemporalCandidates, type SourceTemporalCandidate } from "./source-time.js";

export type OfficialApiTemporalProjectionAudit = Readonly<{
  readonly status: "formed" | "unavailable" | "rejected";
  readonly reason:
    | "temporal_projection_missing"
    | "temporal_projection_invalid"
    | "temporal_projection_parsed"
    | "source_event_time_derived"
    | "source_valid_time_derived"
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

export function inspectOfficialApiTemporalProjection(value: unknown): OfficialApiTemporalProjectionInspection {
  if (value === undefined || value === null) {
    return temporalInspection(undefined, "unavailable", "temporal_projection_missing");
  }
  const projection = parseOfficialApiTemporalProjection(value);
  return projection === null ? temporalInspection(undefined, "rejected", "temporal_projection_invalid")
    : temporalInspection(projection, "formed", "temporal_projection_parsed");
}

export function selectObservedTemporalProjection(
  matchedText: string,
  extracted: OfficialApiTemporalProjectionDraft | undefined,
  sourceObservedAt: string | undefined
): OfficialApiTemporalProjectionDraft | undefined {
  return inspectObservedTemporalProjection(matchedText, extracted, sourceObservedAt).projection;
}

export function inspectObservedTemporalProjection(
  matchedText: string,
  extracted: OfficialApiTemporalProjectionDraft | undefined,
  sourceObservedAt: string | undefined,
  parseAudit?: OfficialApiTemporalProjectionAudit
): OfficialApiTemporalProjectionInspection {
  const anchor = normalizeSourceObservedAt(sourceObservedAt) === undefined ? undefined : sourceObservedAt?.trim();
  const candidates = resolveSourceTemporalCandidates(matchedText, anchor);
  const sourceProjection = candidates.length === 1 ? deriveSourceProjection(candidates[0]!) : undefined;
  if (extracted === undefined) {
    if (parseAudit?.status === "rejected") return temporalInspection(sourceProjection, "rejected", parseAudit.reason);
    return sourceProjection === undefined
      ? temporalInspection(undefined, "unavailable", "temporal_projection_missing")
      : temporalInspection(sourceProjection, "formed", sourceProjection.valid_from === undefined
        ? "source_event_time_derived" : "source_valid_time_derived");
  }
  const eventSource = candidates.find((candidate) => verifiesEventProjection(extracted, candidate));
  const validSource = candidates.find((candidate) => verifiesValidProjection(extracted, candidate));
  if (extracted.valid_from !== undefined && validSource === undefined) {
    return temporalInspection(eventSource?.projection ?? sourceProjection, "rejected", "valid_time_role_not_source_grounded");
  }
  if ((extracted.event_time_start !== undefined && eventSource === undefined) ||
      (eventSource === undefined && validSource === undefined)) {
    return temporalInspection(sourceProjection, "rejected", "temporal_projection_not_source_grounded");
  }
  return temporalInspection(verifiedProjection(extracted, eventSource?.projection, validSource?.projection), "formed",
    eventSource !== undefined && validSource !== undefined ? "dual_time_source_verified"
      : validSource !== undefined ? "valid_time_source_verified" : "event_time_source_verified");
}

export function normalizeSourceObservedAt(value: string | undefined): string | undefined {
  return value === undefined ? undefined : normalizeTemporalIsoString(value) ?? undefined;
}

function deriveSourceProjection(candidate: SourceTemporalCandidate): OfficialApiTemporalProjectionDraft | undefined {
  if (candidate.role === "unknown") return undefined;
  if (candidate.role === "event") return candidate.projection;
  const { event_time_start, event_time_end, ...metadata } = candidate.projection;
  return Object.freeze({ ...metadata, valid_from: event_time_start, ...(candidate.bounded ? { valid_to: event_time_end } : {}) });
}

function verifiesEventProjection(extracted: OfficialApiTemporalProjectionDraft, source: SourceTemporalCandidate): boolean {
  return source.role === "event" && extracted.event_time_start === source.projection.event_time_start &&
    extracted.event_time_end !== undefined && verifiesSourceEnd(extracted.event_time_end, source.projection.event_time_end);
}

function verifiesValidProjection(extracted: OfficialApiTemporalProjectionDraft, source: SourceTemporalCandidate): boolean {
  return source.role === "validity" && extracted.valid_from === source.projection.event_time_start &&
    (extracted.valid_to === undefined || (source.bounded && verifiesSourceEnd(extracted.valid_to, source.projection.event_time_end)));
}

function verifiesSourceEnd(nominated: string, sourceEnd: string): boolean {
  if (nominated === sourceEnd) return true;
  // Historical date-only nominations name the final calendar day. Canonical
  // v1 storage still receives the source window's inclusive final millisecond.
  return nominated.endsWith("T00:00:00.000Z") && nominated.slice(0, 10) === sourceEnd.slice(0, 10);
}

function verifiedProjection(
  extracted: OfficialApiTemporalProjectionDraft,
  eventSource: OfficialApiTemporalProjectionDraft | undefined,
  validSource: OfficialApiTemporalProjectionDraft | undefined
): OfficialApiTemporalProjectionDraft {
  const semanticSource = eventSource ?? validSource!;
  return Object.freeze({
    projection_schema_version: 1,
    ...(eventSource === undefined ? {} : { event_time_start: eventSource.event_time_start, event_time_end: eventSource.event_time_end }),
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
  return Object.freeze({ ...(projection === undefined ? {} : { projection }), audit: Object.freeze({ status, reason }) });
}
