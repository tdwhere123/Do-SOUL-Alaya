import { describe, expect, it } from "vitest";
import { fineAssess } from
  "../../../../../recall/delivery/fine-assessment.js";
import { buildFineAssessParams } from
  "../../../../../recall/runtime/orchestration/recall-fine-assessment.js";
import type {
  PreparedRecallRequest,
  RecallExecutionContext,
  RecallExecutionParams
} from "../../../../../recall/runtime/recall-service-runner-types.js";
import type { LexicalIntervalSourceReceiptV1 } from
  "../../../../../recall/field/retrieval/lexical-interval-source-receipt.js";
import { createRecallRetrievalFieldBundle } from
  "../../../../../recall/field/retrieval/retrieval-field-bundle.js";
import {
  bindRetrievalFieldBundleReadAuthority,
  readMemoryLexicalIntervalSources
} from "../../../../../recall/field/retrieval/retrieval-field-source-authority.js";
import { withActiveRecallReadSnapshot } from
  "../../../../../recall/runtime/recall-read-snapshot.js";
import type {
  KeywordLexicalMergeCapture,
  KeywordSearchFieldResult
} from "../../../../../recall/runtime/recall-service-types.js";
import type {
  LexicalBoundLaneId,
  LexicalBoundProducerReceipt
} from "../../../../../recall/runtime/recall-search-port-types.js";
import { fieldCandidates } from "../../../delivery/canonical-delivery-fixtures.js";
import {
  authorityFrom,
  captured,
  capturedLexicalPreparedAuthority,
  cleanup,
  params,
  preparedAuthority,
  supplementary,
  withoutPsi
} from "../../../integration/shadow/live-receipt-fixtures.js";

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
        candidate("cand-a", 1, true), candidate("cand-b", 0.5, true)
      ]),
      [match("cand-a", 1), match("cand-b", 0.5)],
      undefined,
      (lexicalSource, bundle) => fineAssess({
        ...params(candidates),
        queryProofAuthority: authorityFromSource(prepared, lexicalSource, bundle),
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
      (observed, bundle) => fineAssess({
        ...params(candidates),
        queryProofAuthority: authorityFromSource(prepared, observed, bundle),
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
      capture([candidate("cand-a", 1, true)]),
      [match("cand-a", 1)]
    );
    const counterfeit = { ...stale, snapshot_digest: `sha256:${"c".repeat(64)}` } as
      LexicalIntervalSourceReceiptV1;
    const rejected = fineAssess({
      ...params(candidates),
      queryProofAuthority: authorityFromSource(prepared, stale, undefined),
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

  it("requires the exact issued source, bundle, lease, and request", async () => {
    const candidates = fieldCandidates(["cand-a", "cand-b"]);
    const prepared = await capturedLexicalPreparedAuthority();
    const rejected: ReturnType<typeof fineAssess>[] = [];
    const issued = await source(
      prepared,
      capture([candidate("cand-a", 1, true)]),
      [match("cand-a", 1)],
      undefined,
      (receipt, bundle) => {
        const exact = authorityFromSource(prepared, receipt, bundle);
        const otherBundle = createRecallRetrievalFieldBundle({
          workspaceId: "workspace-1",
          queryText: "other bundle",
          memoryRepo: { searchByKeywordField: async () => Object.freeze({
            matches: [], lanes: normalLanes([])
          }) }
        });
        rejected.push(fineAssess({
          ...params(candidates),
          queryProofAuthority: exact,
          lexicalIntervalSources: [{ ...receipt } as LexicalIntervalSourceReceiptV1]
        }));
        rejected.push(fineAssess({
          ...params(candidates),
          queryProofAuthority: { ...exact, lexical_source_bundle: otherBundle },
          lexicalIntervalSources: [receipt]
        }));
        rejected.push(fineAssess({
          ...params(candidates),
          queryProofAuthority: {
            ...exact,
            snapshot_read_lease: { ...exact.snapshot_read_lease }
          },
          lexicalIntervalSources: [receipt]
        }));
        rejected.push(fineAssess({
          ...params(candidates),
          queryProofAuthority: {
            ...exact,
            expected_lexical_request_pins: [{
              ...pinFrom(receipt),
              request_digest: `sha256:${"d".repeat(64)}`
            }]
          },
          lexicalIntervalSources: [receipt]
        }));
        return fineAssess({
          ...params(candidates),
          queryProofAuthority: exact,
          lexicalIntervalSources: [receipt]
        });
      }
    );

    expect(captured(issued.assessed!.shadowTrace).psi_v2_shadow.observation_status)
      .toBe("observed");
    for (const result of rejected) {
      expect(captured(result.shadowTrace).psi_v2_shadow.observation_status)
        .toBe("malformed");
    }
    cleanup(prepared);
  });
});

async function source(
  prepared: PreparedRecallRequest,
  lexical_raw_rank: Readonly<KeywordLexicalMergeCapture>,
  matches: Readonly<KeywordSearchFieldResult>["matches"],
  buildCandidates?: ReturnType<typeof fieldCandidates>,
  assess?: (
    receipt: LexicalIntervalSourceReceiptV1,
    bundle: ReturnType<typeof createRecallRetrievalFieldBundle>
  ) => ReturnType<typeof fineAssess>
) {
  const bundle = createRecallRetrievalFieldBundle({
    workspaceId: "workspace-1",
    queryText: "stable",
    memoryRepo: { searchByKeywordField: async () => Object.freeze({
      matches,
      lanes: normalLanes(matches),
      lexical_raw_rank,
      lexical_raw_rank_receipt: producerReceipt(lexical_raw_rank, matches)
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
      assessed: assess?.(receipt, bundle),
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
  receipt: LexicalIntervalSourceReceiptV1,
  bundle: ReturnType<typeof createRecallRetrievalFieldBundle> | undefined
) {
  return Object.freeze({
    ...authorityFrom(prepared),
    ...(bundle === undefined ? {} : { lexical_source_bundle: bundle }),
    expected_lexical_request_pins: [pinFrom(receipt)]
  });
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
        candidates.length === 0 ? "empty"
          : candidates.length >= 2 ? "truncated" : "complete"
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

function producerReceipt(
  captureValue: Readonly<KeywordLexicalMergeCapture>,
  matches: Readonly<KeywordSearchFieldResult>["matches"]
): LexicalBoundProducerReceipt {
  const lanes = captureValue.lanes.map((lane) => producerLane(lane, captureValue));
  return Object.freeze({
    schema_version: 1,
    receipt_id: "alaya.recall.x0.lexical-raw-rank.v1",
    producer_id: "alaya.storage.mergeKeywordSearchRows.v1",
    query_run_id: captureValue.query_run_id,
    merge_limit: captureValue.merge_limit,
    lanes: Object.freeze(lanes),
    candidates: Object.freeze(captureValue.candidates.map((candidate) => {
      const hit = candidate.chosen_lane_id === null || candidate.chosen_normalized_rank === null
        ? null
        : rawHit(candidate.chosen_lane_id, candidate.candidate_key,
          candidate.chosen_normalized_rank, captureValue);
      return Object.freeze({
        ...candidate,
        lane_hits: Object.freeze(hit === null ? [] : [hit]),
        post_merge_index: matches.findIndex((match) => match.object_id === candidate.candidate_key),
        discarded_lane_ids: Object.freeze([])
      });
    })),
    post_merge: Object.freeze(matches.map((match) => Object.freeze({
      candidate_key: match.object_id, normalized_rank: match.normalized_rank
    })))
  });
}

function producerLane(
  laneValue: KeywordLexicalMergeCapture["lanes"][number],
  captureValue: Readonly<KeywordLexicalMergeCapture>
) {
  const rows = captureValue.candidates.flatMap((candidate) =>
    candidate.chosen_lane_id === laneValue.lane_id &&
      candidate.chosen_normalized_rank !== null
      ? [rawRow(candidate.candidate_key, candidate.chosen_normalized_rank, rowsFor(
        captureValue, laneValue.lane_id
      ).indexOf(candidate))]
      : []
  );
  return Object.freeze({
    ...laneValue,
    source_priority: lanePriority(laneValue.lane_id),
    applicability_source: "memory_fts_lane" as const,
    requested_limit: captureValue.merge_limit,
    rows: Object.freeze(rows),
    unseen_upper_bound: laneValue.status === "truncated"
      ? rows.at(-1)?.grouped_ordinal ?? 0 : 0
  });
}

function rowsFor(captureValue: Readonly<KeywordLexicalMergeCapture>, laneId: LexicalBoundLaneId) {
  return captureValue.candidates.filter((candidate) => candidate.chosen_lane_id === laneId);
}

function rawRow(candidate_key: string, grouped_ordinal: number, lane_index: number) {
  return Object.freeze({
    candidate_key, raw_group_key: -grouped_ordinal, lane_index, grouped_ordinal,
    observation_state: "observed" as const
  });
}

function rawHit(
  lane_id: LexicalBoundLaneId,
  candidateKey: string,
  groupedOrdinal: number,
  captureValue: Readonly<KeywordLexicalMergeCapture>
) {
  const laneIndex = rowsFor(captureValue, lane_id).findIndex(
    (candidate) => candidate.candidate_key === candidateKey
  );
  return Object.freeze({
    lane_id, raw_group_key: -groupedOrdinal,
    grouped_ordinal: groupedOrdinal, lane_index: laneIndex
  });
}

function lanePriority(laneId: LexicalBoundLaneId): 0 | 1 | 2 {
  if (laneId === "exact") return 0;
  return laneId === "porter" || laneId === "object_key_porter" ? 1 : 2;
}
