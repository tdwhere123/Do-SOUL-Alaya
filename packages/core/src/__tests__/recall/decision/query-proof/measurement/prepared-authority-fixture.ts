import { compareCodeUnits } from "@do-soul/alaya-protocol";
import { buildDefaultPolicy } from
  "../../../../../recall/runtime/orchestration.js";
import { createSeededTestOnlyInMemoryFieldQuerySession } from
  "../../../../../recall/runtime/query/field-query-session.js";
import { prepareRecallRequest } from
  "../../../../../recall/runtime/query/prepare-recall-request.js";
import { captureRecallRequestTime } from
  "../../../../../recall/runtime/query/recall-request-time.js";
import {
  createSnapshotCoherenceReceiptV1,
  createSnapshotVectorV1,
  finalizePreparedSnapshotReadLease
} from "../../../../../recall/runtime/snapshot-coherence/index.js";
import type { PreparedRecallRequest } from
  "../../../../../recall/runtime/recall-service-runner-types.js";
import type { PreparedMeasurementAuthorityEvidenceV1 } from
  "../../../../../recall/decision/query-proof/measurement/index.js";
import {
  verifyLexicalMeasurementPreparedAuthorityV1,
  type VerifiedMeasurementAuthorityV1
} from "../../../../../recall/decision/query-proof/measurement/index.js";
import { createRecallRetrievalFieldBundle } from
  "../../../../../recall/field/retrieval/retrieval-field-bundle.js";
import type { LexicalIntervalSourceReceiptV1 } from
  "../../../../../recall/field/retrieval/lexical-interval-source-receipt.js";
import {
  bindRetrievalFieldBundleReadAuthority,
  readMemoryLexicalIntervalSources
} from "../../../../../recall/field/retrieval/retrieval-field-source-authority.js";
import { withActiveRecallReadSnapshot } from
  "../../../../../recall/runtime/recall-read-snapshot.js";
import type { RecallReadSnapshotPort } from
  "../../../../../recall/runtime/recall-read-snapshot.js";
import { fieldContractSha256 } from "../../../../../shared/field-hash.js";
import { compileCanonicalQueryCompilation } from
  "../../../../../recall/query/canonical-query/index.js";
import { createDependencies, createTaskSurface } from
  "../../../recall-service-test-fixtures.js";
import type { RecallServiceMemoryRepoPort } from
  "../../../../../recall/runtime/recall-service-types.js";

const NOW = "2026-08-29T00:00:00.000Z";

export async function prepareMeasurementEvidenceFixture(
  now: string = NOW
): Promise<PreparedRecallRequest> {
  const { dependencies } = createDependencies([]);
  const prepared = await prepareRecallRequest({
    dependencies,
    warn: () => undefined,
    now: () => now,
    buildDefaultPolicy: () => buildDefaultPolicy({
      strategy: "analyze",
      taskSurfaceRef: createTaskSurface().runtime_id,
      now: () => now,
      generateRuntimeId: () => "33333333-3333-4333-8333-333333333333"
    }),
    fieldQuerySession: createSeededTestOnlyInMemoryFieldQuerySession(
      fieldContractSha256,
      "workspace-1"
    ),
    sha256: fieldContractSha256
  }, {
    taskSurface: createTaskSurface(),
    workspaceId: "workspace-1",
    strategy: "analyze"
  }, captureRecallRequestTime({ now: () => now }));
  const lexical = prepared.snapshotVector.retrieval_channel_snapshots.find(
    ({ source_owner }) => source_owner === "lexical_relaxed"
  );
  if (lexical === undefined) throw new Error("lexical declaration missing");
  const { schema_version: _schema, vector_digest: _digest, ...vectorInput } =
    prepared.snapshotVector;
  const snapshotVector = createSnapshotVectorV1({
    ...vectorInput,
    retrieval_channel_snapshots: Object.freeze(
      prepared.snapshotVector.retrieval_channel_snapshots.map((declaration) =>
        declaration.source_owner === lexical.source_owner
          ? Object.freeze({
              ...declaration,
              source_frontier: "lexical-frontier:measurement-fixture",
              generation: "lexical-generation:measurement-fixture",
              lag_bound: Object.freeze({ kind: "exact" as const })
            })
          : declaration)
    )
  });
  const snapshotCoherenceReceipt = createSnapshotCoherenceReceiptV1(snapshotVector);
  return Object.freeze({
    ...prepared,
    snapshotVector,
    snapshotCoherenceReceipt,
    snapshotReadLease: finalizePreparedSnapshotReadLease(snapshotVector),
    canonicalQueryCompilation: compileCanonicalQueryCompilation(
      prepared.canonicalQueryEvidence,
      snapshotCoherenceReceipt
    )
  });
}

export function measurementEvidence(
  prepared: PreparedRecallRequest,
  _lexical = false
): PreparedMeasurementAuthorityEvidenceV1 {
  return Object.freeze({
    workspace_id: "workspace-1",
    query_condition: prepared.queryCondition,
    canonical_query_evidence: prepared.canonicalQueryEvidence,
    canonical_query_compilation: prepared.canonicalQueryCompilation,
    snapshot_vector: prepared.snapshotVector,
    snapshot_coherence_receipt: prepared.snapshotCoherenceReceipt,
    snapshot_read_lease: prepared.snapshotReadLease
  });
}

export async function prepareLexicalMeasurementAuthorityFixture(
  prepared: PreparedRecallRequest,
  evidence: PreparedMeasurementAuthorityEvidenceV1 = measurementEvidence(prepared)
): Promise<VerifiedMeasurementAuthorityV1> {
  const result = Object.freeze({
    matches: Object.freeze([]),
    lanes: Object.freeze([
      normalLane("exact"),
      normalLane("porter"),
      normalLane("trigram")
    ]),
    lexical_raw_rank: Object.freeze({
      query_run_id: "measurement-authority-fixture",
      merge_limit: 2,
      lanes: Object.freeze([
        lexicalLane("exact", "matched_token_count"),
        lexicalLane("porter", "bm25_raw_rank"),
        lexicalLane("object_key_porter", "bm25_raw_rank"),
        lexicalLane("trigram", "bm25_raw_rank"),
        lexicalLane("object_key_trigram", "bm25_raw_rank")
      ]),
      candidates: Object.freeze([])
    })
  });
  const bundle = createRecallRetrievalFieldBundle({
    workspaceId: evidence.workspace_id,
    queryText: "measurement authority fixture",
    memoryRepo: memoryRepo(async () => result)
  });
  return await withActiveRecallReadSnapshot(snapshotPort(), async (capability) => {
    bindRetrievalFieldBundleReadAuthority(bundle, evidence.snapshot_read_lease, capability);
    await bundle.searchMemoryKeyword({
      variant: "lexical_relaxed",
      queryText: "measurement authority fixture",
      limit: 2,
      scope: {}
    });
    const [source] = readMemoryLexicalIntervalSources(bundle);
    const [pin] = bundle.memoryLexicalRequestPins();
    if (source === undefined || pin === undefined) {
      throw new Error("issued lexical measurement fixture source is unavailable");
    }
    return verifyLexicalMeasurementPreparedAuthorityV1({
      evidence: {
        ...evidence,
        lexical_request_pin: pin,
        lexical_source_receipt: source,
        lexical_source_bundle: bundle
      }
    });
  });
}

export async function withCapturedLexicalMeasurementAuthorityFixture<T>(
  prepared: PreparedRecallRequest,
  candidates: readonly Readonly<{
    readonly candidate_key: string;
    readonly normalized_rank: number;
  }>[],
  work: (
    authority: VerifiedMeasurementAuthorityV1,
    source: LexicalIntervalSourceReceiptV1,
    bundle: ReturnType<typeof createRecallRetrievalFieldBundle>
  ) => Promise<T> | T,
  snapshot: RecallReadSnapshotPort = snapshotPort(),
  evidence: PreparedMeasurementAuthorityEvidenceV1 = measurementEvidence(prepared)
): Promise<T> {
  const limit = Math.max(2, candidates.length);
  const exact = exactProducerFixture(candidates, limit);
  const matches = exact.matches;
  const observations = Object.freeze(matches.map((candidate, index) => Object.freeze({
    ...candidate,
    rank: index + 1
  })));
  const result = Object.freeze({
    matches,
    lanes: Object.freeze([
      populatedNormalLane("exact", observations),
      normalLane("porter"),
      normalLane("trigram")
    ]),
    lexical_raw_rank: Object.freeze({
      query_run_id: "measurement-authority-captured-fixture",
      merge_limit: limit,
      lanes: Object.freeze([
        populatedLexicalLane("exact", "matched_token_count", candidates.length, limit),
        lexicalLane("porter", "bm25_raw_rank"),
        lexicalLane("object_key_porter", "bm25_raw_rank"),
        lexicalLane("trigram", "bm25_raw_rank"),
        lexicalLane("object_key_trigram", "bm25_raw_rank")
      ]),
      candidates: Object.freeze(exact.candidates.map((candidate) => Object.freeze({
        candidate_key: candidate.candidate_key,
        admitted: true,
        chosen_lane_id: "exact" as const,
        chosen_normalized_rank: candidate.grouped_ordinal
      })))
    }),
    lexical_raw_rank_receipt: exact.receipt
  });
  const bundle = createRecallRetrievalFieldBundle({
    workspaceId: "workspace-1",
    queryText: "measurement authority captured fixture",
    memoryRepo: memoryRepo(async () => result)
  });
  return await withActiveRecallReadSnapshot(snapshot, async (capability) => {
    bindRetrievalFieldBundleReadAuthority(bundle, prepared.snapshotReadLease, capability);
    await bundle.searchMemoryKeyword({
      variant: "lexical_relaxed",
      queryText: "measurement authority captured fixture",
      limit,
      scope: {}
    });
    const [source] = readMemoryLexicalIntervalSources(bundle);
    const [pin] = bundle.memoryLexicalRequestPins();
    if (source === undefined || pin === undefined) {
      throw new Error("captured lexical measurement fixture source is unavailable");
    }
    const authority = verifyLexicalMeasurementPreparedAuthorityV1({
      evidence: {
        ...evidence,
        lexical_request_pin: pin,
        lexical_source_receipt: source,
        lexical_source_bundle: bundle
      }
    });
    return await work(authority, source, bundle);
  });
}

function lexicalLane(
  lane_id: "exact" | "porter" | "object_key_porter" | "trigram" | "object_key_trigram",
  raw_key_kind: "matched_token_count" | "bm25_raw_rank"
) {
  return Object.freeze({
    lane_id,
    raw_key_kind,
    list_n: 0,
    status: "empty" as const
  });
}

function normalLane(lane: "exact" | "porter" | "trigram") {
  return Object.freeze({
    lane,
    status: "ineligible" as const,
    depth: 0,
    observations: Object.freeze([]),
    unseen_upper_bound: null
  });
}

function populatedNormalLane(
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
    observations,
    unseen_upper_bound: 0
  });
}

function populatedLexicalLane(
  lane_id: "exact",
  raw_key_kind: "matched_token_count",
  list_n: number,
  mergeLimit: number
) {
  return Object.freeze({
    lane_id,
    raw_key_kind,
    list_n,
    status: list_n === 0
      ? "empty" as const
      : list_n === mergeLimit ? "truncated" as const : "complete" as const
  });
}

function exactProducerFixture(
  candidates: readonly Readonly<{
    readonly candidate_key: string;
    readonly normalized_rank: number;
  }>[],
  mergeLimit: number
) {
  const ranked = [...candidates].sort((left, right) =>
    right.normalized_rank - left.normalized_rank ||
    left.candidate_key.localeCompare(right.candidate_key)
  );
  const rawKeys = exactRawGroupKeys(ranked.map((candidate) => candidate.normalized_rank));
  const ordinals = groupedOrdinalScores(rawKeys);
  const rows = Object.freeze(ranked.map((candidate, index) => Object.freeze({
    candidate_key: candidate.candidate_key, raw_group_key: rawKeys[index]!,
    lane_index: index, grouped_ordinal: ordinals[index]!, observation_state: "observed" as const
  })));
  const canonical = [...rows].sort((left, right) =>
    compareCodeUnits(left.candidate_key, right.candidate_key)
  );
  return Object.freeze({
    matches: Object.freeze(rows.map((row) => Object.freeze({
      object_id: row.candidate_key, normalized_rank: row.grouped_ordinal
    }))),
    candidates: Object.freeze(canonical),
    receipt: exactProducerReceipt(rows, canonical, mergeLimit)
  });
}

type ExactProducerRow = Readonly<{
  readonly candidate_key: string;
  readonly raw_group_key: number;
  readonly lane_index: number;
  readonly grouped_ordinal: number;
  readonly observation_state: "observed";
}>;

function exactProducerReceipt(
  rows: readonly ExactProducerRow[],
  canonical: readonly ExactProducerRow[],
  mergeLimit: number
) {
  return Object.freeze({
    schema_version: 1 as const,
    receipt_id: "alaya.recall.x0.lexical-raw-rank.v1" as const,
    producer_id: "alaya.storage.mergeKeywordSearchRows.v1" as const,
    query_run_id: "measurement-authority-captured-fixture",
    merge_limit: mergeLimit,
    lanes: Object.freeze([
      producerLane("exact", "matched_token_count", 0, rows, mergeLimit),
      producerLane("porter", "bm25_raw_rank", 1, [], mergeLimit),
      producerLane("object_key_porter", "bm25_raw_rank", 1, [], mergeLimit),
      producerLane("trigram", "bm25_raw_rank", 2, [], mergeLimit),
      producerLane("object_key_trigram", "bm25_raw_rank", 2, [], mergeLimit)
    ]),
    candidates: Object.freeze(canonical.map((candidate) => Object.freeze({
      candidate_key: candidate.candidate_key,
      lane_hits: Object.freeze([Object.freeze({
        lane_id: "exact" as const,
        raw_group_key: candidate.raw_group_key,
        grouped_ordinal: candidate.grouped_ordinal,
        lane_index: candidate.lane_index
      })]),
      admitted: true,
      chosen_lane_id: "exact" as const,
      chosen_normalized_rank: candidate.grouped_ordinal,
      post_merge_index: candidate.lane_index,
      discarded_lane_ids: Object.freeze([])
    }))),
    post_merge: Object.freeze(rows.map((candidate) => Object.freeze({
      candidate_key: candidate.candidate_key, normalized_rank: candidate.grouped_ordinal
    })))
  });
}

function exactRawGroupKeys(desiredScores: readonly number[]): readonly number[] {
  const distinct = new Set(desiredScores).size;
  let group = distinct;
  return Object.freeze(desiredScores.map((score, index) => {
    if (index > 0 && score !== desiredScores[index - 1]) group -= 1;
    return group;
  }));
}

function groupedOrdinalScores(rawKeys: readonly number[]): readonly number[] {
  const scores = new Array<number>(rawKeys.length);
  for (let start = 0; start < rawKeys.length;) {
    let end = start + 1;
    while (end < rawKeys.length && rawKeys[end] === rawKeys[start]) end += 1;
    let total = 0;
    for (let index = start; index < end; index += 1) total += (rawKeys.length - index) / rawKeys.length;
    for (let index = start; index < end; index += 1) scores[index] = total / (end - start);
    start = end;
  }
  return Object.freeze(scores);
}

function producerLane(
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
  requested_limit: number
) {
  const status = rows.length === 0 ? "empty" as const
    : rows.length >= requested_limit ? "truncated" as const : "complete" as const;
  return Object.freeze({
    lane_id, raw_key_kind, source_priority,
    applicability_source: "memory_fts_lane" as const,
    list_n: rows.length, requested_limit, status, rows: Object.freeze(rows),
    unseen_upper_bound: status === "truncated" ? rows.at(-1)!.grouped_ordinal : 0
  });
}

function snapshotPort() {
  return { beginDeferred() {}, commit() {}, rollback() {} };
}

export function measurementEvidenceWithAlternateCompilation(
  prepared: PreparedRecallRequest,
  lexical = false
): PreparedMeasurementAuthorityEvidenceV1 {
  const base = measurementEvidence(prepared, lexical);
  const canonicalQueryEvidence = Object.freeze({
    ...base.canonical_query_evidence,
    probes: Object.freeze({
      ...base.canonical_query_evidence.probes,
      normalized_query: "how many authority variants"
    })
  });
  return Object.freeze({
    ...base,
    canonical_query_evidence: canonicalQueryEvidence,
    canonical_query_compilation: compileCanonicalQueryCompilation(
      canonicalQueryEvidence,
      base.snapshot_coherence_receipt
    )
  });
}

export function releaseMeasurementEvidenceFixture(prepared: PreparedRecallRequest): void {
  prepared.releaseProjectionPin();
  prepared.projectionPinLease.stop();
}

function memoryRepo(
  searchByKeywordField: NonNullable<RecallServiceMemoryRepoPort["searchByKeywordField"]>
): RecallServiceMemoryRepoPort {
  return {
    findByWorkspaceId: async () => [],
    findByDimension: async () => [],
    findByScopeClass: async () => [],
    searchByKeywordField
  } satisfies RecallServiceMemoryRepoPort;
}
