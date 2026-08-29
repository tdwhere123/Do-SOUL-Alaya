import { describe, expect, it } from "vitest";
import { fineAssess } from
  "../../../../recall/delivery/fine-assessment.js";
import { buildFineAssessParams } from
  "../../../../recall/runtime/orchestration/recall-fine-assessment.js";
import type {
  PreparedRecallRequest,
  RecallExecutionContext,
  RecallExecutionParams
} from "../../../../recall/runtime/recall-service-runner-types.js";
import type { LexicalIntervalSourceReceiptV1 } from
  "../../../../recall/field/retrieval/lexical-interval-source-receipt.js";
import { createRecallRetrievalFieldBundle } from
  "../../../../recall/field/retrieval/retrieval-field-bundle.js";
import {
  bindRetrievalFieldBundleReadAuthority,
  readMemoryLexicalIntervalSources
} from "../../../../recall/field/retrieval/retrieval-field-source-authority.js";
import { withActiveRecallReadSnapshot } from
  "../../../../recall/runtime/recall-read-snapshot.js";
import type {
  KeywordLexicalMergeCapture,
  KeywordSearchFieldResult
} from "../../../../recall/runtime/recall-service-types.js";
import { fieldCandidates } from "../canonical-delivery-fixtures.js";
import {
  authorityFrom,
  captured,
  capturedLexicalPreparedAuthority,
  cleanup,
  params,
  preparedAuthority,
  supplementary,
  withoutPsi
} from "../live-receipt-fixtures.js";

describe("live normal lexical interval source", () => {
  it("keeps query authority but omits lexical proof for the normal unavailable source", async () => {
    const candidates = fieldCandidates(["cand-a", "cand-b"]);
    const prepared = await preparedAuthority();
    const bundle = createRecallRetrievalFieldBundle({
      workspaceId: "workspace-1",
      queryText: "stable",
      memoryRepo: { searchByKeywordField: async () => Object.freeze({
        matches: [match("cand-a", 0.9)],
        lanes: normalLanes([match("cand-a", 0.9)]),
        lexical_raw_rank: capture([candidate("cand-a", 0.9, true)])
      }) }
    });
    const built = await withActiveRecallReadSnapshot(snapshotPort(), async (capability) => {
      bindRetrievalFieldBundleReadAuthority(bundle, prepared.snapshotReadLease, capability);
      await bundle.searchMemoryKeyword({
        variant: "lexical_relaxed", queryText: "stable", limit: 2, scope: {}
      });
      return buildFineAssessParams(
        { warn: () => undefined } as unknown as RecallExecutionContext,
        { workspaceId: "workspace-1" } as unknown as RecallExecutionParams,
        { ...prepared, retrievalFieldBundle: bundle } as PreparedRecallRequest,
        supplementary(candidates),
        candidates
      );
    });

    expect(built.lexicalIntervalSources).toBeUndefined();
    expect(built.lexicalBoundProofs).toBeUndefined();
    expect(built.queryProofAuthority).toBeDefined();
    cleanup(prepared);
  });

  it("reaches Psi from exact normal merge observations without changing delivery", async () => {
    const candidates = fieldCandidates(["cand-a", "cand-b"]);
    const prepared = await capturedLexicalPreparedAuthority();
    const base = fineAssess(params(candidates));
    const issued = await source(
      prepared,
      capture([
        candidate("cand-a", 0.9, true), candidate("cand-b", 0.4, true)
      ]),
      [match("cand-a", 0.9), match("cand-b", 0.4)],
      undefined,
      (lexicalSource) => fineAssess({
        ...params(candidates),
        queryProofAuthority: authorityFromSource(prepared, lexicalSource),
        lexicalIntervalSources: [lexicalSource]
      })
    );
    const observed = issued.assessed!;
    const trace = captured(observed.shadowTrace);

    expect(trace.psi_v2_shadow).toMatchObject({
      observation_status: "observed",
      undominated_share: 0.5,
      producer_outcomes: [
        { producer_id: "lex.interval", status: "observed" },
        { producer_id: "support", status: "not_observed" }
      ]
    });
    expect(withoutPsi(trace)).toEqual(withoutPsi(captured(base.shadowTrace)));
    expect(observed.candidates).toEqual(base.candidates);
    expect(observed.capture_receipt).toEqual(base.capture_receipt);
    cleanup(prepared);
  });

  it("keeps a valid source with no candidate observation explicitly unobserved", async () => {
    const candidates = fieldCandidates(["cand-a", "cand-b"]);
    const prepared = await capturedLexicalPreparedAuthority();
    const issued = await source(
      prepared, capture([]), [], undefined,
      (observed) => fineAssess({
        ...params(candidates),
        queryProofAuthority: authorityFromSource(prepared, observed),
        lexicalIntervalSources: [observed]
      })
    );
    const result = issued.assessed!;

    expect(captured(result.shadowTrace).psi_v2_shadow).toMatchObject({
      observation_status: "not_observed",
      producer_outcomes: expect.arrayContaining([{
        producer_id: "lex.interval",
        status: "not_observed",
        reason: "applicable_receipt_absent"
      }])
    });
    cleanup(prepared);
  });

  it("rejects a source sealed to another snapshot without changing delivery", async () => {
    const candidates = fieldCandidates(["cand-a", "cand-b"]);
    const prepared = await capturedLexicalPreparedAuthority();
    const base = fineAssess(params(candidates));
    const stale = await sourceReceipt(
      prepared,
      capture([candidate("cand-a", 0.9, true)]),
      [match("cand-a", 0.9)]
    );
    const counterfeit = { ...stale, snapshot_digest: `sha256:${"c".repeat(64)}` } as
      LexicalIntervalSourceReceiptV1;
    const rejected = fineAssess({
      ...params(candidates),
      queryProofAuthority: authorityFromSource(prepared, stale),
      lexicalIntervalSources: [counterfeit]
    });

    expect(captured(rejected.shadowTrace).psi_v2_shadow).toMatchObject({
      observation_status: "malformed",
      producer_outcomes: expect.arrayContaining([{
        producer_id: "lex.interval",
        status: "malformed",
        contract_code: "authority_identity_mismatch"
      }])
    });
    expect(rejected.candidates).toEqual(base.candidates);
    expect(rejected.capture_receipt).toEqual(base.capture_receipt);
    cleanup(prepared);
  });
});

async function source(
  prepared: PreparedRecallRequest,
  lexical_raw_rank: Readonly<KeywordLexicalMergeCapture>,
  matches: Readonly<KeywordSearchFieldResult>["matches"],
  buildCandidates?: ReturnType<typeof fieldCandidates>,
  assess?: (receipt: LexicalIntervalSourceReceiptV1) => ReturnType<typeof fineAssess>
) {
  const bundle = createRecallRetrievalFieldBundle({
    workspaceId: "workspace-1",
    queryText: "stable",
    memoryRepo: { searchByKeywordField: async () => Object.freeze({
      matches,
      lanes: normalLanes(matches),
      lexical_raw_rank
    }) }
  });
  return await withActiveRecallReadSnapshot(snapshotPort(), async (capability) => {
    bindRetrievalFieldBundleReadAuthority(bundle, prepared.snapshotReadLease, capability);
    await bundle.searchMemoryKeyword({
      variant: "lexical_relaxed", queryText: "stable", limit: 2, scope: {}
    });
    const [receipt] = readMemoryLexicalIntervalSources(bundle);
    if (receipt === undefined) throw new Error("expected issued lexical source");
    return {
      receipt,
      assessed: assess?.(receipt),
      built: buildCandidates === undefined ? undefined : buildFineAssessParams(
        { warn: () => undefined } as unknown as RecallExecutionContext,
        { workspaceId: "workspace-1" } as unknown as RecallExecutionParams,
        { ...prepared, retrievalFieldBundle: bundle } as PreparedRecallRequest,
        supplementary(buildCandidates),
        buildCandidates
      )
    };
  });
}

async function sourceReceipt(
  prepared: PreparedRecallRequest,
  captureValue: Readonly<KeywordLexicalMergeCapture>,
  matches: Readonly<KeywordSearchFieldResult>["matches"]
) {
  return (await source(prepared, captureValue, matches)).receipt;
}

function authorityFromSource(
  prepared: PreparedRecallRequest,
  receipt: LexicalIntervalSourceReceiptV1
) {
  return Object.freeze({ ...authorityFrom(prepared), expected_lexical_request_pins: [pinFrom(receipt)] });
}

function pinFrom(receipt: LexicalIntervalSourceReceiptV1) {
  return Object.freeze({
    workspace_id: receipt.workspace_id,
    request_digest: receipt.request_digest,
    field_prefix: receipt.field_prefix,
    candidate_key_domain: receipt.candidate_key_domain
  });
}

function snapshotPort() {
  return { beginDeferred() {}, commit() {}, rollback() {} };
}

function normalLanes(matches: Readonly<KeywordSearchFieldResult>["matches"]) {
  const observations = matches.map((value, index) => Object.freeze({
    ...value,
    rank: index + 1
  }));
  return Object.freeze([
    normalLane("exact", "ineligible", []),
    normalLane("porter", "complete", observations),
    normalLane("trigram", "ineligible", [])
  ]);
}

function normalLane(
  lane: "exact" | "porter" | "trigram",
  status: "complete" | "ineligible",
  observations: readonly Readonly<{
    readonly object_id: string;
    readonly normalized_rank: number;
    readonly rank: number;
  }>[]
) {
  return Object.freeze({
    lane, status, depth: observations.length,
    observations: Object.freeze([...observations]),
    unseen_upper_bound: status === "complete" ? 0 : null
  });
}

function capture(
  candidates: readonly Readonly<KeywordLexicalMergeCapture["candidates"][number]>[]
): Readonly<KeywordLexicalMergeCapture> {
  return Object.freeze({
    query_run_id: "memory.keyword.depth:2",
    merge_limit: 2,
    lanes: Object.freeze([
      lane("exact", "matched_token_count", 0, "empty"),
      lane(
        "porter", "bm25_raw_rank", candidates.length,
        candidates.length === 0 ? "empty" : "complete"
      ),
      lane("object_key_porter", "bm25_raw_rank", 0, "empty"),
      lane("trigram", "bm25_raw_rank", 0, "empty"),
      lane("object_key_trigram", "bm25_raw_rank", 0, "empty")
    ]),
    candidates: Object.freeze([...candidates])
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

function match(object_id: string, normalized_rank: number) {
  return Object.freeze({ object_id, normalized_rank });
}
