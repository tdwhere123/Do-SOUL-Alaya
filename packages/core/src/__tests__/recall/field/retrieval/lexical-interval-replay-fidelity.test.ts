import { compareCodeUnits } from "@do-soul/alaya-protocol";
import { describe, expect, it } from "vitest";
import {
  createLexicalIntervalSourceReceiptIntegrityV1,
  verifyLexicalIntervalSourceReceiptIntegrityV1
} from "../../../../recall/field/retrieval/lexical-interval-source-receipt.js";

type LaneId = "exact" | "porter" | "object_key_porter" | "trigram" |
  "object_key_trigram";
type LaneHit = Readonly<{
  readonly lane_id: LaneId;
  readonly raw_group_key: number;
  readonly grouped_ordinal: number;
  readonly lane_index: number;
}>;

describe("lexical interval producer replay fidelity", () => {
  it("uses code-unit post-merge order for a lawful Unicode pair", () => {
    const composed = "\u00e9";
    const decomposed = "e\u0301";
    expect(composed).not.toBe(decomposed);
    expect(composed.localeCompare(decomposed)).toBe(0);
    expect(compareCodeUnits(decomposed, composed)).toBeLessThan(0);
    const result = unicodeTieResult(composed, decomposed);
    expect(result.lexical_raw_rank_receipt.post_merge.map((row) => row.candidate_key))
      .toEqual([decomposed, composed]);
    expect(result.matches.map((row) => row.object_id)).toEqual([decomposed, composed]);
    expect(() => verify(result)).not.toThrow();
  });

  it("rejects reversed producer lane hits", () => {
    const valid = crossLaneFixture();
    const hits = valid.lexical_raw_rank_receipt.candidates[0]!.lane_hits;
    expect(() => verify(crossLaneFixture({ laneHits: [...hits].reverse() })))
      .toThrow(/candidate lane hits/u);
  });

  it.each([
    ["winner", ["porter", "trigram", "object_key_trigram"]],
    ["reordered", ["object_key_trigram", "trigram"]],
    ["omitted", ["trigram"]]
  ] as const)("rejects %s in discarded lane projection", (_name, discarded) => {
    expect(() => verify(crossLaneFixture({ discarded })))
      .toThrow(/discarded lanes/u);
  });

  it("rejects missing and forged producer optional ranks", () => {
    expect(() => verify(crossLaneFixture({ postMerge: {
      candidate_key: "shared", normalized_rank: 1, object_key_rank: 1
    } }))).toThrow(/optional ranks/u);
    expect(() => verify(crossLaneFixture({ postMerge: {
      candidate_key: "shared", normalized_rank: 1, trigram_rank: 1, object_key_rank: 0.5
    } }))).toThrow(/optional ranks/u);
  });

  it("rejects an optional producer rank without a corresponding lane row", () => {
    const result = exactOnlyResult({ trigram_rank: 1 });
    expect(() => verify(result)).toThrow(/optional ranks/u);
  });

  it("binds normal match optional ranks positionally", () => {
    expect(() => verify(crossLaneFixture({ normalMatch: {
      object_id: "shared", normalized_rank: 1, object_key_rank: 1
    } }))).toThrow(/normal field result/u);
  });

  it("rejects a fully synchronized duplicate candidate within one lane", () => {
    expect(() => verify(duplicateExactResult())).toThrow(/duplicate candidate rows/u);
  });
});

function verify(result: ReturnType<typeof crossLaneFixture>): void {
  const receipt = createLexicalIntervalSourceReceiptIntegrityV1({
    workspace_id: "workspace-1",
    request_digest: `sha256:${"a".repeat(64)}`,
    snapshot_digest: `sha256:${"b".repeat(64)}`,
    field_prefix: "lexical_relaxed",
    requested_depth: result.lexical_raw_rank.merge_limit,
    result
  });
  verifyLexicalIntervalSourceReceiptIntegrityV1(receipt);
}

function crossLaneFixture(options: Readonly<{
  readonly laneHits?: readonly LaneHit[];
  readonly discarded?: readonly LaneId[];
  readonly postMerge?: Readonly<Record<string, string | number>>;
  readonly normalMatch?: Readonly<Record<string, string | number>>;
}> = {}) {
  const porter = hit("porter", -3, 0, 1);
  const trigram = hit("trigram", -2, 0, 1);
  const objectKey = hit("object_key_trigram", -1, 0, 1);
  const laneHits = options.laneHits ?? [porter, trigram, objectKey];
  const postMerge = options.postMerge ?? {
    candidate_key: "shared", normalized_rank: 1, trigram_rank: 1, object_key_rank: 1
  };
  const normalMatch = options.normalMatch ?? {
    object_id: "shared", normalized_rank: 1, trigram_rank: 1, object_key_rank: 1
  };
  return resultFixture({
    mergeLimit: 1,
    lanes: [
      producerLane("exact", []), producerLane("porter", [row("shared", porter)]),
      producerLane("object_key_porter", []),
      producerLane("trigram", [row("shared", trigram)]),
      producerLane("object_key_trigram", [row("shared", objectKey)])
    ],
    candidates: [candidate("shared", "porter", 1, 0, laneHits,
      options.discarded ?? ["trigram", "object_key_trigram"])],
    postMerge: [postMerge], normalMatches: [normalMatch]
  });
}

function unicodeTieResult(composed: string, decomposed: string) {
  const porter = hit("porter", -1, 0, 1);
  const objectKey = hit("object_key_porter", -1, 0, 1);
  const candidates = [
    candidate(composed, "porter", 1, 1, [porter], []),
    candidate(decomposed, "object_key_porter", 1, 0, [objectKey], [])
  ].sort((left, right) => compareCodeUnits(left.candidate_key, right.candidate_key));
  return resultFixture({
    mergeLimit: 2,
    lanes: [
      producerLane("exact", [], 2), producerLane("porter", [row(composed, porter)], 2),
      producerLane("object_key_porter", [row(decomposed, objectKey)], 2),
      producerLane("trigram", [], 2), producerLane("object_key_trigram", [], 2)
    ],
    candidates,
    postMerge: [
      { candidate_key: decomposed, normalized_rank: 1, object_key_rank: 1 },
      { candidate_key: composed, normalized_rank: 1 }
    ],
    normalMatches: [
      { object_id: decomposed, normalized_rank: 1, object_key_rank: 1 },
      { object_id: composed, normalized_rank: 1 }
    ]
  });
}

function exactOnlyResult(optional: Readonly<Record<string, number>>) {
  const exact = hit("exact", 1, 0, 1);
  return resultFixture({
    mergeLimit: 1,
    lanes: [
      producerLane("exact", [row("only", exact)]), producerLane("porter", []),
      producerLane("object_key_porter", []), producerLane("trigram", []),
      producerLane("object_key_trigram", [])
    ],
    candidates: [candidate("only", "exact", 1, 0, [exact], [])],
    postMerge: [{ candidate_key: "only", normalized_rank: 1, ...optional }],
    normalMatches: [{ object_id: "only", normalized_rank: 1, ...optional }]
  });
}

function duplicateExactResult() {
  const first = hit("exact", 2, 0, 1);
  const second = hit("exact", 1, 1, 0.5);
  return resultFixture({
    mergeLimit: 2,
    lanes: [
      producerLane("exact", [row("hit", first), row("hit", second)], 2),
      producerLane("porter", [], 2), producerLane("object_key_porter", [], 2),
      producerLane("trigram", [], 2), producerLane("object_key_trigram", [], 2)
    ],
    candidates: [candidate("hit", "exact", 1, 0, [first, second], [])],
    postMerge: [{ candidate_key: "hit", normalized_rank: 1 }],
    normalMatches: [{ object_id: "hit", normalized_rank: 1 }]
  });
}

function resultFixture(input: Readonly<{
  readonly mergeLimit: number;
  readonly lanes: readonly ReturnType<typeof producerLane>[];
  readonly candidates: readonly ReturnType<typeof candidate>[];
  readonly postMerge: readonly Readonly<Record<string, string | number>>[];
  readonly normalMatches: readonly Readonly<Record<string, string | number>>[];
}>) {
  return Object.freeze({
    matches: Object.freeze(input.normalMatches),
    lanes: Object.freeze([]),
    lexical_raw_rank: Object.freeze({
      query_run_id: "replay-fidelity", merge_limit: input.mergeLimit,
      lanes: Object.freeze(input.lanes.map(({ lane_id, raw_key_kind, list_n, status }) =>
        Object.freeze({ lane_id, raw_key_kind, list_n, status })
      )),
      candidates: Object.freeze(input.candidates.map((item) => Object.freeze({
        candidate_key: item.candidate_key, chosen_lane_id: item.chosen_lane_id,
        chosen_normalized_rank: item.chosen_normalized_rank, admitted: item.admitted
      })))
    }),
    lexical_raw_rank_receipt: Object.freeze({
      schema_version: 1 as const, receipt_id: "alaya.recall.x0.lexical-raw-rank.v1" as const,
      producer_id: "alaya.storage.mergeKeywordSearchRows.v1" as const,
      query_run_id: "replay-fidelity", merge_limit: input.mergeLimit,
      lanes: Object.freeze(input.lanes), candidates: Object.freeze(input.candidates),
      post_merge: Object.freeze(input.postMerge)
    })
  });
}

function candidate(
  candidate_key: string, chosen_lane_id: LaneId, rank: number, postMergeIndex: number,
  lane_hits: readonly LaneHit[], discarded_lane_ids: readonly LaneId[]
) {
  return Object.freeze({
    candidate_key, lane_hits: Object.freeze(lane_hits), admitted: true,
    chosen_lane_id, chosen_normalized_rank: rank, post_merge_index: postMergeIndex,
    discarded_lane_ids: Object.freeze(discarded_lane_ids)
  });
}

function producerLane(lane_id: LaneId, rows: readonly ReturnType<typeof row>[], limit = 1) {
  const status = rows.length === 0 ? "empty" as const
    : rows.length >= limit ? "truncated" as const : "complete" as const;
  return Object.freeze({
    lane_id, raw_key_kind: lane_id === "exact" ? "matched_token_count" as const
      : "bm25_raw_rank" as const,
    source_priority: lane_id === "exact" ? 0 as const
      : lane_id === "porter" || lane_id === "object_key_porter" ? 1 as const : 2 as const,
    applicability_source: "memory_fts_lane" as const,
    list_n: rows.length, requested_limit: limit, status, rows: Object.freeze(rows),
    unseen_upper_bound: status === "truncated" ? rows.at(-1)!.grouped_ordinal : 0
  });
}

function row(candidate_key: string, laneHit: LaneHit) {
  return Object.freeze({
    candidate_key, raw_group_key: laneHit.raw_group_key,
    lane_index: laneHit.lane_index, grouped_ordinal: laneHit.grouped_ordinal,
    observation_state: "observed" as const
  });
}

function hit(
  lane_id: LaneId, raw_group_key: number, lane_index: number, grouped_ordinal: number
): LaneHit {
  return Object.freeze({ lane_id, raw_group_key, lane_index, grouped_ordinal });
}
