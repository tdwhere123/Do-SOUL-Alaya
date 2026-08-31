import type {
  CoarseRecallCandidate,
  KeywordLexicalMergeCapture,
  KeywordSearchLaneReceipt
} from "../../../recall/runtime/recall-service-types.js";
import {
  OPEN_SEMANTIC_FACTOR_COMPOSITION_OPERATOR_ID,
  type OpenSemanticFactorCompositionReceipt
} from "../../../recall/field/open-semantic-factors/composition.js";
import type { KeywordLexicalLaneId } from "../../../recall/runtime/recall-search-port-types.js";
import type { RecallFieldDigest } from "../../../recall/field/field-identity.js";
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

const OSF_DIGEST = `sha256:${"c".repeat(64)}` as RecallFieldDigest;

export function compositionForValues(): OpenSemanticFactorCompositionReceipt {
  const variable_collections = Object.freeze([{
    variable_id: "answer",
    observation_count: 3,
    distinct_value_count: 2,
    values: Object.freeze([
      Object.freeze({ semantic_identity: "value-a", surfaces: Object.freeze(["A"]), evidence_ids: Object.freeze(["evidence-a"]) }),
      Object.freeze({ semantic_identity: "value-c", surfaces: Object.freeze(["C"]), evidence_ids: Object.freeze(["evidence-c"]) })
    ])
  }]);
  return Object.freeze({
    schema_version: 2,
    operator_id: OPEN_SEMANTIC_FACTOR_COMPOSITION_OPERATOR_ID,
    status: "composed",
    compatibility_trace_digest: OSF_DIGEST,
    query_capture_digest: OSF_DIGEST,
    result_variable_ids: Object.freeze(["answer"]),
    search_step_count: 1,
    solution_count: 0,
    observed_binding_count: 0,
    binding_observation_count: 0,
    truncated: false,
    bindings: Object.freeze([]),
    solutions: Object.freeze([]),
    variable_collections,
    receipt_digest: OSF_DIGEST
  });
}

function lexicalLaneId(lane: KeywordSearchLaneReceipt["lane"]): KeywordLexicalLaneId | null {
  switch (lane) {
    case "exact":
    case "porter":
    case "trigram":
      return lane;
    default:
      return null;
  }
}

function mergeLaneStatus(
  status: KeywordSearchLaneReceipt["status"]
): "empty" | "complete" | "truncated" {
  if (status === "complete" || status === "truncated") {
    return status;
  }
  return "empty";
}

export function rawRankCaptures(
  lanes: readonly Readonly<KeywordSearchLaneReceipt>[]
): readonly Readonly<KeywordLexicalMergeCapture>[] {
  const lane = lanes[0];
  if (lane === undefined) return Object.freeze([]);
  const laneId = lexicalLaneId(lane.lane);
  if (laneId === null) return Object.freeze([]);
  return Object.freeze([Object.freeze({
    query_run_id: "canonical-delivery-test",
    merge_limit: lane.depth,
    lanes: Object.freeze([Object.freeze({
      lane_id: laneId,
      raw_key_kind: laneId === "exact" ? "matched_token_count" : "bm25_raw_rank",
      list_n: lane.depth,
      status: mergeLaneStatus(lane.status)
    })]),
    candidates: Object.freeze(lane.observations.map((observation) => Object.freeze({
      candidate_key: observation.object_id,
      chosen_lane_id: laneId,
      chosen_normalized_rank: observation.normalized_rank,
      admitted: true
    })))
  })]);
}
