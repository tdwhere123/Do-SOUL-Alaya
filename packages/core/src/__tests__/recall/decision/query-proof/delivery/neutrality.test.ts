import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CAPTURE_IDENTITY_DIGEST } from
  "../../../../../recall/decision/prefix-capture/identity.js";
import {
  SEAL_UNBOUND_HOLE,
  unavailableDeliveryDigest
} from "../../../../../recall/decision/query-proof/delivery/contract.js";
import { parseCertifiedDeliveryPack } from
  "../../../../../recall/decision/query-proof/delivery/pack.js";
import { validateConsumerAction } from
  "../../../../../recall/decision/query-proof/delivery/validate.js";
import {
  captureShadowIntegration,
  isFailClosedShadowTrace
} from "../../../../../recall/integration/shadow/integrate.js";
import { buildDefaultPolicy } from "../../../../../recall/runtime/orchestration.js";
import { compileRecallQueryProbes } from
  "../../../../../recall/query/recall-query-probes.js";
import type { CoarseRecallCandidate } from
  "../../../../../recall/runtime/recall-service-types.js";
import { createMemoryEntry } from "../../../recall-service-test-fixtures.js";

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../");

describe("delivery pack public neutrality", () => {
  it("keeps delivery_pack off hashed canonical receipt and package-root exports", () => {
    const canonical = readFileSync(path.join(SRC_ROOT, "recall/delivery/canonical-delivery.ts"),
      "utf8");
    const index = readFileSync(path.join(SRC_ROOT, "index.ts"), "utf8");
    const results = readFileSync(
      path.join(SRC_ROOT, "recall/runtime/recall-service-results.ts"), "utf8");
    expect(canonical).not.toContain("delivery_pack");
    expect(index).not.toContain("delivery_pack");
    expect(index).not.toContain("query-proof/delivery");
    expect(results).not.toContain("delivery_pack");
  });

  it("explains prefix_sk order without changing membership", () => {
    const captured = captureLive();
    expect(captured.prefix_proposal.length).toBe(2);
    expect(captured.delivery_pack.selected_candidates).not.toEqual(captured.prefix_proposal);
    expect(captured.delivery_pack.selected_candidates).toEqual([]);
    expect(captured.delivery_pack.prefix_authority).toBe("prefix_sk");
    expect(captured.delivery_pack.mode).toBe("unsupported");
    expect(captured.delivery_pack.mode).not.toBe("certified");
    expect(captured.delivery_pack.capture_identity_digest).toBe(CAPTURE_IDENTITY_DIGEST);
    expect(captured.delivery_pack.query_digest).toBe(unavailableDeliveryDigest("query_digest"));
    expect(captured.delivery_pack.holes).toEqual([SEAL_UNBOUND_HOLE]);
    expect(() => parseCertifiedDeliveryPack(captured.delivery_pack)).toThrow(/certified/u);
    expect(validateConsumerAction(captured.delivery_pack, "hidden_reorder").status)
      .toBe("rejected");
    expect(JSON.stringify(captured.delivery_pack)).not.toContain("\"used\"");
  });
});

function captureLive() {
  const candidates: readonly CoarseRecallCandidate[] = ["cand-a", "cand-b"].map(
    (objectId, index) => ({
      entry: createMemoryEntry({
        object_id: objectId,
        content: `fact ${index}`,
        activation_score: 0.4 + index * 0.1
      }),
      admissionPlanes: ["activation"],
      firstAdmissionPlane: "activation"
    })
  );
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
