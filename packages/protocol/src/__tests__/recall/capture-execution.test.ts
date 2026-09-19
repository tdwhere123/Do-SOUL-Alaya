import { describe, expect, it } from "vitest";
import {
  CaptureExecutionReasonSchema,
  CaptureExecutionSchema
} from "../../recall/selection/capture/capture-execution.js";

describe("capture execution reason", () => {
  it("parses the historical psi_cycle_contract_failure reason as cycle_contract_failure", () => {
    expect(CaptureExecutionReasonSchema.parse("psi_cycle_contract_failure")).toBe("cycle_contract_failure");
    expect(CaptureExecutionSchema.parse({
      status: "fail_closed",
      reason: "psi_cycle_contract_failure"
    })).toEqual({
      status: "fail_closed",
      reason: "cycle_contract_failure"
    });
  });

  it("parses the canonical cycle_contract_failure reason unchanged", () => {
    expect(CaptureExecutionReasonSchema.parse("cycle_contract_failure")).toBe("cycle_contract_failure");
    expect(CaptureExecutionSchema.parse({
      status: "fail_closed",
      reason: "cycle_contract_failure"
    })).toEqual({
      status: "fail_closed",
      reason: "cycle_contract_failure"
    });
  });
});
