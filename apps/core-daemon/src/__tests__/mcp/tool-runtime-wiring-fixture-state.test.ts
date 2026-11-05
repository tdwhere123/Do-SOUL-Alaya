import { describe, expect, it, vi } from "vitest";
import { getToolRuntimeWiringHoisted } from "./tool-runtime-wiring-fixture-state.js";

describe("tool runtime wiring transaction fake", () => {
  it.each(["default", "deferred", "immediate", "exclusive"] as const)(
    "forwards arguments, results, and errors through the %s transaction mode",
    (mode) => {
      const { database } = getToolRuntimeWiringHoisted();
      const callback = vi.fn((...args: readonly unknown[]) => Number(args[0]) + 1);
      const transaction = database.connection.transaction(callback);
      const run = mode === "default" ? transaction : transaction[mode];

      expect(callback).not.toHaveBeenCalled();
      expect(run(41)).toBe(42);
      expect(callback).toHaveBeenCalledExactlyOnceWith(41);

      const failure = new Error("transaction callback failed");
      callback.mockImplementationOnce(() => { throw failure; });
      expect(() => run(0)).toThrow(failure);
    }
  );
});
