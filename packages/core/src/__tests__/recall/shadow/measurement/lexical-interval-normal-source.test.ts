import { describe, expect, it, vi } from "vitest";
import {
  issueLexicalIntervalSourceReceiptV1,
  verifyLexicalIntervalSourceReceiptV1
} from "../../../../recall/field/retrieval/lexical-interval-source-receipt.js";
import { createRecallRetrievalFieldBundle } from
  "../../../../recall/field/retrieval/retrieval-field-bundle.js";
import type { RecallServiceMemoryRepoPort } from
  "../../../../recall/runtime/recall-service-ports.js";
import type {
  KeywordLexicalMergeCapture,
  KeywordSearchFieldResult
} from "../../../../recall/runtime/recall-service-types.js";
import { lexicalIntervalSourceEnvelopes } from
  "../../../../recall/shadow/measurement/lexical-bound-envelope.js";

const REQUEST = `sha256:${"a".repeat(64)}` as const;
const SNAPSHOT = `sha256:${"b".repeat(64)}` as const;

describe("normal lexical interval source receipt", () => {
  it("adapts only chosen observed points and keeps every other lane unbounded", () => {
    const source = capturedSource(fieldResult(capture()));
    verifyLexicalIntervalSourceReceiptV1(source);

    const hit = lexicalIntervalSourceEnvelopes(
      source, "workspace_local:memory_entry:hit"
    );
    expect(hit.primary).toMatchObject({
      domain: { lane_id: "porter", list_n: 2, status: "complete" },
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

  it("retains an exact observed point even when another field admitted the candidate", () => {
    const source = capturedSource(fieldResult(capture()));
    const outside = lexicalIntervalSourceEnvelopes(source, "outside");
    expect(outside.primary?.envelope).toEqual({ kind: "interval", lower: 0.5, upper: 0.5 });
    expect(outside.primary?.domain.lane_id).toBe("porter");
  });

  it("accepts a complete lane exactly at the requested depth", () => {
    const source = capturedSource(fieldResult(capture()));
    expect(source.capture.lanes.find((lane) => lane.lane_id === "porter"))
      .toMatchObject({ list_n: 2, status: "complete" });
    expect(() => verifyLexicalIntervalSourceReceiptV1(source)).not.toThrow();
  });

  it("rejects a self-consistent receipt whose admitted points differ from normal matches", () => {
    const source = capturedSource(fieldResult(capture(), 0.75));
    expect(() => verifyLexicalIntervalSourceReceiptV1(source))
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
    const [source] = bundle.memoryLexicalIntervalSourcesForSnapshot(SNAPSHOT);
    expect(source).toMatchObject({
      status: "captured",
      workspace_id: "workspace-1",
      snapshot_digest: SNAPSHOT,
      field_prefix: "lexical_relaxed",
      candidate_key_domain: "memory_object_id"
    });
    expect(source?.request_digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(source?.request_digest).not.toBe(SNAPSHOT);
  });
});

function capturedSource(result: Readonly<KeywordSearchFieldResult>) {
  const source = issueLexicalIntervalSourceReceiptV1({
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
  normalizedRank = 1
): Readonly<KeywordSearchFieldResult> {
  return Object.freeze({
    matches: Object.freeze([{ object_id: "hit", normalized_rank: normalizedRank }]),
    lanes: Object.freeze([
      fieldLane("exact", "ineligible", []),
      fieldLane("porter", "complete", [
        { object_id: "hit", normalized_rank: 1, rank: 1 },
        { object_id: "outside", normalized_rank: 0.5, rank: 2 }
      ]),
      fieldLane("trigram", "ineligible", [])
    ]),
    lexical_raw_rank
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

function capture(): Readonly<KeywordLexicalMergeCapture> {
  return Object.freeze({
    query_run_id: "memory.keyword.depth:2",
    merge_limit: 2,
    lanes: Object.freeze([
      lane("exact", "matched_token_count", 0, "empty"),
      lane("porter", "bm25_raw_rank", 2, "complete"),
      lane("object_key_porter", "bm25_raw_rank", 0, "empty"),
      lane("trigram", "bm25_raw_rank", 0, "empty"),
      lane("object_key_trigram", "bm25_raw_rank", 0, "empty")
    ]),
    candidates: Object.freeze([
      candidate("hit", 1, true),
      candidate("outside", 0.5, false)
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

function candidate(candidate_key: string, rank: number, admitted: boolean) {
  return Object.freeze({
    candidate_key,
    chosen_lane_id: "porter" as const,
    chosen_normalized_rank: rank,
    admitted
  });
}

function memoryRepo(searchByKeywordField: (...args: never[]) => Promise<unknown>) {
  return { searchByKeywordField } as unknown as RecallServiceMemoryRepoPort;
}
