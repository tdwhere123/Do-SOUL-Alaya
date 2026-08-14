import { describe, expect, it } from "vitest";

import {
  baselineCandidates,
  baselineIds,
  consensusCandidates,
  packetIds,
  select,
  withEmbeddingRank
} from "./final-strict-tail-consensus-fixtures.js";

describe("Select_Γ coverage order", () => {
  it("does not let consensus replace coverage membership", () => {
    const result = select(consensusCandidates(), { capturePacketPlanTrace: true });

    expect(packetIds(result)).not.toContain("challenger");
    expect(result.packetPlanObservation?.decision.status).toBe("rejected");
    expect(result.packetPlanObservation?.decision.reason).toBe("coverage_order_retained");
  });

  it("does not let consensus reorder the same coverage members", () => {
    const baseline = baselineCandidates();
    const reordered = baseline.map((candidate, index) =>
      withEmbeddingRank(
        candidate,
        index === baseline.length - 1 ? 1 : index + 2
      )
    );
    const result = select(reordered, { capturePacketPlanTrace: true });
    const observation = result.packetPlanObservation;

    expect(packetIds(result)).toEqual(baselineIds());
    expect(observation?.decision).toEqual({
      status: "rejected",
      reason: "coverage_order_retained"
    });
    expect(observation?.planned_candidate_keys)
      .not.toEqual(observation?.actual_candidate_keys);
  });
});
