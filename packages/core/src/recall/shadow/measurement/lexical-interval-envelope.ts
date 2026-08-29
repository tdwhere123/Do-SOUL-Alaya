import type { LexicalIntervalSourceReceiptCapturedV1 } from
  "../../field/retrieval/lexical-interval-source-receipt.js";
import type {
  D1CandidateEnvelopeMap,
  D1EnvelopeIdentity,
  D1LaneEnvelope,
  D1PrimaryObservation
} from "../d1/legal-envelope.js";
import {
  parseLexDomain,
  type LexLaneId
} from "../observations.js";

const MEMORY_ENTRY_FIELD_KEY = /^(?:workspace_local|global):memory_entry:(.+)$/u;
const UNBOUNDED = Object.freeze({ kind: "unbounded" as const });

export function lexicalIntervalSourceEnvelopes(
  source: Readonly<LexicalIntervalSourceReceiptCapturedV1>,
  candidateKey: string
): D1CandidateEnvelopeMap {
  const identity = Object.freeze({
    field_prefix: source.field_prefix,
    query_run_id: source.capture.query_run_id,
    snapshot_digest: source.snapshot_digest,
    request_digest: source.request_digest,
    workspace_id: source.workspace_id
  });
  const lanes: Partial<Record<LexLaneId, D1LaneEnvelope>> = {};
  for (const lane of source.capture.lanes) {
    lanes[lane.lane_id] = Object.freeze({
      domain: parseLexDomain(lane),
      value: UNBOUNDED
    });
  }
  const lookupKey = candidateLookupKey(candidateKey);
  const observation = source.capture.candidates.find((row) =>
    row.candidate_key === lookupKey);
  if (observation?.admitted !== true) {
    return sourceEnvelope(identity, source.capture.query_run_id, lanes, null);
  }
  const laneId = observation?.chosen_lane_id;
  const rank = observation?.chosen_normalized_rank;
  const lane = laneId === null || laneId === undefined ? undefined : lanes[laneId];
  if (laneId === null || laneId === undefined || lane === undefined || lane.domain === null ||
      typeof rank !== "number" || !Number.isFinite(rank)) {
    return sourceEnvelope(identity, source.capture.query_run_id, lanes, null);
  }
  const point = Object.freeze({ kind: "interval" as const, lower: rank, upper: rank });
  lanes[laneId] = Object.freeze({ domain: lane.domain, value: point });
  return sourceEnvelope(identity, source.capture.query_run_id, lanes, Object.freeze({
    domain: lane.domain,
    envelope: point
  }));
}

function sourceEnvelope(
  identity: D1EnvelopeIdentity,
  queryRunId: string,
  lanes: Partial<Record<LexLaneId, D1LaneEnvelope>>,
  primary: D1PrimaryObservation | null
): D1CandidateEnvelopeMap {
  return Object.freeze({
    identity,
    field_prefix: identity.field_prefix,
    query_run_id: queryRunId,
    snapshot_digest: identity.snapshot_digest,
    request_digest: identity.request_digest,
    primary,
    lanes: Object.freeze(lanes)
  });
}

function candidateLookupKey(candidateKey: string): string {
  const match = MEMORY_ENTRY_FIELD_KEY.exec(candidateKey);
  return match?.[1] !== undefined && match[1].length > 0 ? match[1] : candidateKey;
}
