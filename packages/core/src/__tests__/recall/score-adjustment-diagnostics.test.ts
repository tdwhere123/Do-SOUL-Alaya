import { describe, expect, it } from "vitest";
import { installCoreConfigFromProcessEnv, resetCoreConfigForTests } from "../../config/index.js";
import { clampAgentReportedConfidenceWithDiagnostics } from "../../path-graph/edge-proposals/edge-proposal-service-ports.js";
import {
  scoreSourceProximitySeedDraftWithDiagnostics,
  type CoarseCandidateDraft
} from "../../recall/coarse-filter/coarse-candidates.js";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import {
  resolveDefaultFusionWeightForIntent,
  resolveDefaultFusionWeightForIntentWithDiagnostics
} from "../../recall/scoring/temporal-fusion-scoring.js";
import { createMemoryEntry } from "./recall-service-test-fixtures.js";

describe("score adjustment diagnostics", () => {
  it("reports temporal fusion floors without changing the legacy helper result", () => {
    resetCoreConfigForTests();
    installCoreConfigFromProcessEnv({ ALAYA_RECALL_PROJECTIONS: "on" });
    const probes = compileRecallQueryProbes("what did we decide last week?");

    try {
      expect(resolveDefaultFusionWeightForIntent("temporal_recency", 0, probes)).toBe(4);
      expect(resolveDefaultFusionWeightForIntentWithDiagnostics("temporal_recency", 0, probes)).toEqual({
        weight: 4,
        baseWeight: 0,
        adjustment: "temporal_intent_floor"
      });
    } finally {
      resetCoreConfigForTests();
    }
  });

  it("reports source proximity seed floors", () => {
    const draft: CoarseCandidateDraft = {
      entry: createMemoryEntry({ object_id: "memory-source-proximity" }),
      admissionPlanes: ["evidence_anchor"],
      firstAdmissionPlane: "evidence_anchor",
      sourceChannels: [],
      structuralScore: 0,
      pathExpansionSources: []
    };

    expect(scoreSourceProximitySeedDraftWithDiagnostics(draft)).toEqual({
      strength: 0.95,
      rawStrength: 0.95,
      floorApplied: "evidence_anchor",
      droppedBelowThreshold: false
    });
  });

  it("reports agent confidence caps", () => {
    expect(clampAgentReportedConfidenceWithDiagnostics(0.9)).toEqual({
      confidence: 0.5,
      requestedConfidence: 0.9,
      capApplied: true,
      cap: 0.5
    });
  });
});
