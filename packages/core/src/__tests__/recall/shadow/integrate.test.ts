import { describe, expect, it, vi } from "vitest";
import { fineAssess } from "../../../recall/delivery/fine-assessment.js";
import { compileRecallQueryProbes } from "../../../recall/query/recall-query-probes.js";
import { buildDefaultPolicy } from "../../../recall/runtime/orchestration.js";
import type {
  CoarseRecallCandidate,
  RecallSupplementaryData
} from "../../../recall/runtime/recall-service-types.js";
import {
  D0_IDENTITY_DIGEST,
  SHADOW_ALGORITHM_VERSION,
  SHADOW_LINEAGE_IDS
} from "../../../recall/shadow/index.js";
import {
  captureShadowIntegration,
  isFailClosedShadowTrace,
  prefixSK,
  SHADOW_C0_SEAM,
  type FineAssessmentShadowTrace,
  type ShadowCapturedTrace
} from "../../../recall/shadow/integrate.js";
import { prefixSK as walkPrefixSK } from "../../../recall/shadow/walk.js";
import { FIELD_PINS } from "../fine-assessment-selection-fixtures.js";
import { createMemoryEntry } from "../recall-service-test-fixtures.js";
import {
  embeddingObserved,
  field,
  temporalObserved,
  view
} from "./psi-test-support.js";

const NOW = "2026-07-12T00:00:00.000Z";
const IDS = ["cand-a", "cand-b", "cand-c"] as const;

describe("J1 shadow integration at fineAssess", () => {
  it("planted guard: shadow cannot change production ids, order, or delivery diagnostics", () => {
    const params = assessParams(fieldCandidates());
    const planted = plantedTransitivity();
    const off = fineAssess(params);
    const on = fineAssess({
      ...params,
      captureShadowTrace: true,
      shadowObservationField: planted
    });

    expect(off.shadowTrace).toBeUndefined();
    expect("shadowTrace" in off).toBe(false);
    expect(on.shadowTrace).toBeDefined();
    expect(productionSlice(on)).toEqual(productionSlice(off));
    expect(on.candidates.map((candidate) => candidate.object_id))
      .toEqual(off.candidates.map((candidate) => candidate.object_id));
    expect(on.diagnostics).toEqual(off.diagnostics);
  });

  it("cycle in planted Psi fails closed and leaves production unchanged", () => {
    const params = assessParams(fieldCandidates());
    const keys = IDS.map(keyOf);
    const cyclic = (dominator: string, dominated: string) =>
      (dominator === keys[0] && dominated === keys[1]) ||
      (dominator === keys[1] && dominated === keys[2]) ||
      (dominator === keys[2] && dominated === keys[0]);
    const off = fineAssess(params);
    const on = fineAssess({
      ...params,
      captureShadowTrace: true,
      shadowPsi: cyclic
    });

    expect(productionSlice(on)).toEqual(productionSlice(off));
    expect(isFailClosedShadowTrace(on.shadowTrace!)).toBe(true);
    expect(on.shadowTrace).toMatchObject({
      kind: "fail_closed",
      reason: "psi_cycle_contract_failure",
      version: SHADOW_ALGORITHM_VERSION,
      digest: D0_IDENTITY_DIGEST,
      c0_seam: SHADOW_C0_SEAM
    });
  });

  it("records prefix S_K ⊆ S_(K+1) on the shadow trace", () => {
    const on = fineAssess({
      ...assessParams(fieldCandidates()),
      captureShadowTrace: true,
      shadowObservationField: plantedTransitivity()
    });
    const captured = asCaptured(on.shadowTrace);
    const s = captured.S_infty;
    expect(s.length).toBeGreaterThan(1);
    for (let k = 1; k <= s.length; k += 1) {
      expect(walkPrefixSK(s, k)).toEqual(s.slice(0, k));
      expect(prefixMonotoneAt(s, k)).toBe(true);
    }
    expect(captured.prefix_proposal).toEqual(walkPrefixSK(s, captured.K));
    expect(captured.prefix_proposal).toEqual(prefixSK(s, captured.K));
  });

  it("binds the frozen D0 digest and version", () => {
    const on = fineAssess({
      ...assessParams(fieldCandidates()),
      captureShadowTrace: true,
      shadowObservationField: plantedTransitivity()
    });
    const captured = asCaptured(on.shadowTrace);
    expect(captured.digest).toBe(
      "8f287df50610b28a3b40921b9bce765164794d6d4afd17c246e6807e768773fa"
    );
    expect(captured.digest).toBe(D0_IDENTITY_DIGEST);
    expect(captured.version).toBe("d0.safe-dominance-capture.v1.0.0");
    expect(captured.c0_seam.activation).toBe("inactive");
    expect(captured.c0_seam.future_delivery_order).toBe("prefixSK(S_infty, K)");
    expect(captured.c0_seam.rollback).toBe("deliverFineAssessment");
  });

  it("excludes Graph/Path/Flood O and FrontierPriority from G", () => {
    const on = fineAssess({
      ...assessParams(fieldCandidates()),
      captureShadowTrace: true,
      shadowObservationField: plantedTransitivity()
    });
    const captured = asCaptured(on.shadowTrace);
    const serialized = JSON.stringify(captured);
    expect(serialized).not.toMatch(/"lineage":"(graph|path|flood|relation)"/u);
    expect(serialized).not.toContain("FrontierPriority");
    expect(serialized).not.toContain("frontier_priority");
    expect(captured.relational_o).toBe("excluded");
    expect(captured.admitted_lineages).toEqual(SHADOW_LINEAGE_IDS);
    for (const decision of captured.decisions) {
      expect(Object.keys(decision.G)).not.toContain("FrontierPriority");
    }
  });

  it("maps live ftsRanks as lexical not_observed unless a field is planted", () => {
    const honest = captureShadowIntegration(shadowInput());
    const planted = captureShadowIntegration({
      ...shadowInput(),
      observationField: plantedTransitivity()
    });
    expect(asCaptured(honest).lexical_mapping).toBe("not_observed");
    expect(asCaptured(planted).lexical_mapping).toBe("planted");
  });

  it("fails closed on membership shrink without throwing", () => {
    const keys = IDS.map(keyOf);
    const trace = captureShadowIntegration({
      ...shadowInput(),
      e0Keys: [...keys, "missing-e0"],
      e1Keys: keys
    });
    expect(trace).toMatchObject({
      kind: "fail_closed",
      reason: "membership_shrink",
      digest: D0_IDENTITY_DIGEST
    });
  });
});

function asCaptured(trace: FineAssessmentShadowTrace | undefined): ShadowCapturedTrace {
  expect(trace).toBeDefined();
  expect(isFailClosedShadowTrace(trace!)).toBe(false);
  if (trace === undefined || isFailClosedShadowTrace(trace)) {
    throw new Error("expected captured shadow trace");
  }
  return trace;
}

function productionSlice(result: ReturnType<typeof fineAssess>) {
  const { shadowTrace: _shadowTrace, ...rest } = result;
  return rest;
}

function prefixMonotoneAt(S_infty: readonly string[], k: number): boolean {
  const prefix = walkPrefixSK(S_infty, k);
  const next = walkPrefixSK(S_infty, k + 1);
  return prefix.every((key, offset) => key === next[offset]);
}

function plantedTransitivity() {
  return field({
    [keyOf("cand-a")]: view({
      temporal: temporalObserved(0.9),
      embedding: embeddingObserved(0.8)
    }),
    [keyOf("cand-b")]: view({
      temporal: temporalObserved(0.6),
      embedding: embeddingObserved(0.7)
    }),
    [keyOf("cand-c")]: view({
      temporal: temporalObserved(0.3),
      embedding: embeddingObserved(0.2)
    })
  });
}

function keyOf(objectId: string): string {
  return `workspace_local:memory_entry:${objectId}`;
}

function shadowInput() {
  const candidates = fieldCandidates();
  return {
    candidates,
    policy: policy(),
    supplementaryData: supplementaryWithInflow(candidates),
    tokenEstimator: { estimate: () => 4 }
  };
}

function assessParams(candidates: readonly CoarseRecallCandidate[]) {
  return {
    ...FIELD_PINS,
    candidates,
    policy: policy(),
    winnerMemoryIds: new Set<string>(),
    supplementaryData: supplementaryWithInflow(candidates),
    tokenEstimator: { estimate: () => 4 },
    now: () => NOW,
    warn: vi.fn()
  };
}

function policy() {
  return buildDefaultPolicy({
    strategy: "build",
    taskSurfaceRef: "task-surface-1",
    now: () => NOW,
    generateRuntimeId: () => "33333333-3333-4333-8333-333333333333"
  });
}

function fieldCandidates(): readonly CoarseRecallCandidate[] {
  return IDS.map((objectId, index) => ({
    entry: createMemoryEntry({
      object_id: objectId,
      content: `Operator workspace fact ${index}`,
      activation_score: 0.4 + index * 0.1
    }),
    admissionPlanes: ["activation"],
    firstAdmissionPlane: "activation"
  }));
}

function supplementaryWithInflow(
  candidates: readonly CoarseRecallCandidate[]
): RecallSupplementaryData {
  const ftsRanks: Record<string, number> = {};
  const embeddingSimilarityScores: Record<string, number> = {};
  for (const [index, candidate] of candidates.entries()) {
    ftsRanks[candidate.entry.object_id] = Math.max(0, 1 - index * 0.07);
    embeddingSimilarityScores[candidate.entry.object_id] = 0.2 + index * 0.1;
  }
  return {
    queryProbes: compileRecallQueryProbes("where does the operator work on 2026-03-19?"),
    ftsRanks,
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
    embeddingSimilarityScores,
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
