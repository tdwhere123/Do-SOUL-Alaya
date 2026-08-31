import type {
  CoarseRecallCandidate,
  KeywordLexicalMergeCapture,
  KeywordSearchLaneReceipt,
  RecallSupplementaryData
} from "../../../recall/runtime/recall-service-types.js";
import { createMemoryEntry } from "../recall-service-test-fixtures.js";

export function fieldCandidates(
  ids: readonly string[]
): readonly CoarseRecallCandidate[] {
  return ids.map((objectId, index) => extraCandidate(objectId, index));
}

export function extraCandidate(
  objectId: string,
  index = 0
): CoarseRecallCandidate {
  return {
    entry: createMemoryEntry({
      object_id: objectId,
      content: `Operator workspace fact ${index}`,
      activation_score: 0.4 + index * 0.1
    }),
    admissionPlanes: ["activation"],
    firstAdmissionPlane: "activation"
  };
}

export function evidenceCandidate(
  objectId: string,
  evidenceRef: string
): CoarseRecallCandidate {
  return {
    ...extraCandidate(objectId),
    entry: createMemoryEntry({
      object_id: objectId,
      content: `Evidence backed ${objectId}`,
      evidence_refs: [evidenceRef]
    }),
    admissionPlanes: ["activation"],
    firstAdmissionPlane: "activation"
  };
}

export function compositionForValues(): RecallSupplementaryData[
  "openSemanticFactorComposition"
] {
  return {
    status: "composed",
    truncated: false,
    variable_collections: [{
      variable_id: "answer",
      observation_count: 3,
      distinct_value_count: 2,
      values: [
        { semantic_identity: "value-a", surfaces: ["A"], evidence_ids: ["evidence-a"] },
        { semantic_identity: "value-c", surfaces: ["C"], evidence_ids: ["evidence-c"] }
      ]
    }]
  } as RecallSupplementaryData["openSemanticFactorComposition"];
}

export function rawRankCaptures(
  lanes: readonly Readonly<KeywordSearchLaneReceipt>[]
): readonly Readonly<KeywordLexicalMergeCapture>[] {
  const lane = lanes[0];
  if (lane === undefined) return Object.freeze([]);
  return Object.freeze([Object.freeze({
    query_run_id: "canonical-delivery-test",
    merge_limit: lane.depth,
    lanes: Object.freeze([Object.freeze({
      lane_id: lane.lane,
      raw_key_kind: lane.lane === "exact" ? "matched_token_count" : "bm25_raw_rank",
      list_n: lane.depth,
      status: lane.status
    })]),
    candidates: Object.freeze(lane.observations.map((observation) => Object.freeze({
      candidate_key: observation.object_id,
      chosen_lane_id: lane.lane,
      chosen_normalized_rank: observation.normalized_rank,
      admitted: true
    })))
  })]);
}
