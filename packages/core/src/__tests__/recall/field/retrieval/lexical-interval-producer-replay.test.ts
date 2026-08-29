import { describe, expect, it } from "vitest";
import { verifyLexicalIntervalProducerReplay } from
  "../../../../recall/field/retrieval/lexical-interval-producer-replay.js";
import type { LexicalBoundProducerReceipt } from
  "../../../../recall/runtime/recall-search-port-types.js";

describe("lexical interval producer replay", () => {
  it("accepts a canonical producer replay", () => {
    const fixture = planted();
    expect(() => verifyLexicalIntervalProducerReplay(fixture.capture, fixture.receipt))
      .not.toThrow();
  });

  it("rejects a lane-row candidate omitted from both candidate projections", () => {
    const fixture = planted();
    const row = rawRow("x", -1, 0, 1);
    const lanes = fixture.receipt.lanes.map((lane) => lane.lane_id === "trigram"
      ? Object.freeze({ ...lane, list_n: 1, status: "complete" as const, rows: [row] })
      : lane);
    const slimLanes = fixture.capture.lanes.map((lane) => lane.lane_id === "trigram"
      ? Object.freeze({ ...lane, list_n: 1, status: "complete" as const }) : lane);
    expect(() => verifyLexicalIntervalProducerReplay(
      Object.freeze({ ...fixture.capture, lanes: slimLanes }),
      Object.freeze({ ...fixture.receipt, lanes })
    )).toThrow(/candidate closure/u);
  });

  it("rejects a synchronized forged lane index", () => {
    const fixture = planted();
    const lanes = fixture.receipt.lanes.map((lane) => lane.lane_id === "exact"
      ? Object.freeze({ ...lane, rows: lane.rows.map((row, index) =>
        index === 0 ? Object.freeze({ ...row, lane_index: 1 }) : row) }) : lane);
    const candidates = fixture.receipt.candidates.map((candidate) =>
      candidate.candidate_key === "b" ? Object.freeze({
        ...candidate,
        lane_hits: candidate.lane_hits.map((hit) => Object.freeze({ ...hit, lane_index: 1 }))
      }) : candidate);
    expect(() => verifyLexicalIntervalProducerReplay(
      fixture.capture, Object.freeze({ ...fixture.receipt, lanes, candidates })
    )).toThrow(/lane row order/u);
  });

  it("rejects a synchronized forged grouped ordinal", () => {
    const fixture = planted();
    const lanes = fixture.receipt.lanes.map((lane) => lane.lane_id === "exact"
      ? Object.freeze({ ...lane, rows: lane.rows.map((row) => row.candidate_key === "a"
        ? Object.freeze({ ...row, grouped_ordinal: 0.7 }) : row) }) : lane);
    expect(() => verifyLexicalIntervalProducerReplay(
      fixture.capture, Object.freeze({ ...fixture.receipt, lanes })
    )).toThrow(/lane row order/u);
  });

  it("rejects non-canonical raw-rank order", () => {
    const fixture = planted();
    const lanes = fixture.receipt.lanes.map((lane) => lane.lane_id === "exact"
      ? Object.freeze({ ...lane, rows: [
        Object.freeze({ ...lane.rows[0]!, raw_group_key: 1 }),
        Object.freeze({ ...lane.rows[1]!, raw_group_key: 2 })
      ] }) : lane);
    expect(() => verifyLexicalIntervalProducerReplay(
      fixture.capture, Object.freeze({ ...fixture.receipt, lanes })
    )).toThrow(/raw rank order|lane row order/u);
  });

  it("rejects synchronized non-canonical candidate ordering", () => {
    const fixture = planted();
    expect(() => verifyLexicalIntervalProducerReplay(
      Object.freeze({ ...fixture.capture, candidates: [...fixture.capture.candidates].reverse() }),
      Object.freeze({ ...fixture.receipt, candidates: [...fixture.receipt.candidates].reverse() })
    )).toThrow(/candidate order/u);
  });

  it("rejects synchronized duplicate candidate rows within one lane", () => {
    const fixture = planted();
    const rows = [rawRow("a", 2, 0, 1), rawRow("a", 1, 1, 0.5)];
    const lanes = fixture.receipt.lanes.map((lane) => lane.lane_id === "exact"
      ? Object.freeze({ ...lane, rows }) : lane);
    const candidates = [Object.freeze({
      ...fixture.receipt.candidates[0]!, chosen_normalized_rank: 1, post_merge_index: 0,
      lane_hits: Object.freeze(rows.map((row) => Object.freeze({
        lane_id: "exact" as const, raw_group_key: row.raw_group_key,
        grouped_ordinal: row.grouped_ordinal, lane_index: row.lane_index
      })))
    })];
    const capture = Object.freeze({
      ...fixture.capture,
      candidates: [Object.freeze({
        candidate_key: "a", chosen_lane_id: "exact" as const,
        chosen_normalized_rank: 1, admitted: true
      })]
    });
    const receipt = Object.freeze({
      ...fixture.receipt, lanes, candidates,
      post_merge: [Object.freeze({ candidate_key: "a", normalized_rank: 1 })]
    });
    expect(() => verifyLexicalIntervalProducerReplay(capture, receipt))
      .toThrow(/duplicate candidate rows/u);
  });

  it("accepts the same candidate observed in different lanes", () => {
    const fixture = planted();
    const porterRow = rawRow("a", -1, 0, 1);
    const lanes = fixture.receipt.lanes.map((lane) => lane.lane_id === "porter"
      ? Object.freeze({ ...lane, list_n: 1, status: "complete" as const, rows: [porterRow] })
      : lane);
    const candidates = fixture.receipt.candidates.map((candidate) =>
      candidate.candidate_key === "a" ? Object.freeze({
        ...candidate, chosen_lane_id: "porter" as const, chosen_normalized_rank: 1,
        discarded_lane_ids: Object.freeze(["exact" as const]),
        lane_hits: Object.freeze([...candidate.lane_hits, Object.freeze({
          lane_id: "porter" as const, raw_group_key: -1, grouped_ordinal: 1, lane_index: 0
        })])
      }) : candidate);
    const captureLanes = fixture.capture.lanes.map((lane) => lane.lane_id === "porter"
      ? Object.freeze({ ...lane, list_n: 1, status: "complete" as const }) : lane);
    const captureCandidates = fixture.capture.candidates.map((candidate) =>
      candidate.candidate_key === "a" ? Object.freeze({
        ...candidate, chosen_lane_id: "porter" as const, chosen_normalized_rank: 1
      }) : candidate);
    expect(() => verifyLexicalIntervalProducerReplay(
      Object.freeze({ ...fixture.capture, lanes: captureLanes, candidates: captureCandidates }),
      Object.freeze({
        ...fixture.receipt, lanes, candidates,
        post_merge: Object.freeze([
          Object.freeze({ candidate_key: "b", normalized_rank: 1 }),
          Object.freeze({ candidate_key: "a", normalized_rank: 1 })
        ])
      })
    )).not.toThrow();
  });
});

function planted() {
  const rows = [rawRow("b", 2, 0, 1), rawRow("a", 1, 1, 0.5)];
  const receipt: LexicalBoundProducerReceipt = Object.freeze({
    schema_version: 1, receipt_id: "alaya.recall.x0.lexical-raw-rank.v1",
    producer_id: "alaya.storage.mergeKeywordSearchRows.v1",
    query_run_id: "producer-replay", merge_limit: 2,
    lanes: Object.freeze([
      lane("exact", "matched_token_count", 0, rows),
      lane("porter", "bm25_raw_rank", 1, []),
      lane("object_key_porter", "bm25_raw_rank", 1, []),
      lane("trigram", "bm25_raw_rank", 2, []),
      lane("object_key_trigram", "bm25_raw_rank", 2, [])
    ]),
    candidates: Object.freeze([
      candidate("a", 0.5, 1), candidate("b", 1, 0)
    ]),
    post_merge: Object.freeze([
      Object.freeze({ candidate_key: "b", normalized_rank: 1 }),
      Object.freeze({ candidate_key: "a", normalized_rank: 0.5 })
    ])
  });
  const capture = Object.freeze({
    query_run_id: receipt.query_run_id, merge_limit: 2,
    lanes: Object.freeze(receipt.lanes.map(({ lane_id, raw_key_kind, list_n, status }) =>
      Object.freeze({ lane_id, raw_key_kind, list_n, status })
    )),
    candidates: Object.freeze(receipt.candidates.map((item) => Object.freeze({
      candidate_key: item.candidate_key, chosen_lane_id: item.chosen_lane_id,
      chosen_normalized_rank: item.chosen_normalized_rank, admitted: item.admitted
    })))
  });
  return Object.freeze({ receipt, capture });
}

function lane(
  lane_id: "exact" | "porter" | "object_key_porter" | "trigram" | "object_key_trigram",
  raw_key_kind: "matched_token_count" | "bm25_raw_rank",
  source_priority: 0 | 1 | 2,
  rows: readonly ReturnType<typeof rawRow>[]
) {
  return Object.freeze({
    lane_id, raw_key_kind, source_priority, applicability_source: "memory_fts_lane" as const,
    list_n: rows.length, requested_limit: 2,
    status: rows.length === 0 ? "empty" as const : "truncated" as const,
    rows: Object.freeze(rows), unseen_upper_bound: rows.at(-1)?.grouped_ordinal ?? 0
  });
}

function rawRow(candidate_key: string, raw_group_key: number, lane_index: number, grouped_ordinal: number) {
  return Object.freeze({ candidate_key, raw_group_key, lane_index, grouped_ordinal,
    observation_state: "observed" as const });
}

function candidate(candidate_key: string, rank: number, post_merge_index: number) {
  return Object.freeze({
    candidate_key,
    lane_hits: Object.freeze([Object.freeze({
      lane_id: "exact" as const, raw_group_key: candidate_key === "a" ? 1 : 2,
      grouped_ordinal: rank, lane_index: post_merge_index === 0 ? 0 : 1
    })]),
    admitted: true, chosen_lane_id: "exact" as const,
    chosen_normalized_rank: rank, post_merge_index, discarded_lane_ids: Object.freeze([])
  });
}
