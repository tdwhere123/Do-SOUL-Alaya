import { describe, expect, it, vi } from "vitest";
import {
  createLexicalIntervalSourceReceiptIntegrityV1,
  verifyLexicalIntervalSourceReceiptIntegrityV1
} from "../../../../recall/field/retrieval/lexical-interval-source-receipt.js";
import { createRecallRetrievalFieldBundle } from
  "../../../../recall/field/retrieval/retrieval-field-bundle.js";
import type { RecallServiceMemoryRepoPort } from
  "../../../../recall/runtime/recall-service-ports.js";
import type {
  KeywordLexicalMergeCapture,
  KeywordSearchFieldResult
} from "../../../../recall/runtime/recall-service-types.js";
import type {
  LexicalBoundLaneId,
  LexicalBoundProducerReceipt
} from "../../../../recall/runtime/recall-search-port-types.js";
import { lexicalIntervalSourceEnvelopes } from
  "../../../../recall/shadow/measurement/lexical-interval-envelope.js";

const REQUEST = `sha256:${"a".repeat(64)}` as const;
const SNAPSHOT = `sha256:${"b".repeat(64)}` as const;

describe("normal lexical interval source receipt", () => {
  it("adapts only chosen observed points and keeps every other lane unbounded", () => {
    const source = capturedSource(fieldResult(capture()));
    verifyLexicalIntervalSourceReceiptIntegrityV1(source);

    const hit = lexicalIntervalSourceEnvelopes(
      source, "workspace_local:memory_entry:hit"
    );
    expect(hit.primary).toMatchObject({
      domain: { lane_id: "porter", list_n: 2, status: "truncated" },
      envelope: { kind: "interval", lower: 1, upper: 1 }
    });
    expect(hit.lanes.porter?.value).toEqual({ kind: "interval", lower: 1, upper: 1 });
    expect(hit.lanes.exact?.value).toEqual({ kind: "unbounded" });

    const missing = lexicalIntervalSourceEnvelopes(source, "missing");
    expect(missing.primary).toBeNull();
    expect(Object.values(missing.lanes).map((lane) => lane?.value))
      .toEqual(expect.arrayContaining([{ kind: "unbounded" }]));
    expect(Object.values(missing.lanes)).not.toContainEqual(expect.objectContaining({
      value: expect.objectContaining({ kind: "interval", lower: 0 })
    }));
  });

  it("keeps a non-admitted capture row unbounded", () => {
    const source = orderingSource([
      entry("hit", "exact", 1, 0), entry("other", "porter", 1, 0),
      entry("outside", "porter", 0.5, 1)
    ], ["hit", "other"]);
    verifyLexicalIntervalSourceReceiptIntegrityV1(source);
    const outside = lexicalIntervalSourceEnvelopes(source, "outside");
    expect(outside.primary).toBeNull();
    expect(outside.lanes.porter?.value).toEqual({ kind: "unbounded" });
  });

  it("accepts producer-observed rows at the requested depth", () => {
    const source = capturedSource(fieldResult(capture()));
    expect(source.capture.lanes.find((lane) => lane.lane_id === "porter"))
      .toMatchObject({ list_n: 2, status: "truncated" });
    expect(() => verifyLexicalIntervalSourceReceiptIntegrityV1(source)).not.toThrow();
  });

  it("rejects a chosen candidate relabeled to an observed sibling lane", () => {
    const relabeled = capture({ chosenLane: "trigram" });
    const source = capturedSource(fieldResult(
      relabeled, 1, producerReceipt("trigram")
    ));
    expect(() => verifyLexicalIntervalSourceReceiptIntegrityV1(source))
      .toThrow(/producer candidate winner/u);
  });

  it("rejects a chosen rank not present in the producer lane row", () => {
    const reranked = capture({ hitRank: 0.75 });
    const source = capturedSource(fieldResult(
      reranked, 0.75, producerReceipt("porter", false, 0.75)
    ));
    expect(() => verifyLexicalIntervalSourceReceiptIntegrityV1(source))
      .toThrow(/producer candidate winner/u);
  });

  it("rejects a forged producer lane priority", () => {
    const forged = producerReceipt("trigram");
    const lanes = forged.lanes.map((laneValue) => laneValue.lane_id === "trigram"
      ? Object.freeze({ ...laneValue, source_priority: 0 as const }) : laneValue);
    const source = capturedSource(fieldResult(
      capture({ chosenLane: "trigram" }), 1, Object.freeze({ ...forged, lanes })
    ));
    expect(() => verifyLexicalIntervalSourceReceiptIntegrityV1(source))
      .toThrow(/producer lane projection/u);
  });

  it("rejects reordered same-priority producer lanes", () => {
    const reordered = producerReceipt("object_key_porter");
    const [exact, porter, objectKeyPorter, trigram, objectKeyTrigram] = reordered.lanes;
    const source = capturedSource(fieldResult(
      capture({ chosenLane: "object_key_porter" }), 1,
      Object.freeze({
        ...reordered,
        lanes: Object.freeze([exact!, objectKeyPorter!, porter!, trigram!, objectKeyTrigram!])
      })
    ));
    expect(() => verifyLexicalIntervalSourceReceiptIntegrityV1(source))
      .toThrow(/producer lane set/u);
  });

  it("rejects admitted producer candidates missing from post-merge", () => {
    const missing = producerReceipt();
    const source = capturedSource(fieldResult(
      capture(), 1, Object.freeze({ ...missing, post_merge: Object.freeze([]) })
    ));
    expect(() => verifyLexicalIntervalSourceReceiptIntegrityV1(source))
      .toThrow(/post-merge set/u);
  });

  it.each([
    ["rank order", [entry("b", "porter", 1, 0), entry("a", "porter", 0.5, 1)], ["a", "b"]],
    ["priority order", [entry("e", "exact", 1, 0), entry("p", "porter", 1, 0)], ["p", "e"]],
    ["source order", [entry("early", "porter", 1, 0), entry("late", "porter", 1, 1)], ["late", "early"]],
    ["object-key sibling tie", [
      entry("a", "object_key_porter", 1, 0), entry("z", "porter", 1, 0)
    ], ["z", "a"]]
  ] as const)("rejects forged %s", (_name, entries, order) => {
    const source = orderingSource(entries, order);
    expect(() => verifyLexicalIntervalSourceReceiptIntegrityV1(source))
      .toThrow(/lane row order|post-merge order/u);
  });

  it("rejects a forged producer post-merge index", () => {
    const source = orderingSource(
      [entry("a", "porter", 1, 0), entry("b", "porter", 0.5, 1)],
      ["a", "b"], true
    );
    expect(() => verifyLexicalIntervalSourceReceiptIntegrityV1(source))
      .toThrow(/post-merge order/u);
  });

  it("accepts an object-key winner bound to its producer lane row", () => {
    const objectKey = capture({ chosenLane: "object_key_porter", objectKeyOnly: true });
    const source = capturedSource(fieldResult(
      objectKey, 1, producerReceipt("object_key_porter", true)
    ));
    expect(() => verifyLexicalIntervalSourceReceiptIntegrityV1(source)).not.toThrow();
    expect(lexicalIntervalSourceEnvelopes(
      source, "workspace_local:memory_entry:hit"
    ).primary?.domain.lane_id).toBe("object_key_porter");
  });

  it("fails closed when only the slim merge capture is available", () => {
    const { lexical_raw_rank_receipt: _ignored, ...slimOnly } = fieldResult(capture());
    const source = createLexicalIntervalSourceReceiptIntegrityV1({
      workspace_id: "workspace-1", request_digest: REQUEST, snapshot_digest: SNAPSHOT,
      field_prefix: "lexical_relaxed", requested_depth: 2, result: slimOnly
    });
    expect(source).toMatchObject({
      status: "unavailable", reason: "producer_lane_observations_absent",
      capture: null, producer_receipt: null
    });
    expect(() => verifyLexicalIntervalSourceReceiptIntegrityV1(source)).not.toThrow();
  });

  it("rejects a self-consistent receipt whose admitted points differ from normal matches", () => {
    const source = capturedSource(fieldResult(capture(), 0.75));
    expect(() => verifyLexicalIntervalSourceReceiptIntegrityV1(source))
      .toThrow(/normal field result/u);
  });

  it("pairs the normal slim capture with core request identity without proof capture", async () => {
    const result = fieldResult(capture());
    const searchByKeywordField = vi.fn(async () => result);
    const bundle = createRecallRetrievalFieldBundle({
      workspaceId: "workspace-1",
      queryText: "stable",
      memoryRepo: memoryRepo(searchByKeywordField)
    });
    await bundle.searchMemoryKeyword({
      variant: "lexical_relaxed",
      queryText: "stable",
      limit: 2,
      scope: {}
    });

    expect(searchByKeywordField.mock.calls).toEqual([
      ["workspace-1", "stable", 2, {}]
    ]);
    expect(bundle.memoryLexicalBoundProofs()).toEqual([]);
    expect("memoryLexicalIntervalSourcesForSnapshot" in bundle).toBe(false);
  });
});

function capturedSource(result: Readonly<KeywordSearchFieldResult>) {
  const source = createLexicalIntervalSourceReceiptIntegrityV1({
    workspace_id: "workspace-1",
    request_digest: REQUEST,
    snapshot_digest: SNAPSHOT,
    field_prefix: "lexical_relaxed",
    requested_depth: 2,
    result
  });
  if (source.status !== "captured") throw new Error("expected captured source");
  return source;
}

function fieldResult(
  lexical_raw_rank: Readonly<KeywordLexicalMergeCapture>,
  normalizedRank = 1,
  lexical_raw_rank_receipt = producerReceipt()
): Readonly<KeywordSearchFieldResult> {
  const matches = lexical_raw_rank.candidates.filter((candidateValue) =>
    candidateValue.admitted
  ).map((candidateValue) => Object.freeze({
    object_id: candidateValue.candidate_key,
    normalized_rank: candidateValue.candidate_key === "hit"
      ? normalizedRank : candidateValue.chosen_normalized_rank!
  }));
  return Object.freeze({
    matches: Object.freeze(matches),
    lanes: Object.freeze([
      fieldLane("exact", "ineligible", []),
      fieldLane("porter", "complete", [
        { object_id: "hit", normalized_rank: 1, rank: 1 },
        { object_id: "outside", normalized_rank: 0.5, rank: 2 }
      ]),
      fieldLane("trigram", "ineligible", [])
    ]),
    lexical_raw_rank,
    lexical_raw_rank_receipt
  });
}

function fieldLane(
  lane: "exact" | "porter" | "trigram",
  status: "complete" | "ineligible",
  observations: readonly Readonly<{
    readonly object_id: string;
    readonly normalized_rank: number;
    readonly rank: number;
  }>[]
) {
  return Object.freeze({
    lane,
    status,
    depth: observations.length,
    observations: Object.freeze([...observations]),
    unseen_upper_bound: status === "complete" ? 0 : null
  });
}

function capture(options: Readonly<{
  readonly chosenLane?: LexicalBoundLaneId;
  readonly hitRank?: number;
  readonly objectKeyOnly?: boolean;
  readonly outsideAdmitted?: boolean;
}> = {}): Readonly<KeywordLexicalMergeCapture> {
  const chosenLane = options.chosenLane ?? "porter";
  const objectKeyOnly = options.objectKeyOnly === true;
  return Object.freeze({
    query_run_id: "memory.keyword.depth:2",
    merge_limit: 2,
    lanes: Object.freeze([
      lane("exact", "matched_token_count", 0, "empty"),
      lane("porter", "bm25_raw_rank", objectKeyOnly ? 0 : 2,
        objectKeyOnly ? "empty" : "truncated"),
      lane("object_key_porter", "bm25_raw_rank", 1, "complete"),
      lane("trigram", "bm25_raw_rank", objectKeyOnly ? 0 : 1,
        objectKeyOnly ? "empty" : "complete"),
      lane("object_key_trigram", "bm25_raw_rank", 0, "empty")
    ]),
    candidates: Object.freeze([
      candidate("hit", options.hitRank ?? 1, true, chosenLane),
      ...(objectKeyOnly ? [] : [candidate(
        "outside", 0.5, options.outsideAdmitted !== false, "porter"
      )])
    ])
  });
}

function lane(
  lane_id: KeywordLexicalMergeCapture["lanes"][number]["lane_id"],
  raw_key_kind: KeywordLexicalMergeCapture["lanes"][number]["raw_key_kind"],
  list_n: number,
  status: KeywordLexicalMergeCapture["lanes"][number]["status"]
) {
  return Object.freeze({ lane_id, raw_key_kind, list_n, status });
}

function candidate(
  candidate_key: string,
  rank: number,
  admitted: boolean,
  chosen_lane_id: LexicalBoundLaneId
) {
  return Object.freeze({
    candidate_key,
    chosen_lane_id,
    chosen_normalized_rank: rank,
    admitted
  });
}

function producerReceipt(
  chosenLane: LexicalBoundLaneId = "porter",
  objectKeyOnly = false,
  chosenRank = 1
): LexicalBoundProducerReceipt {
  const porterRows = objectKeyOnly ? [] : [rawRow("hit", -2, 0, 1), rawRow("outside", -1, 1, 0.5)];
  const trigramRows = objectKeyOnly ? [] : [rawRow("hit", -2, 0, 1)];
  const objectKeyRows = [rawRow("hit", -2, 0, 1)];
  return Object.freeze({
    schema_version: 1,
    receipt_id: "alaya.recall.x0.lexical-raw-rank.v1",
    producer_id: "alaya.storage.mergeKeywordSearchRows.v1",
    query_run_id: "memory.keyword.depth:2",
    merge_limit: 2,
    lanes: Object.freeze([
      producerLane("exact", "matched_token_count", 0, []),
      producerLane("porter", "bm25_raw_rank", 1, porterRows),
      producerLane("object_key_porter", "bm25_raw_rank", 1, objectKeyRows),
      producerLane("trigram", "bm25_raw_rank", 2, trigramRows),
      producerLane("object_key_trigram", "bm25_raw_rank", 2, [])
    ]),
    candidates: Object.freeze([
      producerCandidate("hit", chosenLane, chosenRank, true, 0,
        objectKeyOnly
          ? [{ lane_id: "object_key_porter" as const, ...rawHit(-2, 0, 1) }]
          : [
            { lane_id: "porter" as const, ...rawHit(-2, 0, 1) },
            { lane_id: "object_key_porter" as const, ...rawHit(-2, 0, 1) },
            { lane_id: "trigram" as const, ...rawHit(-2, 0, 1) }
          ]),
      ...(objectKeyOnly ? [] : [producerCandidate(
        "outside", "porter", 0.5, true, 1,
        [{ lane_id: "porter" as const, ...rawHit(-1, 1, 0.5) }]
      )])
    ]),
    post_merge: Object.freeze([
      Object.freeze({ candidate_key: "hit", normalized_rank: 1 }),
      ...(objectKeyOnly ? [] : [Object.freeze({
        candidate_key: "outside", normalized_rank: 0.5
      })])
    ])
  });
}

function producerLane(
  lane_id: LexicalBoundLaneId,
  raw_key_kind: "matched_token_count" | "bm25_raw_rank",
  source_priority: 0 | 1 | 2,
  rows: readonly ReturnType<typeof rawRow>[]
) {
  const status = rows.length === 0 ? "empty" as const
    : rows.length >= 2 ? "truncated" as const : "complete" as const;
  return Object.freeze({
    lane_id, raw_key_kind, source_priority, applicability_source: "memory_fts_lane" as const,
    list_n: rows.length, requested_limit: 2, status, rows: Object.freeze(rows),
    unseen_upper_bound: status === "truncated" ? rows.at(-1)!.grouped_ordinal : 0
  });
}

function rawRow(candidate_key: string, raw_group_key: number, lane_index: number, grouped_ordinal: number) {
  return Object.freeze({
    candidate_key, raw_group_key, lane_index, grouped_ordinal,
    observation_state: "observed" as const
  });
}

function rawHit(raw_group_key: number, lane_index: number, grouped_ordinal: number) {
  return { raw_group_key, lane_index, grouped_ordinal };
}

function producerCandidate(
  candidate_key: string,
  chosen_lane_id: LexicalBoundLaneId,
  chosen_normalized_rank: number,
  admitted: boolean,
  post_merge_index: number | null,
  lane_hits: readonly Readonly<ReturnType<typeof rawHit> & { readonly lane_id: LexicalBoundLaneId }>[]
) {
  return Object.freeze({
    candidate_key, lane_hits: Object.freeze(lane_hits), admitted, chosen_lane_id,
    chosen_normalized_rank, post_merge_index, discarded_lane_ids: Object.freeze(
      lane_hits.map((hit) => hit.lane_id).filter((laneId) => laneId !== chosen_lane_id)
    )
  });
}

type OrderEntry = Readonly<{
  readonly key: string;
  readonly lane: LexicalBoundLaneId;
  readonly rank: number;
  readonly laneIndex: number;
}>;

function entry(
  key: string, lane: LexicalBoundLaneId, rank: number, laneIndex: number
): OrderEntry {
  return Object.freeze({ key, lane, rank, laneIndex });
}

function orderingSource(
  entries: readonly OrderEntry[],
  declaredOrder: readonly string[],
  forgeIndex = false
) {
  const lanes = LANE_ORDER.map((laneId) => producerLane(
    laneId, laneId === "exact" ? "matched_token_count" : "bm25_raw_rank",
    laneId === "exact" ? 0 : laneId.includes("porter") ? 1 : 2,
    entries.filter((item) => item.lane === laneId).map((item) => rawRow(
      item.key, laneId === "exact" ? item.rank : -item.rank, item.laneIndex, item.rank
    ))
  ));
  const candidates = [...entries].sort((left, right) => left.key.localeCompare(right.key))
    .map((item) => {
      const postMergeIndex = declaredOrder.indexOf(item.key);
      return producerCandidate(
      item.key, item.lane, item.rank, postMergeIndex >= 0,
      forgeIndex && item.key === declaredOrder[0] ? 1
        : postMergeIndex < 0 ? null : postMergeIndex,
      [{
        lane_id: item.lane,
        ...rawHit(item.lane === "exact" ? item.rank : -item.rank, item.laneIndex, item.rank)
      }]
    );
    });
  const receipt = Object.freeze({
    schema_version: 1 as const,
    receipt_id: "alaya.recall.x0.lexical-raw-rank.v1" as const,
    producer_id: "alaya.storage.mergeKeywordSearchRows.v1" as const,
    query_run_id: "ordering-fixture", merge_limit: 2,
    lanes: Object.freeze(lanes), candidates: Object.freeze(candidates),
    post_merge: Object.freeze(declaredOrder.map((key) => Object.freeze({
      candidate_key: key, normalized_rank: entries.find((item) => item.key === key)!.rank
    })))
  });
  const captureValue = Object.freeze({
    query_run_id: receipt.query_run_id, merge_limit: 2,
    lanes: Object.freeze(receipt.lanes.map(({ lane_id, raw_key_kind, list_n, status }) =>
      Object.freeze({ lane_id, raw_key_kind, list_n, status })
    )),
    candidates: Object.freeze(receipt.candidates.map((candidateValue) => Object.freeze({
      candidate_key: candidateValue.candidate_key,
      chosen_lane_id: candidateValue.chosen_lane_id,
      chosen_normalized_rank: candidateValue.chosen_normalized_rank,
      admitted: candidateValue.admitted
    })))
  });
  return capturedSource(Object.freeze({
    matches: Object.freeze(declaredOrder.map((key) => Object.freeze({
      object_id: key, normalized_rank: entries.find((item) => item.key === key)!.rank
    }))),
    lanes: Object.freeze([fieldLane("exact", "ineligible", []),
      fieldLane("porter", "ineligible", []), fieldLane("trigram", "ineligible", [])]),
    lexical_raw_rank: captureValue, lexical_raw_rank_receipt: receipt
  }));
}

const LANE_ORDER = Object.freeze([
  "exact", "porter", "object_key_porter", "trigram", "object_key_trigram"
] as const);

function memoryRepo(searchByKeywordField: (...args: never[]) => Promise<unknown>) {
  return { searchByKeywordField } as unknown as RecallServiceMemoryRepoPort;
}
