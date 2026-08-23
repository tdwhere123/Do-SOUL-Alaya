import { describe, expect, it } from "vitest";
import {
  baselineIds,
  consensusCandidates,
  packetIds,
  select
} from "./final-strict-tail-consensus-fixtures.js";

describe("Select_Gamma final selection ownership", () => {
  it("does not admit a challenger after Select_Gamma", () => {
    const result = select(consensusCandidates());

    expect(result.candidates.map((candidate) => candidate.object_id))
      .not.toContain("challenger");
    expect(result.diagnostics.every((candidate) =>
      candidate.admission_attempts.length === 1 &&
      candidate.admission_attempts[0]?.pass === "final_selector"
    )).toBe(true);
    expect(result.diagnostics.find((candidate) =>
      candidate.object_id === "challenger"
    )).toMatchObject({ final_rank: null, dropped_reason: "quality_displaced" });
  });

  it("publishes Gamma order as an identity packet observation", () => {
    const result = select(consensusCandidates(), {
      capturePacketPlanTrace: true,
      maxTotalTokens: 50,
      tokenByObjectId: { challenger: 10 }
    });

    expect(packetIds(result)).toEqual(baselineIds());
    expect(result.packetPlanObservation?.decision).toEqual({
      status: "no_op",
      reason: "select_gamma_identity"
    });
    expect(result.packetPlanObservation?.planned_candidate_keys)
      .toEqual(result.packetPlanObservation?.actual_candidate_keys);
  });
});
