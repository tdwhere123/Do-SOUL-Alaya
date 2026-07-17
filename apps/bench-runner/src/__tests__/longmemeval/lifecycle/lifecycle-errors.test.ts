import { describe, expect, it } from "vitest";
import { throwLifecycleErrors } from "../../../longmemeval/lifecycle/errors.js";

describe("benchmark lifecycle errors", () => {
  it("preserves primary, shutdown, and cleanup failures in order", () => {
    const primary = new Error("primary");
    const shutdown = new Error("shutdown");
    const cleanup = new Error("cleanup");
    try {
      throwLifecycleErrors("run lifecycle failed", [primary, shutdown, cleanup]);
      throw new Error("expected lifecycle failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([primary, shutdown, cleanup]);
      expect((error as Error & { cause?: unknown }).cause).toBe(primary);
    }
  });
});
