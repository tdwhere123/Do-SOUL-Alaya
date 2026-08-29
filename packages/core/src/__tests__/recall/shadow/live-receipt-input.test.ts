import { describe, expect, it, vi } from "vitest";
import { fineAssess } from "../../../recall/delivery/fine-assessment.js";
import { compileRecallQueryProbes } from
  "../../../recall/query/recall-query-probes.js";
import { buildDefaultPolicy } from "../../../recall/runtime/orchestration.js";
import { prepareRecallRequest } from
  "../../../recall/runtime/query/prepare-recall-request.js";
import { captureRecallRequestTime } from
  "../../../recall/runtime/query/recall-request-time.js";
import { createSeededTestOnlyInMemoryFieldQuerySession } from
  "../../../recall/runtime/query/field-query-session.js";
import { buildFineAssessParams } from
  "../../../recall/runtime/orchestration/recall-fine-assessment.js";
import type {
  CoarseRecallCandidate,
  RecallSupplementaryData
} from "../../../recall/runtime/recall-service-types.js";
import type {
  PreparedRecallRequest,
  RecallExecutionContext,
  RecallExecutionParams
} from "../../../recall/runtime/recall-service-runner-types.js";
import { isFailClosedShadowTrace, type ShadowCapturedTrace } from
  "../../../recall/shadow/integrate.js";
import type { SupportCandidateReceiptV1 } from
  "../../../recall/shadow/support/index.js";
import { FIELD_PINS } from "../fine-assessment-selection-fixtures.js";
import { withFineDeliveryPath } from "../recall-service-test-fixtures.js";
import { createDependencies, createTaskSurface } from
  "../recall-service-test-fixtures.js";
import { fieldContractSha256 } from "../../../shared/field-hash.js";
import { evidenceCandidate, fieldCandidates } from "./canonical-delivery-fixtures.js";
import { D1_REQUEST, plantProof } from "./d1/d1-proof-fixture.js";

const NOW = "2026-08-29T00:00:00.000Z";
const QUERY_RUN_ID = "storage-local-lane-label";

describe("live Band 1 receipt input", () => {
  it("materializes prepared-authority lexical and support receipts only into Psi v2 diagnostics", async () => {
    const candidates = fieldCandidates(["cand-a", "cand-b"]);
    const base = fineAssess(params(candidates));
    const prepared = await preparedAuthority();
    const observed = fineAssess({
      ...params(candidates),
      queryProofAuthority: authorityFrom(prepared),
      lexicalBoundProofs: [lexicalProof(prepared.snapshotVector.vector_digest)],
      supportCandidateReceipts: supportReceipts()
    });
    const baseTrace = captured(base.shadowTrace);
    const observedTrace = captured(observed.shadowTrace);

    expect(baseTrace.psi_v2_shadow).toMatchObject({
      observation_status: "not_observed",
      producer_outcomes: [
        { producer_id: "lex.interval", status: "not_observed", reason: "input_absent" },
        { producer_id: "support", status: "not_observed", reason: "input_absent" }
      ]
    });
    expect(observedTrace.psi_v2_shadow).toMatchObject({
      observation_status: "observed"
    });
    expect("support_graph_digest" in observedTrace.psi_v2_shadow &&
      observedTrace.psi_v2_shadow.support_graph_digest).toMatch(/^sha256:/u);
    expect(withoutPsi(observedTrace)).toEqual(withoutPsi(baseTrace));
    expect(observed.candidates).toEqual(base.candidates);
    expect(observed.capture_receipt).toEqual(base.capture_receipt);
    cleanup(prepared);
  });

  it("keeps absent receipts not_observed and legacy delivery unchanged", () => {
    process.env.ALAYA_RECALL_ALLOW_LEGACY_DELIVERY = "1";
    try {
      const withoutCapture = fineAssess(params(fieldCandidates(["cand-a", "cand-b"]), "legacy"));
      const withCapture = fineAssess({
        ...params(fieldCandidates(["cand-a", "cand-b"]), "legacy"),
        captureShadowTrace: true
      });
      expect(captured(withCapture.shadowTrace).psi_v2_shadow).toMatchObject({
        observation_status: "not_observed",
        producer_outcomes: [
          { producer_id: "lex.interval", status: "not_observed" },
          { producer_id: "support", status: "not_observed" }
        ]
      });
      expect(withCapture.candidates).toEqual(withoutCapture.candidates);
      expect(withCapture.ranking_authority).toBe("select_gamma");
    } finally {
      delete process.env.ALAYA_RECALL_ALLOW_LEGACY_DELIVERY;
    }
  });

  it("treats storage query_run_id as a lane label for lexical-only live input", async () => {
    const candidates = fieldCandidates(["cand-a", "cand-b"]);
    const prepared = await preparedAuthority();
    const observed = fineAssess({
      ...params(candidates),
      queryProofAuthority: authorityFrom(prepared),
      lexicalBoundProofs: [lexicalProof(prepared.snapshotVector.vector_digest)]
    });

    expect(captured(observed.shadowTrace).psi_v2_shadow).toMatchObject({
      observation_status: "observed",
      producer_outcomes: [
        { producer_id: "lex.interval", status: "observed" },
        { producer_id: "support", status: "not_observed", reason: "input_absent" }
      ]
    });
    cleanup(prepared);
  });

  it("exposes planted live receipts on the legacy shadow capture without changing selection", async () => {
    process.env.ALAYA_RECALL_ALLOW_LEGACY_DELIVERY = "1";
    try {
      const candidates = fieldCandidates(["cand-a", "cand-b"]);
      const base = fineAssess(params(candidates, "legacy"));
      const prepared = await preparedAuthority();
      const observed = fineAssess({
        ...params(candidates, "legacy"),
        captureShadowTrace: true,
        queryProofAuthority: authorityFrom(prepared),
        lexicalBoundProofs: [lexicalProof(prepared.snapshotVector.vector_digest)],
        supportCandidateReceipts: supportReceipts()
      });
      expect(captured(observed.shadowTrace).psi_v2_shadow).toMatchObject({
        observation_status: "observed"
      });
      expect(observed.candidates).toEqual(base.candidates);
      expect(observed.ranking_authority).toBe("select_gamma");
      cleanup(prepared);
    } finally {
      delete process.env.ALAYA_RECALL_ALLOW_LEGACY_DELIVERY;
    }
  });

  it("rejects support receipts outside the live candidate identity universe", async () => {
    const candidates = fieldCandidates(["cand-a", "cand-b"]);
    const base = fineAssess(params(candidates));
    const prepared = await preparedAuthority();
    const tampered = fineAssess({
      ...params(candidates),
      queryProofAuthority: authorityFrom(prepared),
      supportCandidateReceipts: [{
        candidate_key: keyOf("not-in-field"),
        evidence_ids: ["evidence-trap"]
      }]
    });

    expect(captured(tampered.shadowTrace).psi_v2_shadow).toMatchObject({
      observation_status: "malformed",
      support_graph_digest: null,
      producer_outcomes: expect.arrayContaining([{
        producer_id: "support",
        status: "malformed",
        contract_code: "foreign_candidate_receipt"
      }])
    });
    expect(tampered.candidates).toEqual(base.candidates);
    expect(tampered.capture_receipt).toEqual(base.capture_receipt);
    cleanup(prepared);
  });

  it("makes a prepared workspace mismatch unavailable without changing delivery", async () => {
    const candidates = fieldCandidates(["cand-a", "cand-b"]);
    const prepared = await preparedAuthority();
    const base = fineAssess(params(candidates));
    const mismatched = fineAssess({
      ...params(candidates),
      workspace_id: "workspace-other",
      queryProofAuthority: authorityFrom(prepared),
      lexicalBoundProofs: [lexicalProof(prepared.snapshotVector.vector_digest)]
    });

    expect(captured(mismatched.shadowTrace).psi_v2_shadow).toMatchObject({
      observation_status: "malformed",
      producer_outcomes: expect.arrayContaining([{
        producer_id: "lex.interval",
        status: "malformed",
        contract_code: "authority_identity_mismatch"
      }])
    });
    expect(mismatched.candidates).toEqual(base.candidates);
    expect(mismatched.capture_receipt).toEqual(base.capture_receipt);
    cleanup(prepared);
  });

  it("carries Band 1 authority without a diagnostic flag and ignores query_run_id as query identity", async () => {
    const candidates = [evidenceCandidate("cand-a", "evidence-a")];
    const prepared = await preparedAuthority();
    const proof = lexicalProof(prepared.snapshotVector.vector_digest);
    const built = buildFineAssessParams(
      { warn: vi.fn() } as unknown as RecallExecutionContext,
      {
        workspaceId: "workspace-1"
      } as unknown as RecallExecutionParams,
      {
        ...prepared,
        retrievalFieldBundle: {
          memoryKeywordLanes: () => [],
          memoryLexicalCaptures: () => [],
          memoryLexicalBoundProofs: () => [proof],
          memoryLexicalBoundProofsForSnapshot: () => [proof],
          memoryLexicalRequestPins: () => [lexicalPin()]
        }
      } as unknown as PreparedRecallRequest,
      supplementary(candidates),
      candidates
    );

    expect(built.queryProofAuthority?.canonical_query_compilation.query_identity
      .condition_identity).toBe(prepared.queryCondition.identity);
    expect(built.queryProofAuthority?.snapshot_vector.vector_digest)
      .toBe(prepared.snapshotVector.vector_digest);
    expect(built.lexicalBoundProofs).toEqual([proof]);
    expect(built.supportCandidateReceipts?.[0]?.evidence_ids).toEqual(["evidence-a"]);
    expect(captured(fineAssess({
      ...built,
      policy: withFineDeliveryPath(built.policy, "canonical")
    }).shadowTrace).psi_v2_shadow).toMatchObject({
      observation_status: "observed"
    });
    cleanup(prepared);
  });

  it("keeps support observed when the lexical producer is malformed", async () => {
    const candidates = fieldCandidates(["cand-a", "cand-b"]);
    const prepared = await preparedAuthority();
    const base = fineAssess(params(candidates));
    const observed = fineAssess({
      ...params(candidates),
      queryProofAuthority: authorityFrom(prepared),
      lexicalBoundProofs: [lexicalProof(prepared.snapshotVector.base_store_digest)],
      supportCandidateReceipts: supportReceipts()
    });
    expect(captured(observed.shadowTrace).psi_v2_shadow).toMatchObject({
      observation_status: "malformed",
      producer_outcomes: [
        {
          producer_id: "lex.interval",
          status: "malformed",
          contract_code: "authority_identity_mismatch"
        },
        { producer_id: "support", status: "observed" }
      ]
    });
    expect(observed.candidates).toEqual(base.candidates);
    expect(observed.capture_receipt).toEqual(base.capture_receipt);
    cleanup(prepared);
  });

  it("keeps absent, unavailable, and malformed producer states digest-distinct", async () => {
    const candidates = fieldCandidates(["cand-a", "cand-b"]);
    const prepared = await preparedAuthority();
    const common = {
      ...params(candidates),
      queryProofAuthority: authorityFrom(prepared)
    };
    const absent = fineAssess(common);
    const unavailable = fineAssess({ ...common, lexicalBoundProofs: [lexicalProof(null)] });
    const malformed = fineAssess({
      ...common,
      lexicalBoundProofs: [lexicalProof(prepared.snapshotVector.base_store_digest)]
    });
    const traces = [absent, unavailable, malformed].map((result) => captured(result.shadowTrace));
    expect(traces.map((trace) => diagnostics(trace).observation_status)).toEqual([
      "not_observed", "producer_unavailable", "malformed"
    ]);
    expect(new Set(traces.map((trace) => diagnostics(trace).digest))).toHaveLength(3);
    expect(unavailable.candidates).toEqual(absent.candidates);
    expect(malformed.candidates).toEqual(absent.candidates);
    expect(unavailable.capture_receipt).toEqual(absent.capture_receipt);
    expect(malformed.capture_receipt).toEqual(absent.capture_receipt);
    cleanup(prepared);
  });

  it.each([
    ["duplicate_receipt", () => [supportReceipts()[0]!, supportReceipts()[0]!]],
    ["producer_contract_invalid", () => [{
      candidate_key: keyOf("cand-a"),
      osf: { composition_status: "invalid" }
    }]],
    ["producer_contract_invalid", () => [{
      candidate_key: keyOf("cand-a"),
      osf: {
        composition_status: "composed",
        bindings: [{
          variable_id: "x0",
          binding_identity: "binding.operator",
          semantic_identity: null,
          evidence_id: "evidence-a"
        }]
      }
    }]]
  ] as const)("types support %s failures without erasing lexical absence", async (
    expectedCode,
    receipts
  ) => {
    const candidates = fieldCandidates(["cand-a", "cand-b"]);
    const prepared = await preparedAuthority();
    const result = fineAssess({
      ...params(candidates),
      queryProofAuthority: authorityFrom(prepared),
      supportCandidateReceipts: receipts() as unknown as readonly SupportCandidateReceiptV1[]
    });
    expect(captured(result.shadowTrace).psi_v2_shadow).toMatchObject({
      observation_status: "malformed",
      producer_outcomes: [
        { producer_id: "lex.interval", status: "not_observed", reason: "input_absent" },
        { producer_id: "support", status: "malformed", contract_code: expectedCode }
      ]
    });
    cleanup(prepared);
  });
});

function lexicalProof(snapshotDigest: string | null = null) {
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

function lexicalPin() {
  return Object.freeze({
    workspace_id: "workspace-1",
    request_digest: D1_REQUEST,
    field_prefix: "lexical_relaxed" as const,
    candidate_key_domain: "memory_object_id" as const
  });
}

function authorityFrom(prepared: PreparedRecallRequest) {
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

function diagnostics(trace: ShadowCapturedTrace) {
  if (!("producer_outcomes" in trace.psi_v2_shadow)) {
    throw new Error("expected typed Psi v2 producer outcomes");
  }
  return trace.psi_v2_shadow;
}

async function preparedAuthority(): Promise<PreparedRecallRequest> {
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

function cleanup(prepared: PreparedRecallRequest): void {
  prepared.releaseProjectionPin();
  prepared.projectionPinLease.stop();
}

function supportReceipts(): readonly SupportCandidateReceiptV1[] {
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

function params(
  candidates: readonly CoarseRecallCandidate[],
  path: "canonical" | "legacy" = "canonical"
) {
  const policy = policyOf();
  return {
    ...FIELD_PINS,
    candidates,
    policy: withFineDeliveryPath(policy, path),
    winnerMemoryIds: new Set<string>(),
    supplementaryData: supplementary(candidates),
    tokenEstimator: { estimate: () => 4 },
    now: () => NOW,
    warn: vi.fn()
  };
}

function policyOf() {
  return buildDefaultPolicy({
    strategy: "build",
    taskSurfaceRef: "task-surface-1",
    now: () => NOW,
    generateRuntimeId: () => "33333333-3333-4333-8333-333333333333"
  });
}

function supplementary(candidates: readonly CoarseRecallCandidate[]): RecallSupplementaryData {
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

function captured(trace: ReturnType<typeof fineAssess>["shadowTrace"]): ShadowCapturedTrace {
  expect(trace).toBeDefined();
  expect(isFailClosedShadowTrace(trace!)).toBe(false);
  if (trace === undefined || isFailClosedShadowTrace(trace)) {
    throw new Error("expected captured shadow trace");
  }
  return trace;
}

function withoutPsi(trace: ShadowCapturedTrace) {
  const { psi_v2_shadow: _psi, ...rest } = trace;
  return rest;
}

function keyOf(objectId: string): string {
  return `workspace_local:memory_entry:${objectId}`;
}
