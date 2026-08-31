import { describe, expect, it } from "vitest";
import { compileRecallQueryProbes } from
  "../../../../../recall/query/recall-query-probes.js";
import { buildDefaultPolicy } from "../../../../../recall/runtime/orchestration.js";
import { buildRecallCandidateDedupeKey } from
  "../../../../../recall/runtime/recall-service-helpers.js";
import { captureShadowIntegration } from
  "../../../../../recall/integration/shadow/integrate.js";
import { createQueryCompiledWalkTransfer } from
  "../../../../../recall/decision/query-proof/gamma/walk-binding.js";

import { fieldCandidates } from "../../../delivery/canonical-delivery-fixtures.js";
import {
  binding,
  candidate,
  compileGamma,
  scalarQuery
} from "../gamma/gamma-fixture.js";

describe("query-proof preview neutrality", () => {
  it("preview-on/off leaves selected keys and prefix order unchanged", () => {
    const candidates = fieldCandidates(["cand-a", "cand-b"]);
    const keys = candidates.map(buildRecallCandidateDedupeKey);
    const compiled = compileGamma(scalarQuery(), keys.map((key) =>
      candidate(key, { bindings: [binding(key)] })));
    const base = {
      candidates,
      policy: buildDefaultPolicy({
        strategy: "build",
        taskSurfaceRef: "task-surface-1",
        now: () => "2026-07-12T00:00:00.000Z",
        generateRuntimeId: () => "33333333-3333-4333-8333-333333333333"
      }),
      supplementaryData: {
        queryProbes: compileRecallQueryProbes("where does the operator work?"),
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
    };
    const offCounts = { estimate: 0, cache: 0 };
    const onCounts = { estimate: 0, cache: 0 };
    const frozenSupplementary = Object.freeze({ ...base.supplementaryData });
    const offSupplementary = new Proxy(frozenSupplementary, {
      get(target, property, receiver) {
        offCounts.cache += 1;
        return Reflect.get(target, property, receiver);
      }
    });
    const onSupplementary = new Proxy(frozenSupplementary, {
      get(target, property, receiver) {
        onCounts.cache += 1;
        return Reflect.get(target, property, receiver);
      }
    });
    const off = captureShadowIntegration({
      ...base,
      supplementaryData: offSupplementary,
      tokenEstimator: { estimate: () => { offCounts.estimate += 1; return 4; } }
    });
    const on = captureShadowIntegration({
      ...base,
      supplementaryData: onSupplementary,
      tokenEstimator: { estimate: () => { onCounts.estimate += 1; return 4; } },
      query_proof_preview: {
        utility_transfer: createQueryCompiledWalkTransfer(compiled)
      }
    });
    expect(off.kind).toBe("captured");
    expect(on.kind).toBe("captured");
    if (off.kind !== "captured" || on.kind !== "captured") throw new Error("expected");
    expect(on.S_infty).toEqual(off.S_infty);
    expect(on.prefix_proposal).toEqual(off.prefix_proposal);
    expect(on.eligible_keys).toEqual(off.eligible_keys);
    expect("query_proof_preview" in off).toBe(false);
    expect(on.query_proof_preview?.status).toBe("captured");
    expect(on.query_proof_preview?.contract_digest).toMatch(/^sha256:/u);
    expect(onCounts.estimate).toBe(offCounts.estimate);
    expect(onCounts.cache).toBe(offCounts.cache);
  });

  it("keeps live capture when the opt-in preview sidecar fails", () => {
    const candidates = fieldCandidates(["cand-a"]);
    const compiled = compileGamma(scalarQuery(), [
      candidate(buildRecallCandidateDedupeKey(candidates[0]!), {
        bindings: [binding("alice")]
      })
    ]);
    const transfer = createQueryCompiledWalkTransfer(compiled);
    const captured = captureShadowIntegration({
      candidates,
      policy: buildDefaultPolicy({
        strategy: "build",
        taskSurfaceRef: "task-surface-1",
        now: () => "2026-07-12T00:00:00.000Z",
        generateRuntimeId: () => "33333333-3333-4333-8333-333333333333"
      }),
      supplementaryData: {
        queryProbes: compileRecallQueryProbes("where does the operator work?"),
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
      tokenEstimator: { estimate: () => 4 },
      query_proof_preview: {
        utility_transfer: {
          ...transfer,
          score: () => {
            throw new Error("preview transfer failed");
          }
        }
      }
    });
    expect(captured.kind).toBe("captured");
    if (captured.kind !== "captured") throw new Error("expected");
    expect(captured.query_proof_preview?.status).toBe("failed");
    expect(captured.S_infty.length).toBeGreaterThan(0);
  });
});
