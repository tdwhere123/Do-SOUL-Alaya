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
import { compileCanonicalQueryCompilation } from
  "../../../../../recall/query/canonical-query/index.js";
import {
  createSnapshotCoherenceReceiptV1,
  createSnapshotVectorV1,
  finalizePreparedSnapshotReadLease
} from "../../../../../recall/runtime/snapshot-coherence/index.js";
import type { LexicalBoundProducerReceipt } from
  "../../../../../recall/runtime/recall-search-port-types.js";
import {
  freezeLexicalBoundProof,
  sealLexicalBoundProof,
  type LexicalBoundProofCaptured
} from "../../../../../recall/runtime/diagnostics/lexical-bound-proof.js";
import { admitLiveLexicalIntervalSources } from
  "../../../../../recall/decision/query-proof/live-query-proof-authority.js";
import {
  authorityFrom,
  stubMemoryRepo
} from "../../../integration/shadow/live-receipt-fixtures.js";
import {
  D1_REQUEST,
  D1_SNAPSHOT,
  plantProof
} from "../adapters/lexical-bound/d1-proof-fixture.js";
import {
  receiptWithUniverses,
  universeWitness
} from "../../../runtime/diagnostics/lexical-lane-universe-fixture.js";

type IssuedLexicalAuthority = ReturnType<typeof authorityFrom> & Readonly<{
  lexical_source_bundle: ReturnType<typeof createRecallRetrievalFieldBundle>;
}>;

export async function withIssuedSource<T>(
  prepared: PreparedRecallRequest,
  proof: ReturnType<typeof plantProof>,
  use: (authority: IssuedLexicalAuthority) => T
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
    memoryRepo: stubMemoryRepo(async () => Object.freeze({
      matches,
      lanes: normalLanes(matches),
      lexical_raw_rank: capture,
      lexical_raw_rank_receipt: receipt
    }))
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
    if (admitLiveLexicalIntervalSources(
      authority,
      readMemoryLexicalIntervalSources(bundle)
    ) === undefined) {
      throw new Error("expected live lexical source admission");
    }
    return use(authority);
  });
}

export function boundedLexicalAuthority(
  source: PreparedRecallRequest
): PreparedRecallRequest {
  const { schema_version: _schemaVersion, vector_digest: _vectorDigest, ...input } =
    source.snapshotVector;
  const snapshotVector = createSnapshotVectorV1({
    ...input,
    retrieval_channel_snapshots: Object.freeze(
      source.snapshotVector.retrieval_channel_snapshots.map((declaration) =>
        declaration.source_owner === "lexical_relaxed"
          ? Object.freeze({
              ...declaration,
              source_frontier: "lexical-frontier:test-bounded",
              generation: "lexical-generation:test-bounded",
              lag_bound: Object.freeze({
                kind: "bounded" as const,
                remaining_effect: Object.freeze({
                  source_owner: "lexical_relaxed",
                  effect_id: "lexical-lag:test-bounded"
                })
              })
            })
          : declaration)
    )
  });
  const snapshotCoherenceReceipt = createSnapshotCoherenceReceiptV1(snapshotVector);
  return Object.freeze({
    ...source,
    snapshotVector,
    snapshotCoherenceReceipt,
    snapshotReadLease: finalizePreparedSnapshotReadLease(snapshotVector),
    canonicalQueryCompilation: compileCanonicalQueryCompilation(
      source.canonicalQueryEvidence,
      snapshotCoherenceReceipt
    )
  });
}

export function allLaneProof(limit: number) {
  const lane = {
    rows: [{ key: "candidate-a", ordinal: 1 }],
    limit,
    universeKeys: ["candidate-a"]
  };
  return plantProof({ lanes: {
    exact: lane,
    porter: lane,
    object_key_porter: lane,
    trigram: lane,
    object_key_trigram: lane
  }});
}

export function mixedLaneProof() {
  const complete = {
    rows: [{ key: "candidate-a", ordinal: 1 }],
    limit: 2,
    universeKeys: ["candidate-a"]
  };
  return plantProof({ lanes: {
    exact: complete,
    porter: {
      rows: [
        { key: "candidate-a", ordinal: 1 },
        { key: "candidate-b", ordinal: 0.5 }
      ],
      limit: 2,
      universeKeys: ["candidate-a", "candidate-b"]
    },
    object_key_porter: complete,
    trigram: complete,
    object_key_trigram: complete
  }});
}

export function emptyCompleteLexicalProof(): LexicalBoundProofCaptured {
  const planted = plantProof({ lanes: emptyLanePlants() });
  const receipt = receiptWithUniverses(Object.freeze({
    ...planted.receipt,
    merge_limit: 2,
    lanes: Object.freeze(planted.receipt.lanes.map((lane) => Object.freeze({
      ...lane,
      list_n: 0,
      requested_limit: 2,
      status: "empty" as const,
      rows: Object.freeze([]),
      unseen_upper_bound: 0
    }))),
    candidates: Object.freeze([]),
    post_merge: Object.freeze([])
  }), (lane) => universeWitness({
    laneId: lane.lane_id,
    candidateKeys: [],
    tokensRouted: true,
    workspaceId: "workspace-1"
  }));
  const frozen = freezeLexicalBoundProof(receipt);
  if (frozen === undefined || frozen.status !== "captured") {
    throw new Error("expected captured empty lexical proof");
  }
  const sealed = sealLexicalBoundProof(frozen, {
    request_digest: D1_REQUEST,
    snapshot_digest: D1_SNAPSHOT,
    workspace_id: "workspace-1",
    field_prefix: "lexical_relaxed",
    candidate_key_domain: "memory_object_id"
  });
  if (sealed.status !== "captured") throw new Error("expected sealed empty lexical proof");
  return sealed;
}

function emptyLanePlants() {
  const lane = { rows: Object.freeze([]), limit: 2, universeKeys: Object.freeze([]) };
  return {
    exact: lane,
    porter: lane,
    object_key_porter: lane,
    trigram: lane,
    object_key_trigram: lane
  };
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
