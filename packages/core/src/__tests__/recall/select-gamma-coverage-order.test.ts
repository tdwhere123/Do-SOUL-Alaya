import { describe, expect, it } from "vitest";

import {
  consensusCandidates,
  packetIds,
  select
} from "./final-strict-tail-consensus-fixtures.js";

describe("Select_Γ coverage order", () => {
  it("does not let consensus replace coverage membership", () => {
    const result = select(consensusCandidates(), { capturePacketPlanTrace: true });

    expect(packetIds(result)).not.toContain("challenger");
    expect(result.packetPlanObservation?.decision.status).toBe("rejected");
    expect(result.packetPlanObservation?.decision.reason).toBe("coverage_order_retained");
  });
});
