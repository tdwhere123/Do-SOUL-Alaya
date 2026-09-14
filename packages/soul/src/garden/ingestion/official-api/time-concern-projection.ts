import { createTimeConcernWindowDigest } from "@do-soul/alaya-protocol";
import type { OfficialApiTemporalProjectionDraft } from
  "../../extraction/temporal/projection-draft.js";
import { resolveSourceTemporalCandidates } from "../../extraction/temporal/source-time.js";

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
  readonly sourceObservedAt: string | undefined;
  readonly temporalProjection: OfficialApiTemporalProjectionDraft | undefined;
}>): OfficialApiTimeConcernProjection {
  if (input.sourceObservedAt === undefined) {
    return unavailable("event_time_unavailable");
  }
  const sourceObservedAt = input.sourceObservedAt;
  const projection = input.temporalProjection;
  if (projection?.event_time_start === undefined || projection.event_time_end === undefined) {
    return unavailable("event_time_unavailable");
  }
  const candidate = resolveSourceTemporalCandidates(input.sourceAssertion, sourceObservedAt).find((candidate) => {
    return candidate.role === "event" && candidate.projection.event_time_start === projection.event_time_start &&
      candidate.projection.event_time_end === projection.event_time_end;
  });
  if (candidate === undefined) return unavailable("source_temporal_term_unmatched");
  return Object.freeze({
    payload: Object.freeze({
      window_digest: createTimeConcernWindowDigest(
        projection.event_time_start,
        projection.event_time_end
      ),
      matched_text: input.sourceAssertion.slice(candidate.start, candidate.end)
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
