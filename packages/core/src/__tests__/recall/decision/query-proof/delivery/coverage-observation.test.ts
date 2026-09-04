import { describe, expect, it } from "vitest";
import { CAPTURE_IDENTITY_DIGEST } from
  "../../../../../recall/decision/prefix-capture/identity.js";
import {
  NON_INTERFERING_PRINCIPAL_SCOPE,
  SEAL_UNBOUND_HOLE,
  type DeliveryPackInputV1
} from "../../../../../recall/decision/query-proof/delivery/contract.js";
import { observeDeliveryPackModeCoverage } from
  "../../../../../recall/decision/query-proof/delivery/coverage-observation.js";
import { buildDeliveryPack } from
  "../../../../../recall/decision/query-proof/delivery/pack.js";
import {
  captureShadowIntegration,
  isFailClosedShadowTrace
} from "../../../../../recall/integration/shadow/integrate.js";
import { digestRecallFieldIdentity } from
  "../../../../../recall/field/field-identity.js";
import { buildDefaultPolicy } from "../../../../../recall/runtime/orchestration.js";
import { compileRecallQueryProbes } from
  "../../../../../recall/query/recall-query-probes.js";
import type { CoarseRecallCandidate } from
  "../../../../../recall/runtime/recall-service-types.js";
import { createMemoryEntry } from "../../../recall-service-test-fixtures.js";

describe("delivery pack mode coverage observation", () => {
  it("folds every mode without claiming coverage closed", () => {
    const histogram = observeDeliveryPackModeCoverage([
      buildDeliveryPack(certifiedInput()),
      buildDeliveryPack(uncertifiedInput("best_effort_uncertified")),
      buildDeliveryPack(uncertifiedInput("abstained")),
      buildDeliveryPack(uncertifiedInput("unsupported")),
      buildDeliveryPack(conflictInput())
    ]);
    expect(histogram.coverage_claim).toBe("not_claimed");
    expect(histogram.observation_status).toBe("observed");
    expect(histogram.total).toBe(5);
    expect(histogram.counts).toEqual({
      certified: 1,
      best_effort_uncertified: 1,
      abstained: 1,
      unsupported: 1,
      conflict: 1
    });
    expect(JSON.stringify(histogram)).not.toMatch(/coverage_closed|coverage-closed/u);
  });

  it("observes live shadow packs as unsupported when the target chain cannot issue and does not close coverage", () => {
    const histogram = observeDeliveryPackModeCoverage([captureLive().delivery_pack]);
    expect(histogram.counts.unsupported).toBe(1);
    expect(histogram.counts.certified).toBe(0);
    expect(histogram.coverage_claim).toBe("not_claimed");
  });
});

function captureLive() {
  const candidates: readonly CoarseRecallCandidate[] = ["cand-a"].map((objectId) => ({
    entry: createMemoryEntry({
      object_id: objectId,
      content: "fact",
      activation_score: 0.4
    }),
    admissionPlanes: ["activation"],
    firstAdmissionPlane: "activation"
  }));
  const trace = captureShadowIntegration({
    candidates,
    policy: buildDefaultPolicy({
      strategy: "build",
      taskSurfaceRef: "task-surface-1",
      now: () => "2026-07-12T00:00:00.000Z",
      generateRuntimeId: () => "33333333-3333-4333-8333-333333333333"
    }),
    supplementaryData: {
      queryProbes: compileRecallQueryProbes("where is the operator?"),
      ftsRanks: {},
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
    },
    tokenEstimator: { estimate: () => 4 }
  });
  expect(isFailClosedShadowTrace(trace)).toBe(false);
  if (isFailClosedShadowTrace(trace)) throw new Error("expected captured shadow");
  return trace;
}

function certifiedInput(
  override: Partial<DeliveryPackInputV1> = {}
): DeliveryPackInputV1 {
  return {
    mode: "certified",
    query_digest: digestRecallFieldIdentity("delivery-pack-query"),
    snapshot_digest: digestRecallFieldIdentity("delivery-pack-snapshot"),
    decision_contract_digest: digestRecallFieldIdentity("delivery-pack-contract"),
    capture_identity_digest: CAPTURE_IDENTITY_DIGEST,
    selected_candidates: ["workspace_local:memory_entry:a"],
    answer_kind: "scalar",
    answer_bindings: [{ binding_id: "x0", value: "answer" }],
    propositions: [{ proposition_id: "phi-1", support: "supports" }],
    evidence_groups: [{
      group_id: "g1",
      member_keys: ["workspace_local:memory_entry:a"],
      correlation: "unknown"
    }],
    holes: [],
    conflicts: [],
    completeness_scope: null,
    principal_scope: NON_INTERFERING_PRINCIPAL_SCOPE,
    ...override
  };
}

function uncertifiedInput(
  mode: Exclude<DeliveryPackInputV1["mode"], "certified" | "conflict">
): DeliveryPackInputV1 {
  return certifiedInput({
    mode,
    answer_kind: "none",
    holes: [SEAL_UNBOUND_HOLE]
  });
}

function conflictInput(): DeliveryPackInputV1 {
  return certifiedInput({
    mode: "conflict",
    answer_kind: "none",
    holes: [SEAL_UNBOUND_HOLE],
    conflicts: [{
      conflict_id: "c1",
      kind: "proposition_conflict",
      coordinate_ids: ["phi-1"]
    }]
  });
}
