import { afterEach, describe, expect, it, vi } from "vitest";
import { fineAssess } from "../../../recall/delivery/fine-assessment.js";
import { compileRecallQueryProbes } from "../../../recall/query/recall-query-probes.js";
import { buildDefaultPolicy } from "../../../recall/runtime/orchestration.js";
import { buildRecallLogicalObjectKey } from "../../../recall/runtime/recall-service-helpers.js";
import type {
  CoarseRecallCandidate,
  RecallSupplementaryData
} from "../../../recall/runtime/recall-service-types.js";
import { ShadowContractError } from "../../../recall/shadow/envelope.js";
import { isPsiCycleFailure, peelUndominated } from "../../../recall/shadow/frontier-peel.js";
import * as psiV2 from "../../../recall/shadow/psi-v2/index.js";
import type { ShadowFrontierReceipt } from "../../../recall/shadow/frontiers.js";
import {
  CAPTURE_IDENTITY_DIGEST,
  SHADOW_ALGORITHM_VERSION,
  SHADOW_LINEAGE_IDS
} from "../../../recall/shadow/index.js";
import {
  captureShadowIntegration,
  isFailClosedShadowTrace,
  memoizeRequestPsi,
  prefixSK,
  SHADOW_CUTOVER_SEAM,
  type FineAssessmentShadowTrace,
  type PsiQuery,
  type ShadowCapturedTrace
} from "../../../recall/shadow/integrate.js";
import {
  isCapturedWalk,
  prefixSK as walkPrefixSK,
  walkShadowCapture,
  type ShadowCaptureWalkCandidate
} from "../../../recall/shadow/walk.js";
import { FIELD_PINS } from "../fine-assessment-selection-fixtures.js";
import { createMemoryEntry, withFineDeliveryPath } from "../recall-service-test-fixtures.js";
import {
  embeddingObserved,
  field,
  temporalObserved,
  view
} from "./psi-test-support.js";

const NOW = "2026-07-12T00:00:00.000Z";
const IDS = ["cand-a", "cand-b", "cand-c"] as const;
const THREE_CANDIDATE_UNCACHED_PSI_CALLS = 14;

describe("shadow integration at fineAssess", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("planted guard: shadow cannot change production ids, order, or delivery diagnostics", () => {
    const params = assessParams(fieldCandidates(), "legacy");
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
    const params = assessParams(fieldCandidates(), "legacy");
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
      digest: CAPTURE_IDENTITY_DIGEST,
      cutover_seam: SHADOW_CUTOVER_SEAM
    });
  });

  it("evaluates each directed Psi pair once across canonical capture", () => {
    const keys = IDS.map(keyOf);
    const a = keys[0]!;
    const b = keys[1]!;
    const planted: PsiQuery = (dominator, dominated) =>
      directedPair(dominator, dominated) === directedPair(a, b);
    const candidates = fieldCandidates();
    const params = assessParams(candidates);
    const memoized = countingPsi(planted);
    const actual = fineAssess({ ...params, shadowPsi: memoized.fn });
    const captured = asCaptured(actual.shadowTrace);
    const uncached = countingPsi(planted);
    const peeled = peelUndominated(captured.eligible_keys, uncached.fn);
    expect(isPsiCycleFailure(peeled)).toBe(false);
    if (isPsiCycleFailure(peeled)) return;
    const walked = walkShadowCapture({
      candidates: walkCandidatesFrom(candidates, captured, peeled),
      psi: uncached.fn,
      token_budget: params.policy.fine_assessment.budgets.max_total_tokens,
      per_dimension_limits: params.policy.fine_assessment.budgets.per_dimension_limits
    });
    expect(isCapturedWalk(walked)).toBe(true);
    if (!isCapturedWalk(walked)) return;

    expect(peeled).toEqual(captured.frontiers);
    expect(walked.S_infty).toEqual(captured.S_infty);
    expect(walked.decisions).toEqual(captured.decisions);
    expect(walked.walk_rejects).toEqual(captured.walk_rejects);
    expect(actual.candidates.map((candidate) => keyOf(candidate.object_id)))
      .toEqual(captured.prefix_proposal);
    expect(memoized.total()).toBe(memoized.calls.size);
    expect(memoized.calls.size).toBe(keys.length * keys.length);
    expect(memoized.calls.get(directedPair(a, b))).toBe(1);
    expect(memoized.calls.get(directedPair(b, a))).toBe(1);
    expect(uncached.total()).toBe(THREE_CANDIDATE_UNCACHED_PSI_CALLS);
    expect(uncached.total()).toBeGreaterThan(memoized.calls.size);
  });

  it("keeps Psi failures request-local and observable", () => {
    const failure = new Error("planted Psi failure");
    const a = keyOf(IDS[0]);
    const b = keyOf(IDS[1]);
    let shouldFail = true;
    const wrapped = memoizeRequestPsi((dominator, dominated) => {
      if (shouldFail && dominator === a && dominated === b) {
        shouldFail = false;
        throw failure;
      }
      return false;
    });
    expect(() => wrapped(a, b)).toThrow(failure);
    expect(wrapped(a, b)).toBe(false);

    shouldFail = true;
    const requestPsi: PsiQuery = () => {
      if (shouldFail) {
        shouldFail = false;
        throw failure;
      }
      return false;
    };
    expect(() => captureShadowIntegration({ ...shadowInput(), psi: requestPsi }))
      .toThrow(failure);
    expect(asCaptured(captureShadowIntegration({ ...shadowInput(), psi: requestPsi })).kind)
      .toBe("captured");
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

  it("binds the frozen capture digest and version", () => {
    const on = fineAssess({
      ...assessParams(fieldCandidates()),
      captureShadowTrace: true,
      shadowObservationField: plantedTransitivity()
    });
    const captured = asCaptured(on.shadowTrace);
    expect(captured.digest).toBe(
      "384af589ca9be6791147016463a44519aa9405a70d694cf38a1db9b8991913cd"
    );
    expect(captured.digest).toBe(CAPTURE_IDENTITY_DIGEST);
    expect(captured.version).toBe("safe-dominance-capture.v1.0.1");
    expect(captured.cutover_seam.activation).toBe("active");
    expect(captured.cutover_seam.future_delivery_order).toBe("prefixSK(S_infty, K)");
    expect(captured.cutover_seam.rollback).toBe("deliverFineAssessment");
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

  it("maps collapsed ftsRanks as lexical not_observed unless a field is planted", () => {
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
      digest: CAPTURE_IDENTITY_DIGEST
    });
  });

  it("keeps captured delivery when psi v2 diagnostics throw", () => {
    vi.spyOn(psiV2, "buildPsiV2ShadowDiagnostics").mockImplementation(() => {
      throw new ShadowContractError("planted diagnostic failure");
    });
    const trace = captureShadowIntegration(shadowInput());
    expect(isFailClosedShadowTrace(trace)).toBe(false);
    expect(asCaptured(trace).psi_v2_shadow).toMatchObject({
      observation_status: "malformed",
      producer_outcomes: [
        { producer_id: "lex.interval", status: "malformed",
          contract_code: "diagnostic_contract_failure" },
        { producer_id: "support", status: "malformed",
          contract_code: "diagnostic_contract_failure" }
      ]
    });
  });

  it("renders typed producer absence without requiring query or snapshot pins", () => {
    const spy = vi.spyOn(psiV2, "buildPsiV2ShadowDiagnostics");
    const missingBoth = asCaptured(captureShadowIntegration(shadowInput()));
    const missingSnapshot = asCaptured(captureShadowIntegration({
      ...shadowInput(),
      query_id: "query-observed"
    }));
    const missingQuery = asCaptured(captureShadowIntegration({
      ...shadowInput(),
      snapshot_digest: "snapshot-observed"
    }));
    for (const trace of [missingBoth, missingSnapshot, missingQuery]) {
      expect(trace.psi_v2_shadow).toMatchObject({
        observation_status: "not_observed",
        producer_outcomes: [
          { producer_id: "lex.interval", status: "not_observed", reason: "input_absent" },
          { producer_id: "support", status: "not_observed", reason: "input_absent" }
        ]
      });
    }
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("passes valid query and snapshot pins to psi v2 diagnostics", () => {
    const spy = vi.spyOn(psiV2, "buildPsiV2ShadowDiagnostics");
    const trace = asCaptured(captureShadowIntegration({
      ...shadowInput(),
      query_id: "query-observed",
      snapshot_digest: "snapshot-observed"
    }));
    expect(spy.mock.calls[0]?.[0]).toMatchObject({
      query_id: "query-observed",
      snapshot_digest: "snapshot-observed"
    });
    expect(trace.psi_v2_shadow).toMatchObject({ observation_status: "not_observed" });
  });
});

function countingPsi(psi: PsiQuery): {
  readonly fn: PsiQuery;
  readonly calls: Map<string, number>;
  readonly total: () => number;
} {
  const calls = new Map<string, number>();
  return {
    calls,
    fn: (dominator, dominated) => {
      const pair = directedPair(dominator, dominated);
      calls.set(pair, (calls.get(pair) ?? 0) + 1);
      return psi(dominator, dominated);
    },
    total: () => [...calls.values()].reduce((sum, count) => sum + count, 0)
  };
}

function walkCandidatesFrom(
  candidates: readonly CoarseRecallCandidate[],
  captured: ShadowCapturedTrace,
  frontiers: ShadowFrontierReceipt
): ShadowCaptureWalkCandidate[] {
  const indexByKey = new Map<string, number>();
  for (const layer of frontiers.layers) {
    for (const key of layer.member_keys) indexByKey.set(key, layer.index);
  }
  return candidates.map((candidate, offset) => {
    const key = keyOf(candidate.entry.object_id);
    return {
      candidate_key: key,
      object_key: buildRecallLogicalObjectKey(candidate),
      token_cost: 4,
      dimension: candidate.entry.dimension,
      h_eligible: captured.observations_by_candidate_key[key]?.h_gate === "none",
      utility: captured.set_utilities[offset]!,
      static_frontier_index: indexByKey.get(key) ?? null
    };
  });
}

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

function directedPair(dominator: string, dominated: string): string {
  return JSON.stringify([dominator, dominated]);
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

function assessParams(
  candidates: readonly CoarseRecallCandidate[],
  path: "legacy" | "canonical" = "canonical"
) {
  return {
    ...FIELD_PINS,
    candidates,
    policy: withFineDeliveryPath(policy(), path),
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
