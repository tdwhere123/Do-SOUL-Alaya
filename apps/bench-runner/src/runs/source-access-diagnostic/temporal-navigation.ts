import { z } from "zod";
import { AlayaError, canonicalJson } from "@do-soul/alaya-protocol";
import { describeLongMemEvalSessionTime } from "../../datasets/longmemeval/ingestion/source-time.js";
import { SOURCE_OBSERVATION_PROJECTION, type bindSourceRecordsObservation } from "../snapshot/source-records/observation-projection.js";

export const TEMPORAL_NAVIGATION_METHOD = "benchmark-session-window.v1" as const;
export const TEMPORAL_NAVIGATION_DOMAIN = "admitted_nomination_union" as const;
const Coordinate = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  .refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, "invalid comparison coordinate");
export const ObservationWindowSchema = z.object({
  contract: z.literal(TEMPORAL_NAVIGATION_METHOD),
  coordinate: z.enum(["normalized_session_coordinate", "utc_instant"]),
  from: Coordinate, until: Coordinate
}).strict().refine(value => value.from < value.until, "observation window must be nonempty [from,until)");
export type ObservationWindow = z.infer<typeof ObservationWindowSchema>;
export type SourceTimeProjection = ReturnType<ReturnType<typeof bindSourceRecordsObservation>>;
export type NavigationSourceObservation = Readonly<{ record_id: string; source_time: SourceTimeProjection }>;

/** Session precision is an interval, not an invented exact event instant. A UTC
 * spelling in normalized_session_coordinate is only the parser's comparison
 * coordinate. utc_instant requires an explicit source timezone. Neither is
 * assertion validity, and overlapping precision cannot establish membership. */
export function observeSessionWindow(value: ObservationWindow, source?: SourceTimeProjection) {
  const window = ObservationWindowSchema.parse(value);
  const base = { method: TEMPORAL_NAVIGATION_METHOD, window };
  if (source === undefined) return { ...base, status: "unobserved" as const, reason: "candidate_not_observed" as const, relation: null };
  if (source.contract !== SOURCE_OBSERVATION_PROJECTION) throw new AlayaError("VALIDATION", "unsupported source observation projection");
  if (source.observation.status === "unknown") return { ...base, status: "unknown" as const, reason: source.observation.reason, relation: null };
  if (!("binding" in source) || source.binding === undefined) throw new AlayaError("VALIDATION", "source observation provenance missing");
  const { status: _status, ...description } = source.observation;
  if (canonicalJson(description) !== canonicalJson(describeLongMemEvalSessionTime(description.raw))) {
    throw new AlayaError("VALIDATION", "source observation precision/provenance mismatch");
  }
  if (window.coordinate === "utc_instant" && description.timezone === "unspecified") {
    return { ...base, status: "unsupported" as const, reason: "source_timezone_unspecified" as const, relation: null };
  }
  const start = Date.parse(description.normalized);
  const width = { day: 86_400_000, minute: 60_000, second: 1000, millisecond: 1 }[description.precision];
  const end = start + width, from = Date.parse(window.from), until = Date.parse(window.until);
  const interval = { from: description.normalized, until: new Date(end).toISOString(), precision: description.precision,
    timezone: description.timezone };
  if (end <= from || start >= until) return { ...base, interval, status: "known" as const, reason: "disjoint" as const, relation: "outside" as const };
  if (start >= from && end <= until) return { ...base, interval, status: "known" as const, reason: "contained" as const, relation: "inside" as const };
  return { ...base, interval, status: "partial" as const, reason: "precision_overlaps_boundary" as const, relation: "overlap" as const };
}
