import { expect, vi } from "vitest";
import { fineAssess } from "../../../../recall/delivery/fine-assessment.js";
import { compileRecallQueryProbes } from
  "../../../../recall/query/recall-query-probes.js";
import { compileCanonicalQueryCompilation } from
  "../../../../recall/query/canonical-query/index.js";
import { buildDefaultPolicy } from "../../../../recall/runtime/orchestration.js";
import { prepareRecallRequest } from
  "../../../../recall/runtime/query/prepare-recall-request.js";
import { captureRecallRequestTime } from
  "../../../../recall/runtime/query/recall-request-time.js";
import {
  createSnapshotCoherenceReceiptV1,
  createSnapshotVectorV1,
  finalizePreparedSnapshotReadLease
} from "../../../../recall/runtime/snapshot-coherence/index.js";
import { createSeededTestOnlyInMemoryFieldQuerySession } from
  "../../../../recall/runtime/query/field-query-session.js";
import type {
  CoarseRecallCandidate,
  RecallSupplementaryData
} from "../../../../recall/runtime/recall-service-types.js";
import type { PreparedRecallRequest } from
  "../../../../recall/runtime/recall-service-runner-types.js";
import { isFailClosedShadowTrace, type ShadowCapturedTrace } from
  "../../../../recall/integration/shadow/integrate.js";
import type { SupportCandidateReceiptV1 } from
  "../../../../recall/decision/query-proof/support/index.js";
import { fieldContractSha256 } from "../../../../shared/field-hash.js";
import { FIELD_PINS } from "../../fine-assessment-selection-fixtures.js";
import {
  createDependencies,
  createTaskSurface,
  withFineDeliveryPath
} from "../../recall-service-test-fixtures.js";
import { D1_REQUEST, plantProof } from "../../decision/query-proof/adapters/lexical-bound/d1-proof-fixture.js";

const NOW = "2026-08-29T00:00:00.000Z";
const QUERY_RUN_ID = "storage-local-lane-label";

export function lexicalProof(snapshotDigest: string | null = null) {
  return plantProof({
    queryRunId: QUERY_RUN_ID,
    requestDigest: D1_REQUEST,
    snapshotDigest,
    lanes: {
      porter: {
        rows: [
          { key: "cand-a", ordinal: 0.9 },
          { key: "cand-b", ordinal: 0.4 }
        ],
        universeKeys: ["cand-a", "cand-b"]
      }
    }
  });
}

export function lexicalPin() {
  return Object.freeze({
    workspace_id: "workspace-1",
    request_digest: D1_REQUEST,
    field_prefix: "lexical_relaxed" as const,
    candidate_key_domain: "memory_object_id" as const
  });
}

export function authorityFrom(prepared: PreparedRecallRequest) {
  return Object.freeze({
    workspace_id: "workspace-1",
    query_condition: prepared.queryCondition,
    canonical_query_evidence: prepared.canonicalQueryEvidence,
    canonical_query_compilation: prepared.canonicalQueryCompilation,
    snapshot_vector: prepared.snapshotVector,
    snapshot_coherence_receipt: prepared.snapshotCoherenceReceipt,
    snapshot_read_lease: prepared.snapshotReadLease,
    expected_lexical_request_pins: [lexicalPin()]
  });
}

export function diagnostics(trace: ShadowCapturedTrace) {
  if (!("producer_outcomes" in trace.psi_v2_shadow)) {
    throw new Error("expected typed Psi v2 producer outcomes");
  }
  return trace.psi_v2_shadow;
}

export async function preparedAuthority(): Promise<PreparedRecallRequest> {
  const { dependencies } = createDependencies([]);
  const taskSurface = createTaskSurface();
  return await prepareRecallRequest({
    dependencies,
    warn: () => undefined,
    now: () => NOW,
    buildDefaultPolicy: () => policyOf(),
    fieldQuerySession: createSeededTestOnlyInMemoryFieldQuerySession(
      fieldContractSha256, "workspace-1"
    ),
    sha256: fieldContractSha256
  }, {
    taskSurface,
    workspaceId: "workspace-1",
    strategy: "analyze"
  }, captureRecallRequestTime({ now: () => NOW }));
}

export async function capturedPathGraphPreparedAuthority(): Promise<PreparedRecallRequest> {
  const prepared = await preparedAuthority();
  const pathGraph = prepared.snapshotVector.path_graph_generation;
  const { schema_version: _schemaVersion, vector_digest: _vectorDigest, ...input } =
    prepared.snapshotVector;
  const snapshotVector = createSnapshotVectorV1({
    ...input,
    path_graph_generation: Object.freeze({
      ...pathGraph,
      source_frontier: "path-graph-frontier:test-captured",
      generation: "path-graph-generation:test-captured",
      lag_bound: Object.freeze({ kind: "exact" as const })
    })
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

export async function capturedLexicalPreparedAuthority(): Promise<PreparedRecallRequest> {
  const prepared = await preparedAuthority();
  const lexical = prepared.snapshotVector.retrieval_channel_snapshots.find(
    ({ source_owner }) => source_owner === "lexical_relaxed"
  );
  if (lexical === undefined) throw new Error("lexical test source declaration missing");
  const { schema_version: _schemaVersion, vector_digest: _vectorDigest, ...input } =
    prepared.snapshotVector;
  const snapshotVector = createSnapshotVectorV1({
    ...input,
    retrieval_channel_snapshots: Object.freeze(
      prepared.snapshotVector.retrieval_channel_snapshots.map((declaration) =>
        declaration.source_owner === lexical.source_owner
          ? Object.freeze({
              ...declaration,
              source_frontier: "lexical-frontier:test-captured",
              generation: "lexical-generation:test-captured",
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

export function cleanup(prepared: PreparedRecallRequest): void {
  prepared.releaseProjectionPin();
  prepared.projectionPinLease.stop();
}

export function supportReceipts(): readonly SupportCandidateReceiptV1[] {
  return [{
    candidate_key: keyOf("cand-a"),
    osf: {
      composition_status: "composed",
      truncated: false,
      bindings: [{
        variable_id: "x0",
        binding_identity: "binding.operator",
        semantic_identity: "operator",
        evidence_id: "evidence-a",
        query_proposition_id: "proposition.workspace"
      }]
    },
    evidence_ids: ["evidence-a"]
  }];
}

export function legalSupportReceipts(): readonly SupportCandidateReceiptV1[] {
  return [{
    candidate_key: keyOf("cand-a"),
    hypothesis_digest: `sha256:${"1".repeat(64)}`,
    osf: {
      composition_status: "composed",
      truncated: false,
      bindings: [{
        variable_id: "x",
        binding_identity: "arg.person",
        semantic_identity: "person.alice",
        evidence_id: "eu-1",
        query_proposition_id: "prop.works-at",
        source_lineage_id: "lineage-a"
      }]
    },
    fact_frames: [{ semantic_identity: "person.alice", role: "entity", evidence_id: "eu-1" }],
    evidence_ids: ["eu-1"]
  }];
}

export function params(
  candidates: readonly CoarseRecallCandidate[],
  path: "canonical" | "legacy" = "canonical"
) {
  return {
    ...FIELD_PINS,
    candidates,
    policy: withFineDeliveryPath(policyOf(), path),
    winnerMemoryIds: new Set<string>(),
    supplementaryData: supplementary(candidates),
    tokenEstimator: { estimate: () => 4 },
    now: () => NOW,
    warn: vi.fn()
  };
}

export function policyOf() {
  return buildDefaultPolicy({
    strategy: "build",
    taskSurfaceRef: "task-surface-1",
    now: () => NOW,
    generateRuntimeId: () => "33333333-3333-4333-8333-333333333333"
  });
}

export function supplementary(
  candidates: readonly CoarseRecallCandidate[]
): RecallSupplementaryData {
  return {
    queryProbes: compileRecallQueryProbes("where does the operator work?"),
    ftsRanks: Object.fromEntries(candidates.map(({ entry }, index) =>
      [entry.object_id, 1 - index * 0.1])),
    trigramFtsRanks: {},
    synthesisFtsRanks: {},
    evidenceFtsRanks: {},
    evidenceProjectionMatchesByRef: {},
    sourceProximityScores: {},
    sourceCohortKeys: {},
    structuralScores: {},
    graphExpansionScores: {},
    entitySeedScores: {},
    pathExpansionScores: {},
    pathSuppressionScores: {},
    embeddingSimilarityScores: {},
    evidenceSemanticActivationsByCandidateKey: new Map(),
    graphSupportCounts: {},
    budgetPenaltyFactor: 0,
    plasticityFactors: {},
    graphAndPathColdScore: 0,
    recallsEdgeCount: 0,
    weightTransferAmount: 0,
    evidenceGistsByMemoryId: {},
    governanceCeilingByMemoryId: {}
  };
}

export function captured(
  trace: ReturnType<typeof fineAssess>["shadowTrace"]
): ShadowCapturedTrace {
  expect(trace).toBeDefined();
  expect(isFailClosedShadowTrace(trace!)).toBe(false);
  if (trace === undefined || isFailClosedShadowTrace(trace)) {
    throw new Error("expected captured shadow trace");
  }
  return trace;
}

export function withoutPsi(trace: ShadowCapturedTrace) {
  const { psi_v2_shadow: _psi, ...rest } = trace;
  return rest;
}

export function keyOf(objectId: string): string {
  return `workspace_local:memory_entry:${objectId}`;
}
