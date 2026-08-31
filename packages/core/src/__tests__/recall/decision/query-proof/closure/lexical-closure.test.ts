import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeLexicalBoundChannel } from
  "../../../../../recall/decision/query-proof/closure/lexical-bound.js";
import { verifyChannelClosureResult } from
  "../../../../../recall/decision/query-proof/closure/verify.js";
import { createRecallRetrievalFieldBundle } from
  "../../../../../recall/field/retrieval/retrieval-field-bundle.js";
import {
  bindRetrievalFieldBundleReadAuthority,
  readMemoryLexicalIntervalSources,
  verifyLexicalIntervalSourceReceiptV1
} from
  "../../../../../recall/field/retrieval/retrieval-field-source-authority.js";
import { withActiveRecallReadSnapshot } from
  "../../../../../recall/runtime/recall-read-snapshot.js";
import type { KeywordLexicalMergeCapture, KeywordSearchFieldResult } from
  "../../../../../recall/runtime/recall-service-types.js";
import type { PreparedRecallRequest } from
  "../../../../../recall/runtime/recall-service-runner-types.js";
import type { LexicalBoundProducerReceipt } from
  "../../../../../recall/runtime/recall-search-port-types.js";
import { admitLiveLexicalIntervalSources } from
  "../../../../../recall/decision/query-proof/live-query-proof-authority.js";
import {
  authorityFrom,
  capturedLexicalPreparedAuthority,
  cleanup
} from "../../../integration/shadow/live-receipt-fixtures.js";
import { plantProof } from "../adapters/lexical-bound/d1-proof-fixture.js";

let prepared: PreparedRecallRequest;

beforeAll(async () => {
  prepared = await capturedLexicalPreparedAuthority();
});

afterAll(() => cleanup(prepared));

describe("live-source lexical closure", () => {
  it("exact-closes only a live admitted finite lexical universe", async () => {
    const result = await closeIssued(allLaneProof(2));

    expect(result).toMatchObject({
      status: "exact_closed",
      domain_id: "LexDomain:lexical_relaxed",
      source_kind: "live_lexical_interval"
    });
    expect(result?.completeness_refs).toHaveLength(5);
  });

  it("does not promote cap/truncation or list absence", async () => {
    expect((await closeIssued(allLaneProof(1)))?.status).toBe("uncertified");
    expect((await closeIssued(plantProof()))?.status).toBe("uncertified");
  });

  it("does not consume a planted lexical proof without a live source bundle", () => {
    expect(closeLexicalBoundChannel(authorityFrom(prepared))).toBeNull();
  });

  it("rejects source, universe, and principal mutation while real source verifies", async () => {
    await withIssuedSource(allLaneProof(2), (authority) => {
      const result = closeLexicalBoundChannel(authority)!;
      expect(() => verifyChannelClosureResult(result, authority)).not.toThrow();
      expect(closeLexicalBoundChannel(Object.freeze({
        ...authority,
        workspace_id: "workspace-wrong"
      }))).toBeNull();
      expect(closeLexicalBoundChannel(Object.freeze({
        ...authority,
        snapshot_vector: Object.freeze({
          ...authority.snapshot_vector,
          principal: "principal-wrong"
        })
      }))).toBeNull();
      const plantedUniverse = { ...result,
        universe_digest: `sha256:${"9".repeat(64)}`
      };
      expect(() => verifyChannelClosureResult(plantedUniverse, authority))
        .toThrow(/digest mismatch|binding mismatch/u);
    });
  });

  it("rejects source receipt clones and request relabeling", async () => {
    await withIssuedSource(allLaneProof(2), (authority) => {
      const bundle = authority.lexical_source_bundle!;
      const wrongRequest = Object.freeze({
        ...authority,
        expected_lexical_request_pins: authority.expected_lexical_request_pins.map((pin) =>
          Object.freeze({ ...pin, request_digest: `sha256:${"8".repeat(64)}` }))
      });
      expect(closeLexicalBoundChannel(wrongRequest)).toBeNull();
      expect(closeLexicalBoundChannel(Object.freeze({
        ...authority,
        lexical_source_bundle: Object.freeze({ ...bundle })
      }))).toBeNull();
    });
  });
});

async function closeIssued(proof: ReturnType<typeof plantProof>) {
  return await withIssuedSource(proof, (authority) =>
    closeLexicalBoundChannel(authority));
}

async function withIssuedSource<T>(
  proof: ReturnType<typeof plantProof>,
  use: (authority: ReturnType<typeof authorityFrom> & Readonly<{
    lexical_source_bundle: ReturnType<typeof createRecallRetrievalFieldBundle>;
  }>) => T
): Promise<T> {
  if (proof.status !== "captured") throw new Error("captured proof required");
  const receipt = canonicalReceipt(proof.receipt);
  const capture = captureFrom(receipt);
  const matches = receipt.post_merge.map((row) => Object.freeze({
    object_id: row.candidate_key,
    normalized_rank: row.normalized_rank,
    ...(row.trigram_rank === undefined ? {} : { trigram_rank: row.trigram_rank }),
    ...(row.object_key_rank === undefined ? {} : { object_key_rank: row.object_key_rank })
  }));
  const bundle = createRecallRetrievalFieldBundle({
    workspaceId: "workspace-1",
    queryText: "stable",
    memoryRepo: { searchByKeywordField: async () => Object.freeze({
      matches,
      lanes: normalLanes(matches),
      lexical_raw_rank: capture,
      lexical_raw_rank_receipt: receipt
    }) }
  });
  return await withActiveRecallReadSnapshot(snapshotPort(), async (capability) => {
    bindRetrievalFieldBundleReadAuthority(bundle, prepared.snapshotReadLease, capability);
    await bundle.searchMemoryKeyword({
      variant: "lexical_relaxed",
      queryText: "stable",
      limit: receipt.merge_limit,
      scope: {}
    });
    const [issued] = readMemoryLexicalIntervalSources(bundle);
    if (issued === undefined) throw new Error("expected issued lexical source");
    verifyLexicalIntervalSourceReceiptV1(issued, {
      bundle,
      lease: prepared.snapshotReadLease
    });
    const authority = Object.freeze({
      ...authorityFrom(prepared),
      lexical_source_bundle: bundle,
      expected_lexical_request_pins: [Object.freeze({
        workspace_id: "workspace-1",
        request_digest: issued.request_digest,
        field_prefix: "lexical_relaxed" as const,
        candidate_key_domain: "memory_object_id" as const
      })]
    });
    const replayed = readMemoryLexicalIntervalSources(bundle);
    if (admitLiveLexicalIntervalSources(authority, replayed) === undefined) {
      throw new Error("expected live lexical source admission");
    }
    return use(authority);
  });
}

function canonicalReceipt(receipt: LexicalBoundProducerReceipt): LexicalBoundProducerReceipt {
  const order = new Map([
    ["exact", 0], ["porter", 1], ["object_key_porter", 2],
    ["trigram", 3], ["object_key_trigram", 4]
  ]);
  const lanes = [...receipt.lanes].sort((left, right) =>
    order.get(left.lane_id)! - order.get(right.lane_id)!);
  const candidates = receipt.candidates.map((candidate) => {
    const hits = [...candidate.lane_hits].sort((left, right) =>
      order.get(left.lane_id)! - order.get(right.lane_id)!);
    return Object.freeze({
      ...candidate,
      lane_hits: Object.freeze(hits),
      discarded_lane_ids: Object.freeze(hits.map(({ lane_id }) => lane_id)
        .filter((laneId) => laneId !== candidate.chosen_lane_id))
    });
  });
  return Object.freeze({
    ...receipt,
    lanes: Object.freeze(lanes),
    candidates: Object.freeze(candidates),
    post_merge: Object.freeze(receipt.post_merge.map((row) => Object.freeze({
      ...row,
      ...optionalRank(lanes, row.candidate_key, ["trigram"], "trigram_rank"),
      ...optionalRank(lanes, row.candidate_key,
        ["object_key_porter", "object_key_trigram"], "object_key_rank")
    })))
  });
}

function optionalRank(
  lanes: readonly LexicalBoundProducerReceipt["lanes"][number][],
  candidateKey: string,
  laneIds: readonly string[],
  field: "trigram_rank" | "object_key_rank"
) {
  const ranks = lanes.filter(({ lane_id }) => laneIds.includes(lane_id))
    .flatMap(({ rows }) => rows.filter(({ candidate_key }) =>
      candidate_key === candidateKey).map(({ grouped_ordinal }) => grouped_ordinal));
  return ranks.length === 0 ? {} : { [field]: Math.max(...ranks) };
}

function allLaneProof(limit: number) {
  const lane = { rows: [{ key: "candidate-a", ordinal: 1 }], limit,
    universeKeys: ["candidate-a"] };
  return plantProof({ lanes: {
    exact: lane,
    porter: lane,
    object_key_porter: lane,
    trigram: lane,
    object_key_trigram: lane
  }});
}

function captureFrom(
  receipt: LexicalBoundProducerReceipt
): Readonly<KeywordLexicalMergeCapture> {
  return Object.freeze({
    query_run_id: receipt.query_run_id,
    merge_limit: receipt.merge_limit,
    lanes: Object.freeze(receipt.lanes.map((lane) => Object.freeze({
      lane_id: lane.lane_id,
      raw_key_kind: lane.raw_key_kind,
      list_n: lane.list_n,
      status: lane.status
    }))),
    candidates: Object.freeze(receipt.candidates.map((candidate) => Object.freeze({
      candidate_key: candidate.candidate_key,
      admitted: candidate.admitted,
      chosen_lane_id: candidate.chosen_lane_id,
      chosen_normalized_rank: candidate.chosen_normalized_rank
    })))
  });
}

function normalLanes(matches: Readonly<KeywordSearchFieldResult>["matches"]) {
  const observations = matches.map((value, index) => Object.freeze({
    ...value,
    rank: index + 1
  }));
  return Object.freeze([
    normalLane("exact", observations),
    normalLane("porter", observations),
    normalLane("trigram", observations)
  ]);
}

function normalLane(
  lane: "exact" | "porter" | "trigram",
  observations: readonly Readonly<{
    readonly object_id: string;
    readonly normalized_rank: number;
    readonly rank: number;
  }>[]
) {
  return Object.freeze({
    lane,
    status: "complete" as const,
    depth: observations.length,
    observations: Object.freeze([...observations]),
    unseen_upper_bound: 0
  });
}

function snapshotPort() {
  return { beginDeferred() {}, commit() {}, rollback() {} };
}
