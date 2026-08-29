import { buildDefaultPolicy } from
  "../../../../recall/runtime/orchestration.js";
import { createSeededTestOnlyInMemoryFieldQuerySession } from
  "../../../../recall/runtime/query/field-query-session.js";
import { prepareRecallRequest } from
  "../../../../recall/runtime/query/prepare-recall-request.js";
import { captureRecallRequestTime } from
  "../../../../recall/runtime/query/recall-request-time.js";
import {
  createSnapshotCoherenceReceiptV1,
  createSnapshotVectorV1,
  finalizePreparedSnapshotReadLease
} from "../../../../recall/runtime/snapshot-coherence/index.js";
import type { PreparedRecallRequest } from
  "../../../../recall/runtime/recall-service-runner-types.js";
import type { PreparedMeasurementAuthorityEvidenceV1 } from
  "../../../../recall/shadow/measurement/index.js";
import {
  verifyLexicalMeasurementPreparedAuthorityV1,
  type VerifiedMeasurementAuthorityV1
} from "../../../../recall/shadow/measurement/index.js";
import { createRecallRetrievalFieldBundle } from
  "../../../../recall/field/retrieval/retrieval-field-bundle.js";
import {
  bindRetrievalFieldBundleReadAuthority,
  readMemoryLexicalIntervalSources
} from "../../../../recall/field/retrieval/retrieval-field-source-authority.js";
import { withActiveRecallReadSnapshot } from
  "../../../../recall/runtime/recall-read-snapshot.js";
import { fieldContractSha256 } from "../../../../shared/field-hash.js";
import { compileCanonicalQueryCompilation } from
  "../../../../recall/query/canonical-query/index.js";
import { createDependencies, createTaskSurface } from
  "../../recall-service-test-fixtures.js";

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
    memoryRepo: { searchByKeywordField: async () => result }
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
