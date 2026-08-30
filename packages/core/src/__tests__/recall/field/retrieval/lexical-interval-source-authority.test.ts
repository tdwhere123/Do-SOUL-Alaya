import { describe, expect, it, vi } from "vitest";
import { createRecallRetrievalFieldBundle } from
  "../../../../recall/field/retrieval/retrieval-field-bundle.js";
import {
  createLexicalIntervalSourceReceiptIntegrityV1,
  verifyLexicalIntervalSourceReceiptIntegrityV1
} from
  "../../../../recall/field/retrieval/lexical-interval-source-receipt.js";
import {
  bindRetrievalFieldBundleReadAuthority,
  readMemoryLexicalIntervalSources,
  verifyLexicalIntervalSourceReceiptV1
} from "../../../../recall/field/retrieval/retrieval-field-source-authority.js";
import { withActiveRecallReadSnapshot } from
  "../../../../recall/runtime/recall-read-snapshot.js";
import { admitLiveLexicalIntervalSources } from
  "../../../../recall/runtime/query/live-query-proof-authority.js";
import {
  authorityFrom,
  capturedLexicalPreparedAuthority,
  cleanup,
  preparedAuthority
} from "../../shadow/live-receipt-fixtures.js";

describe("lexical interval source authority", () => {
  it("issues only inside an active physical read and rejects a clone", async () => {
    const prepared = await capturedLexicalPreparedAuthority();
    const search = vi.fn(async () => fieldResult());
    const bundle = createRecallRetrievalFieldBundle({
      workspaceId: "workspace-1", queryText: "stable",
      memoryRepo: { searchByKeywordField: search }
    });
    let source: ReturnType<typeof readMemoryLexicalIntervalSources>[number] | undefined;
    await withActiveRecallReadSnapshot(snapshotPort(), async (capability) => {
      bindRetrievalFieldBundleReadAuthority(bundle, prepared.snapshotReadLease, capability);
      await bundle.searchMemoryKeyword({
        variant: "lexical_relaxed", queryText: "stable", limit: 1, scope: {}
      });
      [source] = readMemoryLexicalIntervalSources(bundle);
      expect(source?.status).toBe("captured");
      expect(() => verifyLexicalIntervalSourceReceiptV1(source!)).not.toThrow();
      expect(admitLiveLexicalIntervalSources(
        authorityFor(prepared, source!, bundle), [source!]
      )).toEqual([source]);
      expect(() => verifyLexicalIntervalSourceReceiptV1({ ...source! }))
        .toThrow(/issued source authority/u);
    });
    expect(readMemoryLexicalIntervalSources(bundle)).toEqual([]);
    expect(() => verifyLexicalIntervalSourceReceiptV1(source!))
      .toThrow(/active source authority/u);
    expect(admitLiveLexicalIntervalSources(
      authorityFor(prepared, source!, bundle), [source!]
    )).toBeUndefined();
    expect(search.mock.calls).toEqual([["workspace-1", "stable", 1, {}]]);
    expect("memoryLexicalIntervalSourcesForSnapshot" in bundle).toBe(false);
    cleanup(prepared);
  });

  it("does not transfer requested-view authority to the maximum view", async () => {
    const prepared = await capturedLexicalPreparedAuthority();
    const requested = createRecallRetrievalFieldBundle({
      workspaceId: "workspace-1", queryText: "stable",
      memoryRepo: { searchByKeywordField: async () => fieldResult() }
    });
    const maximum = requested.forObservationView("maximum");
    await withActiveRecallReadSnapshot(snapshotPort(), async (capability) => {
      bindRetrievalFieldBundleReadAuthority(
        requested, prepared.snapshotReadLease, capability
      );
      await requested.searchMemoryKeyword({
        variant: "lexical_relaxed", queryText: "stable", limit: 1, scope: {}
      });
      expect(readMemoryLexicalIntervalSources(requested)).toHaveLength(1);
      expect(readMemoryLexicalIntervalSources(maximum)).toEqual([]);
    });
    cleanup(prepared);
  });

  it("does not transfer maximum-view authority to the requested view", async () => {
    const prepared = await capturedLexicalPreparedAuthority();
    const requested = createRecallRetrievalFieldBundle({
      workspaceId: "workspace-1", queryText: "stable",
      memoryRepo: { searchByKeywordField: async () => fieldResult() }
    });
    const maximum = requested.forObservationView("maximum");
    await withActiveRecallReadSnapshot(snapshotPort(), async (capability) => {
      bindRetrievalFieldBundleReadAuthority(
        maximum, prepared.snapshotReadLease, capability
      );
      await maximum.searchMemoryKeyword({
        variant: "lexical_relaxed", queryText: "stable", limit: 1, scope: {}
      });
      expect(readMemoryLexicalIntervalSources(maximum)).toHaveLength(1);
      expect(readMemoryLexicalIntervalSources(requested)).toEqual([]);
    });
    cleanup(prepared);
  });

  it("does not grant authority to a bundle object clone", async () => {
    const prepared = await capturedLexicalPreparedAuthority();
    const bundle = createRecallRetrievalFieldBundle({
      workspaceId: "workspace-1", queryText: "stable",
      memoryRepo: { searchByKeywordField: async () => fieldResult() }
    });
    const clone = Object.freeze({ ...bundle });
    await withActiveRecallReadSnapshot(snapshotPort(), async (capability) => {
      bindRetrievalFieldBundleReadAuthority(bundle, prepared.snapshotReadLease, capability);
      await bundle.searchMemoryKeyword({
        variant: "lexical_relaxed", queryText: "stable", limit: 1, scope: {}
      });
      expect(readMemoryLexicalIntervalSources(bundle)).toHaveLength(1);
      expect(readMemoryLexicalIntervalSources(clone)).toEqual([]);
      expect(() => bindRetrievalFieldBundleReadAuthority(
        clone, prepared.snapshotReadLease, capability
      )).toThrow(/authority is missing/u);
    });
    cleanup(prepared);
  });

  it("rejects a genuine receipt after rollback revokes its issuer", async () => {
    const prepared = await capturedLexicalPreparedAuthority();
    const bundle = createRecallRetrievalFieldBundle({
      workspaceId: "workspace-1", queryText: "stable",
      memoryRepo: { searchByKeywordField: async () => fieldResult() }
    });
    let source: ReturnType<typeof readMemoryLexicalIntervalSources>[number] | undefined;
    await expect(withActiveRecallReadSnapshot(snapshotPort(), async (capability) => {
      bindRetrievalFieldBundleReadAuthority(bundle, prepared.snapshotReadLease, capability);
      await bundle.searchMemoryKeyword({
        variant: "lexical_relaxed", queryText: "stable", limit: 1, scope: {}
      });
      [source] = readMemoryLexicalIntervalSources(bundle);
      expect(() => verifyLexicalIntervalSourceReceiptV1(source!)).not.toThrow();
      expect(admitLiveLexicalIntervalSources(
        authorityFor(prepared, source!, bundle), [source!]
      )).toEqual([source]);
      throw new Error("rollback");
    })).rejects.toThrow("rollback");

    expect(() => verifyLexicalIntervalSourceReceiptV1(source!))
      .toThrow(/active source authority/u);
    expect(admitLiveLexicalIntervalSources(
      authorityFor(prepared, source!, bundle), [source!]
    )).toBeUndefined();
    cleanup(prepared);
  });

  it("does not relabel a read made before binding", async () => {
    const prepared = await capturedLexicalPreparedAuthority();
    const bundle = createRecallRetrievalFieldBundle({
      workspaceId: "workspace-1", queryText: "stable",
      memoryRepo: { searchByKeywordField: async () => fieldResult() }
    });
    await bundle.searchMemoryKeyword({
      variant: "lexical_relaxed", queryText: "stable", limit: 1, scope: {}
    });
    await withActiveRecallReadSnapshot(snapshotPort(), async (capability) => {
      bindRetrievalFieldBundleReadAuthority(bundle, prepared.snapshotReadLease, capability);
      await bundle.searchMemoryKeyword({
        variant: "lexical_relaxed", queryText: "stable", limit: 1, scope: {}
      });
      expect(readMemoryLexicalIntervalSources(bundle)).toEqual([]);
    });
    cleanup(prepared);
  });

  it("rejects a self-consistent current-snapshot fabrication", async () => {
    const prepared = await preparedAuthority();
    const fabricated = createLexicalIntervalSourceReceiptIntegrityV1({
      workspace_id: "workspace-1",
      request_digest: `sha256:${"a".repeat(64)}`,
      snapshot_digest: prepared.snapshotVector.vector_digest,
      field_prefix: "lexical_relaxed",
      requested_depth: 1,
      result: fieldResult()
    });

    expect(() => verifyLexicalIntervalSourceReceiptV1(fabricated))
      .toThrow(/issued source authority/u);
    cleanup(prepared);
  });

  it("rejects missing, counterfeit, and revoked physical-read capabilities", async () => {
    const prepared = await preparedAuthority();
    const bundle = createRecallRetrievalFieldBundle({
      workspaceId: "workspace-1", queryText: "stable",
      memoryRepo: { searchByKeywordField: async () => fieldResult() }
    });
    expect(() => bindRetrievalFieldBundleReadAuthority(
      bundle, prepared.snapshotReadLease, undefined
    )).toThrow(/active physical/u);
    expect(() => bindRetrievalFieldBundleReadAuthority(
      bundle, prepared.snapshotReadLease, Object.freeze({}) as never
    )).toThrow(/active physical/u);

    let revoked: Parameters<typeof bindRetrievalFieldBundleReadAuthority>[2];
    await withActiveRecallReadSnapshot(snapshotPort(), async (capability) => {
      revoked = capability;
    });
    expect(() => bindRetrievalFieldBundleReadAuthority(
      bundle, prepared.snapshotReadLease, revoked
    )).toThrow(/active physical/u);
    cleanup(prepared);
  });

  it("does not issue from the normal unavailable lexical declaration", async () => {
    const prepared = await preparedAuthority();
    const bundle = createRecallRetrievalFieldBundle({
      workspaceId: "workspace-1", queryText: "stable",
      memoryRepo: { searchByKeywordField: async () => fieldResult() }
    });
    await withActiveRecallReadSnapshot(snapshotPort(), async (capability) => {
      bindRetrievalFieldBundleReadAuthority(bundle, prepared.snapshotReadLease, capability);
      await bundle.searchMemoryKeyword({
        variant: "lexical_relaxed", queryText: "stable", limit: 1, scope: {}
      });
      expect(readMemoryLexicalIntervalSources(bundle)).toEqual([]);
    });
    cleanup(prepared);
  });

  it("does not issue when the lexical lease capability is missing", async () => {
    const prepared = await capturedLexicalPreparedAuthority();
    const bundle = createRecallRetrievalFieldBundle({
      workspaceId: "workspace-1", queryText: "stable",
      memoryRepo: { searchByKeywordField: async () => fieldResult() }
    });
    const lease = Object.freeze({
      ...prepared.snapshotReadLease,
      capabilities: prepared.snapshotReadLease.capabilities.filter(
        ({ source_owner }) => source_owner !== "lexical_relaxed"
      )
    });
    await withActiveRecallReadSnapshot(snapshotPort(), async (capability) => {
      bindRetrievalFieldBundleReadAuthority(bundle, lease, capability);
      await bundle.searchMemoryKeyword({
        variant: "lexical_relaxed", queryText: "stable", limit: 1, scope: {}
      });
      expect(readMemoryLexicalIntervalSources(bundle)).toEqual([]);
    });
    cleanup(prepared);
  });

  it("never authenticates missing-port or failed synthetic results", async () => {
    const prepared = await capturedLexicalPreparedAuthority();
    const missing = createRecallRetrievalFieldBundle({
      workspaceId: "workspace-1", queryText: "stable", memoryRepo: {}
    });
    const failed = createRecallRetrievalFieldBundle({
      workspaceId: "workspace-1", queryText: "stable",
      memoryRepo: { searchByKeywordField: async () => { throw new Error("failed"); } }
    });
    await withActiveRecallReadSnapshot(snapshotPort(), async (capability) => {
      bindRetrievalFieldBundleReadAuthority(missing, prepared.snapshotReadLease, capability);
      bindRetrievalFieldBundleReadAuthority(failed, prepared.snapshotReadLease, capability);
      await missing.searchMemoryKeyword({
        variant: "lexical_relaxed", queryText: "stable", limit: 1, scope: {}
      });
      await expect(failed.searchMemoryKeyword({
        variant: "lexical_relaxed", queryText: "stable", limit: 1, scope: {}
      })).rejects.toThrow("failed");
      expect(readMemoryLexicalIntervalSources(missing)).toEqual([]);
      expect(readMemoryLexicalIntervalSources(failed)).toEqual([]);
    });
    cleanup(prepared);
  });
});

function snapshotPort() {
  return { beginDeferred() {}, commit() {}, rollback() {} };
}

function authorityFor(
  prepared: Awaited<ReturnType<typeof preparedAuthority>>,
  source: ReturnType<typeof readMemoryLexicalIntervalSources>[number],
  bundle: ReturnType<typeof createRecallRetrievalFieldBundle>
) {
  return Object.freeze({
    ...authorityFrom(prepared),
    lexical_source_bundle: bundle,
    expected_lexical_request_pins: [Object.freeze({
      workspace_id: source.workspace_id,
      request_digest: source.request_digest,
      field_prefix: source.field_prefix,
      candidate_key_domain: source.candidate_key_domain
    })]
  });
}

function fieldResult() {
  return Object.freeze({
    matches: Object.freeze([{ object_id: "hit", normalized_rank: 1 }]),
    lanes: Object.freeze([
      fieldLane("exact", "ineligible", []),
      fieldLane("porter", "complete", [
        { object_id: "hit", normalized_rank: 1, rank: 1 }
      ]),
      fieldLane("trigram", "ineligible", [])
    ]),
    lexical_raw_rank: Object.freeze({
      query_run_id: "memory.keyword.depth:1", merge_limit: 1,
      lanes: Object.freeze([
        lane("exact", "matched_token_count", "empty"),
        lane("porter", "bm25_raw_rank", "truncated", 1),
        lane("object_key_porter", "bm25_raw_rank", "empty"),
        lane("trigram", "bm25_raw_rank", "empty"),
        lane("object_key_trigram", "bm25_raw_rank", "empty")
      ]),
      candidates: Object.freeze([Object.freeze({
        candidate_key: "hit", chosen_lane_id: "porter" as const,
        chosen_normalized_rank: 1, admitted: true
      })])
    }),
    lexical_raw_rank_receipt: rawRankReceipt()
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
    lane, status, depth: observations.length,
    observations: Object.freeze([...observations]),
    unseen_upper_bound: status === "complete" ? 0 : null
  });
}

function lane(
  lane_id: "exact" | "porter" | "object_key_porter" | "trigram" | "object_key_trigram",
  raw_key_kind: "matched_token_count" | "bm25_raw_rank",
  status: "empty" | "complete" | "truncated",
  list_n = 0
) {
  return Object.freeze({ lane_id, raw_key_kind, status, list_n });
}

function rawRankReceipt() {
  const observed = Object.freeze({
    candidate_key: "hit", raw_group_key: -1, lane_index: 0,
    grouped_ordinal: 1, observation_state: "observed" as const
  });
  return Object.freeze({
    schema_version: 1 as const,
    receipt_id: "alaya.recall.x0.lexical-raw-rank.v1" as const,
    producer_id: "alaya.storage.mergeKeywordSearchRows.v1" as const,
    query_run_id: "memory.keyword.depth:1",
    merge_limit: 1,
    lanes: Object.freeze([
      rawLane("exact", "matched_token_count", 0, []),
      rawLane("porter", "bm25_raw_rank", 1, [observed]),
      rawLane("object_key_porter", "bm25_raw_rank", 1, []),
      rawLane("trigram", "bm25_raw_rank", 2, []),
      rawLane("object_key_trigram", "bm25_raw_rank", 2, [])
    ]),
    candidates: Object.freeze([Object.freeze({
      candidate_key: "hit",
      lane_hits: Object.freeze([Object.freeze({
        lane_id: "porter" as const, raw_group_key: -1,
        grouped_ordinal: 1, lane_index: 0
      })]),
      admitted: true,
      chosen_lane_id: "porter" as const,
      chosen_normalized_rank: 1,
      post_merge_index: 0,
      discarded_lane_ids: Object.freeze([])
    })]),
    post_merge: Object.freeze([Object.freeze({
      candidate_key: "hit", normalized_rank: 1
    })])
  });
}

function rawLane(
  lane_id: "exact" | "porter" | "object_key_porter" | "trigram" | "object_key_trigram",
  raw_key_kind: "matched_token_count" | "bm25_raw_rank",
  source_priority: 0 | 1 | 2,
  rows: readonly Readonly<{
    readonly candidate_key: string;
    readonly raw_group_key: number;
    readonly lane_index: number;
    readonly grouped_ordinal: number;
    readonly observation_state: "observed";
  }>[],
  requested_limit = 1
) {
  const status = rows.length === 0 ? "empty" as const
    : rows.length >= requested_limit ? "truncated" as const : "complete" as const;
  return Object.freeze({
    lane_id, raw_key_kind, source_priority,
    applicability_source: "memory_fts_lane" as const,
    list_n: rows.length, requested_limit, status, rows: Object.freeze(rows),
    unseen_upper_bound: status === "empty" ? 0 : rows.at(-1)!.grouped_ordinal
  });
}
