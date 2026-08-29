import { describe, expect, it, vi } from "vitest";
import { fineAssess } from "../../../recall/delivery/fine-assessment.js";
import { compileRecallQueryProbes } from
  "../../../recall/query/recall-query-probes.js";
import { buildDefaultPolicy } from "../../../recall/runtime/orchestration.js";
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
import { evidenceCandidate, fieldCandidates } from "./canonical-delivery-fixtures.js";
import { D1_SNAPSHOT, plantProof } from "./d1/d1-proof-fixture.js";

const NOW = "2026-08-29T00:00:00.000Z";
const QUERY_ID = "live-query-proof";

describe("live Band 1 receipt input", () => {
  it("materializes identity-bound lexical and support receipts only into Psi v2 diagnostics", () => {
    const candidates = fieldCandidates(["cand-a", "cand-b"]);
    const base = fineAssess(params(candidates));
    const observed = fineAssess({
      ...params(candidates),
      query_id: QUERY_ID,
      snapshot_digest: D1_SNAPSHOT,
      lexicalBoundProofs: [lexicalProof()],
      supportCandidateReceipts: supportReceipts()
    });
    const baseTrace = captured(base.shadowTrace);
    const observedTrace = captured(observed.shadowTrace);

    expect(baseTrace.psi_v2_shadow).toEqual({
      status: "unavailable",
      observation: "not_observed"
    });
    expect(observedTrace.psi_v2_shadow).toMatchObject({
      observation_status: "observed",
      frontier_width: 2
    });
    expect("support_graph_digest" in observedTrace.psi_v2_shadow &&
      observedTrace.psi_v2_shadow.support_graph_digest).toMatch(/^sha256:/u);
    expect(withoutPsi(observedTrace)).toEqual(withoutPsi(baseTrace));
    expect(observed.candidates).toEqual(base.candidates);
    expect(observed.capture_receipt).toEqual(base.capture_receipt);
  });

  it("keeps absent receipts not_observed and legacy delivery unchanged", () => {
    process.env.ALAYA_RECALL_ALLOW_LEGACY_DELIVERY = "1";
    try {
      const withoutCapture = fineAssess(params(fieldCandidates(["cand-a", "cand-b"]), "legacy"));
      const withCapture = fineAssess({
        ...params(fieldCandidates(["cand-a", "cand-b"]), "legacy"),
        captureShadowTrace: true
      });
      expect(captured(withCapture.shadowTrace).psi_v2_shadow).toEqual({
        status: "unavailable",
        observation: "not_observed"
      });
      expect(withCapture.candidates).toEqual(withoutCapture.candidates);
      expect(withCapture.ranking_authority).toBe("select_gamma");
    } finally {
      delete process.env.ALAYA_RECALL_ALLOW_LEGACY_DELIVERY;
    }
  });

  it("exposes planted live receipts on the legacy shadow capture without changing selection", () => {
    process.env.ALAYA_RECALL_ALLOW_LEGACY_DELIVERY = "1";
    try {
      const candidates = fieldCandidates(["cand-a", "cand-b"]);
      const base = fineAssess(params(candidates, "legacy"));
      const observed = fineAssess({
        ...params(candidates, "legacy"),
        captureShadowTrace: true,
        query_id: QUERY_ID,
        snapshot_digest: D1_SNAPSHOT,
        lexicalBoundProofs: [lexicalProof()],
        supportCandidateReceipts: supportReceipts()
      });
      expect(captured(observed.shadowTrace).psi_v2_shadow).toMatchObject({
        observation_status: "observed"
      });
      expect(observed.candidates).toEqual(base.candidates);
      expect(observed.ranking_authority).toBe("select_gamma");
    } finally {
      delete process.env.ALAYA_RECALL_ALLOW_LEGACY_DELIVERY;
    }
  });

  it("rejects support receipts outside the live candidate identity universe", () => {
    const candidates = fieldCandidates(["cand-a", "cand-b"]);
    const base = fineAssess(params(candidates));
    const tampered = fineAssess({
      ...params(candidates),
      query_id: QUERY_ID,
      snapshot_digest: D1_SNAPSHOT,
      supportCandidateReceipts: [{
        candidate_key: keyOf("not-in-field"),
        evidence_ids: ["evidence-trap"]
      }]
    });

    expect(captured(tampered.shadowTrace).psi_v2_shadow).toMatchObject({
      observation_status: "not_observed",
      support_graph_digest: null
    });
    expect(tampered.candidates).toEqual(base.candidates);
    expect(tampered.capture_receipt).toEqual(base.capture_receipt);
  });

  it("carries existing retrieval and candidate receipts through the live runtime builder", () => {
    const candidates = [evidenceCandidate("cand-a", "evidence-a")];
    const proof = lexicalProof();
    const policy = policyOf();
    const built = buildFineAssessParams(
      { warn: vi.fn() } as unknown as RecallExecutionContext,
      {
        workspaceId: "workspace-1",
        diagnosticCapture: "answer_features"
      } as unknown as RecallExecutionParams,
      {
        policy,
        winnerMemoryIds: new Set<string>(),
        tokenEstimator: { estimate: () => 4 },
        referenceTime: NOW,
        answerShapePlan: {},
        queryCondition: {
          identity: "condition-live",
          generation_id: FIELD_PINS.generation_id
        },
        snapshotReadLease: { vector_digest: D1_SNAPSHOT },
        retrievalFieldBundle: {
          memoryKeywordLanes: () => [],
          memoryLexicalCaptures: () => [],
          memoryLexicalBoundProofs: () => [proof]
        }
      } as unknown as PreparedRecallRequest,
      supplementary(candidates),
      candidates
    );

    expect(built.query_id).toBe(QUERY_ID);
    expect(built.snapshot_digest).toBe(D1_SNAPSHOT);
    expect(built.lexicalBoundProofs).toEqual([proof]);
    expect(built.supportCandidateReceipts?.[0]?.evidence_ids).toEqual(["evidence-a"]);
    expect(captured(fineAssess(built).shadowTrace).psi_v2_shadow).toMatchObject({
      observation_status: "observed"
    });
  });
});

function lexicalProof() {
  return plantProof({
    queryRunId: QUERY_ID,
    snapshotDigest: D1_SNAPSHOT,
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
