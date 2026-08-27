import {
  type LexicalBoundLaneCapture,
  type LexicalBoundProducerReceipt
} from "../../../../recall/runtime/diagnostics/lexical-bound-proof.js";
import { compileRecallQueryProbes } from "../../../../recall/query/recall-query-probes.js";
import type {
  CoarseRecallCandidate,
  KeywordLexicalMergeCapture,
  RecallServiceMemoryRepoPort,
  RecallSupplementaryData
} from "../../../../recall/runtime/recall-service-types.js";
import { createMemoryEntry } from "../../recall-service-test-fixtures.js";

export function truncatedReceipt(): LexicalBoundProducerReceipt {
  return Object.freeze({
    schema_version: 1 as const,
    receipt_id: "alaya.recall.x0.lexical-raw-rank.v1",
    producer_id: "alaya.storage.mergeKeywordSearchRows.v1",
    query_run_id: "memory.keyword.depth:2",
    merge_limit: 2,
    lanes: Object.freeze([
      emptyLane("exact", "matched_token_count", 0, 2),
      lane("porter", "bm25_raw_rank", 1, 2, "truncated", [
        row("p1", -9, 0, 1),
        row("p2", -4, 1, 0.5),
        row("p3", -1, 2, 0)
      ]),
      emptyLane("trigram", "bm25_raw_rank", 2, 2),
      lane("object_key_porter", "bm25_raw_rank", 1, 2, "complete", [
        row("shared", -8, 0, 1)
      ]),
      lane("object_key_trigram", "bm25_raw_rank", 2, 2, "complete", [
        row("key-only", -3, 0, 1)
      ])
    ]),
    candidates: Object.freeze([
      provenance("key-only", "object_key_trigram", 1, true, 1, []),
      provenance("p1", "porter", 1, true, 0, []),
      provenance("p2", "porter", 0.5, true, 1, []),
      provenance("p3", "porter", 0, false, null, []),
      provenance("shared", "porter", 1, false, null, ["object_key_porter"])
    ]),
    post_merge: Object.freeze([
      Object.freeze({ candidate_key: "p1", normalized_rank: 1 }),
      Object.freeze({ candidate_key: "p2", normalized_rank: 0.5 })
    ])
  });
}

export function completeReceipt(): LexicalBoundProducerReceipt {
  return Object.freeze({
    schema_version: 1 as const,
    receipt_id: "alaya.recall.x0.lexical-raw-rank.v1",
    producer_id: "alaya.storage.mergeKeywordSearchRows.v1",
    query_run_id: "memory.keyword.depth:10",
    merge_limit: 10,
    lanes: Object.freeze([
      lane("exact", "matched_token_count", 0, 10, "complete", [
        row("B", 2, 0, 1),
        row("A", 1, 1, 0.5)
      ]),
      lane("porter", "bm25_raw_rank", 1, 10, "complete", [
        row("A", -10, 0, 1),
        row("C", -1, 1, 0.5)
      ]),
      emptyLane("trigram", "bm25_raw_rank", 2, 10),
      emptyLane("object_key_porter", "bm25_raw_rank", 1, 10),
      emptyLane("object_key_trigram", "bm25_raw_rank", 2, 10)
    ]),
    candidates: Object.freeze([
      provenance("A", "porter", 1, true, 1, ["exact"]),
      provenance("B", "exact", 1, true, 0, []),
      provenance("C", "porter", 0.5, true, 2, [])
    ]),
    post_merge: Object.freeze([
      Object.freeze({ candidate_key: "B", normalized_rank: 1 }),
      Object.freeze({ candidate_key: "A", normalized_rank: 0.5 }),
      Object.freeze({ candidate_key: "C", normalized_rank: 0.25 })
    ])
  });
}

export function fieldResult(
  receipt: LexicalBoundProducerReceipt,
  includeSibling = true
) {
  const live = stripLive(receipt);
  return Object.freeze({
    matches: Object.freeze(receipt.post_merge.map((item) => Object.freeze({
      object_id: item.candidate_key,
      normalized_rank: item.normalized_rank
    }))),
    lanes: Object.freeze([
      ineligibleLane("exact"),
      Object.freeze({
        lane: "porter" as const,
        status: "truncated" as const,
        depth: receipt.post_merge.length,
        observations: Object.freeze(receipt.post_merge.map((item, index) => Object.freeze({
          object_id: item.candidate_key,
          rank: index + 1,
          normalized_rank: item.normalized_rank
        }))),
        unseen_upper_bound: 1
      }),
      ineligibleLane("trigram")
    ]),
    lexical_raw_rank: live,
    ...(includeSibling ? { lexical_raw_rank_receipt: receipt } : {})
  });
}

export function stubMemoryRepo(
  searchByKeywordField: NonNullable<RecallServiceMemoryRepoPort["searchByKeywordField"]>
): RecallServiceMemoryRepoPort {
  return {
    findByWorkspaceId: async () => [],
    findByDimension: async () => [],
    findByScopeClass: async () => [],
    searchByKeywordField
  } as RecallServiceMemoryRepoPort;
}

export function stripLive(receipt: LexicalBoundProducerReceipt): KeywordLexicalMergeCapture {
  return Object.freeze({
    query_run_id: receipt.query_run_id,
    merge_limit: receipt.merge_limit,
    lanes: Object.freeze(receipt.lanes.map((item) => Object.freeze({
      lane_id: item.lane_id,
      raw_key_kind: item.raw_key_kind,
      list_n: item.list_n,
      status: item.status
    }))),
    candidates: Object.freeze(receipt.candidates.map((item) => Object.freeze({
      candidate_key: item.candidate_key,
      chosen_lane_id: item.chosen_lane_id,
      chosen_normalized_rank: item.chosen_normalized_rank,
      admitted: item.admitted
    })))
  });
}

export function candidateOf(objectId: string): CoarseRecallCandidate {
  return {
    entry: createMemoryEntry({
      object_id: objectId,
      content: `Operator workspace fact ${objectId}`
    }),
    admissionPlanes: ["activation"],
    firstAdmissionPlane: "activation"
  };
}

export function emptySupplementary(query: string): RecallSupplementaryData {
  return {
    queryProbes: compileRecallQueryProbes(query),
    ftsRanks: {},
    trigramFtsRanks: {},
    synthesisFtsRanks: {},
    evidenceFtsRanks: {},
    evidenceProjectionMatchesByRef: {},
    sourceProximityScores: {},
    sourceCohortKeys: {},
    structuralScores: {},
    graphExpansionScores: {},
    entitySeedScores: {},
    pathExpansionScores: {},
    pathSuppressionScores: {},
    embeddingSimilarityScores: {},
    evidenceSemanticActivationsByCandidateKey: new Map(),
    graphSupportCounts: {},
    budgetPenaltyFactor: 0,
    plasticityFactors: {},
    graphAndPathColdScore: 0,
    recallsEdgeCount: 0,
    weightTransferAmount: 0,
    evidenceGistsByMemoryId: {},
    governanceCeilingByMemoryId: {}
  };
}

function lane(
  laneId: LexicalBoundLaneCapture["lane_id"],
  rawKeyKind: LexicalBoundLaneCapture["raw_key_kind"],
  sourcePriority: 0 | 1 | 2,
  requestedLimit: number,
  status: LexicalBoundLaneCapture["status"],
  rows: readonly ReturnType<typeof row>[]
): LexicalBoundLaneCapture {
  return Object.freeze({
    lane_id: laneId,
    raw_key_kind: rawKeyKind,
    source_priority: sourcePriority,
    applicability_source: "memory_fts_lane",
    list_n: rows.length,
    requested_limit: requestedLimit,
    status,
    rows: Object.freeze(rows),
    unseen_upper_bound: status === "truncated" ? rows[rows.length - 1]!.grouped_ordinal : 0
  });
}

function emptyLane(
  laneId: LexicalBoundLaneCapture["lane_id"],
  rawKeyKind: LexicalBoundLaneCapture["raw_key_kind"],
  sourcePriority: 0 | 1 | 2,
  requestedLimit: number
): LexicalBoundLaneCapture {
  return lane(laneId, rawKeyKind, sourcePriority, requestedLimit, "empty", []);
}

function row(
  candidateKey: string,
  rawGroupKey: number,
  laneIndex: number,
  groupedOrdinal: number
) {
  return Object.freeze({
    candidate_key: candidateKey,
    raw_group_key: rawGroupKey,
    lane_index: laneIndex,
    grouped_ordinal: groupedOrdinal,
    observation_state: "observed" as const
  });
}

function provenance(
  candidateKey: string,
  chosenLaneId: LexicalBoundLaneCapture["lane_id"] | null,
  chosenRank: number | null,
  admitted: boolean,
  postMergeIndex: number | null,
  discarded: readonly LexicalBoundLaneCapture["lane_id"][]
) {
  return Object.freeze({
    candidate_key: candidateKey,
    lane_hits: Object.freeze([]),
    admitted,
    chosen_lane_id: chosenLaneId,
    chosen_normalized_rank: chosenRank,
    post_merge_index: postMergeIndex,
    discarded_lane_ids: Object.freeze(discarded)
  });
}

function ineligibleLane(laneId: "exact" | "trigram") {
  return Object.freeze({
    lane: laneId,
    status: "ineligible" as const,
    depth: 0,
    observations: Object.freeze([]),
    unseen_upper_bound: null
  });
}
