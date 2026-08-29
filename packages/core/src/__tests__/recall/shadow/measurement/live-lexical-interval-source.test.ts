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
import { issueLexicalIntervalSourceReceiptV1 } from
  "../../../../recall/field/retrieval/lexical-interval-source-receipt.js";
import type {
  KeywordLexicalMergeCapture,
  KeywordSearchFieldResult
} from "../../../../recall/runtime/recall-service-types.js";
import { fieldCandidates } from "../canonical-delivery-fixtures.js";
import { D1_REQUEST } from "../d1/d1-proof-fixture.js";
import {
  authorityFrom,
  captured,
  cleanup,
  lexicalPin,
  params,
  preparedAuthority,
  supplementary,
  withoutPsi
} from "../live-receipt-fixtures.js";

describe("live normal lexical interval source", () => {
  it("wires the normal source into fine assessment without a diagnostic flag", async () => {
    const candidates = fieldCandidates(["cand-a", "cand-b"]);
    const prepared = await preparedAuthority();
    const observed = source(
      prepared.snapshotVector.vector_digest,
      capture([candidate("cand-a", 0.9, true)]),
      [match("cand-a", 0.9)]
    );
    const built = buildFineAssessParams(
      { warn: () => undefined } as unknown as RecallExecutionContext,
      { workspaceId: "workspace-1" } as unknown as RecallExecutionParams,
      {
        ...prepared,
        retrievalFieldBundle: {
          ...prepared.retrievalFieldBundle,
          memoryLexicalIntervalSourcesForSnapshot: () => [observed],
          memoryLexicalRequestPins: () => [lexicalPin()]
        }
      } as PreparedRecallRequest,
      supplementary(candidates),
      candidates
    );

    expect(built.lexicalIntervalSources).toEqual([observed]);
    expect(built.lexicalBoundProofs).toBeUndefined();
    expect(built.queryProofAuthority?.expected_lexical_request_pins).toEqual([lexicalPin()]);
    cleanup(prepared);
  });

  it("reaches Psi from exact normal merge observations without changing delivery", async () => {
    const candidates = fieldCandidates(["cand-a", "cand-b"]);
    const prepared = await preparedAuthority();
    const base = fineAssess(params(candidates));
    const observed = fineAssess({
      ...params(candidates),
      queryProofAuthority: authorityFrom(prepared),
      lexicalIntervalSources: [source(
        prepared.snapshotVector.vector_digest,
        capture([
          candidate("cand-a", 0.9, true),
          candidate("cand-b", 0.4, true)
        ]),
        [match("cand-a", 0.9), match("cand-b", 0.4)]
      )]
    });
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
    const prepared = await preparedAuthority();
    const result = fineAssess({
      ...params(candidates),
      queryProofAuthority: authorityFrom(prepared),
      lexicalIntervalSources: [source(
        prepared.snapshotVector.vector_digest,
        capture([]),
        []
      )]
    });

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
    const prepared = await preparedAuthority();
    const base = fineAssess(params(candidates));
    const stale = source(
      `sha256:${"c".repeat(64)}`,
      capture([candidate("cand-a", 0.9, true)]),
      [match("cand-a", 0.9)]
    );
    const rejected = fineAssess({
      ...params(candidates),
      queryProofAuthority: authorityFrom(prepared),
      lexicalIntervalSources: [stale]
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

function source(
  snapshot_digest: string,
  lexical_raw_rank: Readonly<KeywordLexicalMergeCapture>,
  matches: Readonly<KeywordSearchFieldResult>["matches"]
) {
  return issueLexicalIntervalSourceReceiptV1({
    workspace_id: "workspace-1",
    request_digest: D1_REQUEST,
    snapshot_digest: snapshot_digest as `sha256:${string}`,
    field_prefix: "lexical_relaxed",
    requested_depth: 2,
    result: Object.freeze({ matches, lanes: Object.freeze([]), lexical_raw_rank })
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
