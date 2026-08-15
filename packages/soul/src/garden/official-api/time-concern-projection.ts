import { createTimeConcernWindowDigest } from "@do-soul/alaya-protocol";
import { extractTemporalTerms } from "@do-soul/alaya-graph-algorithms";
import type { OfficialApiTemporalProjectionDraft } from
  "../temporal/observed-projection.js";
import { resolveTemporalProjection } from "../time-concern-projection.js";

export type OfficialApiTimeConcernProjectionAudit = Readonly<{
  readonly status: "formed" | "unavailable";
  readonly reason:
    | "source_temporal_term_verified"
    | "event_time_unavailable"
    | "source_temporal_term_unmatched";
}>;

export type OfficialApiTimeConcernProjection = Readonly<{
  readonly payload?: Readonly<{
    readonly window_digest: string;
    readonly matched_text: string;
  }>;
  readonly audit: OfficialApiTimeConcernProjectionAudit;
}>;

export function projectOfficialApiTimeConcern(input: Readonly<{
  readonly sourceAssertion: string;
  readonly sourceObservedAt: string;
  readonly temporalProjection: OfficialApiTemporalProjectionDraft | undefined;
}>): OfficialApiTimeConcernProjection {
  const projection = input.temporalProjection;
  if (projection?.event_time_start === undefined || projection.event_time_end === undefined) {
    return unavailable("event_time_unavailable");
  }
  const term = extractTemporalTerms(input.sourceAssertion).find((candidate) => {
    const resolved = resolveTemporalProjection(candidate, input.sourceObservedAt);
    return resolved !== null && resolved.event_time_start === projection.event_time_start &&
      resolved.event_time_end === projection.event_time_end;
  });
  if (term === undefined) return unavailable("source_temporal_term_unmatched");
  return Object.freeze({
    payload: Object.freeze({
      window_digest: createTimeConcernWindowDigest(
        projection.event_time_start,
        projection.event_time_end
      ),
      matched_text: term
    }),
    audit: Object.freeze({
      status: "formed",
      reason: "source_temporal_term_verified"
    })
  });
}

function unavailable(
  reason: Exclude<OfficialApiTimeConcernProjectionAudit["reason"], "source_temporal_term_verified">
): OfficialApiTimeConcernProjection {
  return Object.freeze({
    audit: Object.freeze({ status: "unavailable", reason })
  });
}
