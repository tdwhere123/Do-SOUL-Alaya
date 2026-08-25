import { describe, expect, it } from "vitest";
import { mergeKeywordSearchRows } from "../../../repos/memory-entry/keyword-search.js";
import {
  LEXICAL_RAW_RANK_PRODUCER_ID,
  LEXICAL_RAW_RANK_RECEIPT_ID,
  LEXICAL_RAW_RANK_RECEIPT_SCHEMA_VERSION,
  captureLexicalRawRankReceipt,
  mergeKeywordSearchRowsWithLexicalCapture,
  type LexicalRawRankCaptureInput,
  type LexicalRawRankReceipt
} from "../../../repos/memory-entry/search/lexical-raw-rank-capture.js";

const PLANTED_QUERY_RUN = "x0-lex-raw-rank.planted.v1";

const DIVERGENT_LANES = Object.freeze({
  exactRows: Object.freeze([
    { object_id: "B", matched_token_count: 2 },
    { object_id: "A", matched_token_count: 1 }
  ]),
  porterRows: Object.freeze([
    { object_id: "A", raw_rank: -10 },
    { object_id: "C", raw_rank: -1 }
  ]),
  trigramRows: Object.freeze([
    { object_id: "C", raw_rank: -8 },
    { object_id: "A", raw_rank: -2 }
  ]),
  limit: 10
});

function capturePlanted(
  input: Omit<LexicalRawRankCaptureInput, "query_run_id">
): {
  readonly merged: ReturnType<typeof mergeKeywordSearchRows>;
  readonly captured: ReturnType<typeof mergeKeywordSearchRowsWithLexicalCapture>;
  readonly receipt: LexicalRawRankReceipt;
} {
  const merged = mergeKeywordSearchRows(
    input.exactRows,
    input.trigramRows,
    input.limit,
    input.porterRows ?? [],
    input.objectKeyLanes ?? {}
  );
  const receipts: LexicalRawRankReceipt[] = [];
  const captured = mergeKeywordSearchRowsWithLexicalCapture(input, {
    query_run_id: PLANTED_QUERY_RUN,
    sink: (receipt) => receipts.push(receipt)
  });
  const receipt = receipts[0];
  if (receipt === undefined) throw new Error("expected one lexical raw-rank receipt");
  return { merged, captured, receipt };
}

function laneOrder(receipt: LexicalRawRankReceipt, laneId: string): readonly string[] {
  return receipt.lanes.find((lane) => lane.lane_id === laneId)?.rows
    .map((row) => row.candidate_key) ?? [];
}

describe("X0-LEX-RAW-RANK diagnostics capture", () => {
  it("is schema-versioned and does not choose a lexical comparison policy", () => {
    const { receipt } = capturePlanted(DIVERGENT_LANES);
    expect(receipt.schema_version).toBe(LEXICAL_RAW_RANK_RECEIPT_SCHEMA_VERSION);
    expect(receipt.receipt_id).toBe(LEXICAL_RAW_RANK_RECEIPT_ID);
    expect(receipt.producer_id).toBe(LEXICAL_RAW_RANK_PRODUCER_ID);
    expect(receipt.query_run_id).toBe(PLANTED_QUERY_RUN);
    expect(receipt).not.toHaveProperty("comparison_policy");
    expect(receipt).not.toHaveProperty("canonical_lane");
    expect(receipt).not.toHaveProperty("lex_domain");
  });

  it("cannot change production membership, score, or order when capture is on", () => {
    const { merged, captured, receipt } = capturePlanted(DIVERGENT_LANES);
    expect(captured).toEqual(merged);
    expect(JSON.stringify(captured)).toBe(JSON.stringify(merged));
    expect(receipt.post_merge.map((row) => row.candidate_key))
      .toEqual(merged.map((row) => row.object_id));
    expect(receipt.post_merge.map((row) => row.normalized_rank))
      .toEqual(merged.map((row) => row.normalized_rank));
  });

  it("records a multi-lane candidate and merge provenance before ftsRanks collapse", () => {
    const { receipt, merged } = capturePlanted(DIVERGENT_LANES);
    const candidateA = receipt.candidates.find((row) => row.candidate_key === "A");
    expect(candidateA?.lane_hits.map((hit) => hit.lane_id).sort())
      .toEqual(["exact", "porter", "trigram"]);
    expect(candidateA?.chosen_lane_id).toBe("porter");
    expect(candidateA?.discarded_lane_ids).toEqual(["exact", "trigram"]);
    expect(candidateA?.admitted).toBe(true);
    expect(merged.find((row) => row.object_id === "A")).not.toHaveProperty("lane_id");
    expect(merged.find((row) => row.object_id === "A")).not.toHaveProperty("sourcePriority");
  });

  it("covers merged order that differs from every lane-local raw order", () => {
    const { receipt } = capturePlanted(DIVERGENT_LANES);
    const mergedOrder = receipt.post_merge.map((row) => row.candidate_key);
    expect(laneOrder(receipt, "exact")).toEqual(["B", "A"]);
    expect(laneOrder(receipt, "porter")).toEqual(["A", "C"]);
    expect(laneOrder(receipt, "trigram")).toEqual(["C", "A"]);
    expect(mergedOrder).toEqual(["B", "A", "C"]);
    expect(mergedOrder).not.toEqual(laneOrder(receipt, "exact"));
    expect(mergedOrder).not.toEqual(laneOrder(receipt, "porter"));
    expect(mergedOrder).not.toEqual(laneOrder(receipt, "trigram"));
  });

  it("keeps lane list N, raw group keys, and truncation instead of reconstructing from final order", () => {
    const { receipt } = capturePlanted({
      exactRows: [],
      porterRows: [
        { object_id: "p1", raw_rank: -9 },
        { object_id: "p2", raw_rank: -4 },
        { object_id: "p3", raw_rank: -1 }
      ],
      trigramRows: [],
      limit: 2
    });
    const porter = receipt.lanes.find((lane) => lane.lane_id === "porter");
    expect(porter?.list_n).toBe(3);
    expect(porter?.requested_limit).toBe(2);
    expect(porter?.status).toBe("truncated");
    expect(porter?.rows.map((row) => row.raw_group_key)).toEqual([-9, -4, -1]);
    expect(receipt.post_merge).toHaveLength(2);
    expect(receipt.candidates.find((row) => row.candidate_key === "p3")?.admitted).toBe(false);
  });

  it("records object-key lanes as distinct sources under the same merge", () => {
    const { receipt, merged } = capturePlanted({
      exactRows: [],
      porterRows: [{ object_id: "shared", raw_rank: -2 }],
      trigramRows: [],
      objectKeyLanes: {
        porter: [{ object_id: "shared", raw_rank: -8 }],
        trigram: [{ object_id: "key-only", raw_rank: -3 }]
      },
      limit: 10
    });
    const shared = receipt.candidates.find((row) => row.candidate_key === "shared");
    expect(shared?.lane_hits.map((hit) => hit.lane_id).sort())
      .toEqual(["object_key_porter", "porter"]);
    expect(receipt.candidates.find((row) => row.candidate_key === "key-only")?.chosen_lane_id)
      .toBe("object_key_trigram");
    expect(merged).toHaveLength(2);
  });

  it("marks unused lanes empty and does not invent a post-merge raw group", () => {
    const { receipt } = capturePlanted({
      exactRows: [{ object_id: "only-exact", matched_token_count: 1 }],
      trigramRows: [],
      limit: 5
    });
    expect(receipt.lanes.find((lane) => lane.lane_id === "porter")?.status).toBe("empty");
    expect(receipt.lanes.find((lane) => lane.lane_id === "trigram")?.status).toBe("empty");
    expect(receipt.lanes.find((lane) => lane.lane_id === "exact")?.status).toBe("complete");
    expect(receipt.post_merge[0]).not.toHaveProperty("raw_group_key");
  });

  it("builds the same receipt from explicit merged rows without calling merge twice", () => {
    const merged = mergeKeywordSearchRows(
      DIVERGENT_LANES.exactRows,
      DIVERGENT_LANES.trigramRows,
      DIVERGENT_LANES.limit,
      DIVERGENT_LANES.porterRows
    );
    const receipt = captureLexicalRawRankReceipt({
      query_run_id: PLANTED_QUERY_RUN,
      ...DIVERGENT_LANES,
      merged
    });
    expect(receipt.candidates.find((row) => row.candidate_key === "A")?.chosen_lane_id)
      .toBe("porter");
  });
});
