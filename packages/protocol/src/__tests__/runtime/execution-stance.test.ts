import { describe, expect, it } from "vitest";
import {
  ExecutionConservatismOrder,
  ExecutionConservatismSchema,
  ExecutionVerificationAttentionOrder,
  ExecutionVerificationAttentionSchema
} from "../../index.js";

describe("execution stance ordered exports", () => {
  it("exports the verification-attention escalation order from protocol ownership", () => {
    expect(ExecutionVerificationAttentionOrder).toEqual([
      "low",
      "standard",
      "elevated",
      "high"
    ]);

    for (const value of ExecutionVerificationAttentionOrder) {
      expect(ExecutionVerificationAttentionSchema.parse(value)).toBe(value);
    }

    expect(Object.isFrozen(ExecutionVerificationAttentionOrder)).toBe(true);
    expect(
      Object.getOwnPropertyDescriptor(ExecutionVerificationAttentionOrder, "0")?.writable
    ).toBe(false);
  });

  it("exports the conservatism escalation order from protocol ownership", () => {
    expect(ExecutionConservatismOrder).toEqual([
      "permissive",
      "balanced",
      "conservative",
      "strict"
    ]);

    for (const value of ExecutionConservatismOrder) {
      expect(ExecutionConservatismSchema.parse(value)).toBe(value);
    }

    expect(Object.isFrozen(ExecutionConservatismOrder)).toBe(true);
    expect(
      Object.getOwnPropertyDescriptor(ExecutionConservatismOrder, "0")?.writable
    ).toBe(false);
  });
});
