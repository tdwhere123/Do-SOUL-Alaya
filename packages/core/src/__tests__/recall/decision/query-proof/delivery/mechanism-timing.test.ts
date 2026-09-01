import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  captureShadowIntegration,
  isFailClosedShadowTrace
} from "../../../../../recall/integration/shadow/integrate.js";
import { observeShadowMechanismTiming } from
  "../../../integration/shadow/mechanism-timing.js";
import { buildDefaultPolicy } from "../../../../../recall/runtime/orchestration.js";
import { compileRecallQueryProbes } from
  "../../../../../recall/query/recall-query-probes.js";
import type { CoarseRecallCandidate } from
  "../../../../../recall/runtime/recall-service-types.js";
import { createMemoryEntry } from "../../../recall-service-test-fixtures.js";

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../");

describe("shadow mechanism timing observation", () => {
  it("times captureShadowIntegration without attaching timing to the trace", () => {
    const { value: trace, timing } = observeShadowMechanismTiming({
      mechanism_id: "captureShadowIntegration",
      run: captureLive
    });
    expect(timing.evidence_class).toBe("mechanism_timing");
    expect(timing.observation_status).toBe("observed");
    expect(timing.mechanism_id).toBe("captureShadowIntegration");
    expect(Number.isFinite(timing.elapsed_ms)).toBe(true);
    expect(timing.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(trace)).not.toContain("mechanism_timing");
    expect(JSON.stringify(trace)).not.toContain("elapsed_ms");
    const canonical = readFileSync(
      path.join(SRC_ROOT, "recall/delivery/canonical-delivery.ts"), "utf8");
    const index = readFileSync(path.join(SRC_ROOT, "index.ts"), "utf8");
    expect(canonical).not.toContain("mechanism_timing");
    expect(index).not.toContain("mechanism_timing");
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
