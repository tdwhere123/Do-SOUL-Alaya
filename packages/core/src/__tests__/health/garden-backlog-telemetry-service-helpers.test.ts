import { afterEach, describe, expect, it, vi } from "vitest";
import { raceWithTimeout } from "../../health/garden-backlog-telemetry-service-helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("raceWithTimeout", () => {
  it("resolves false when the timeout wins", async () => {
    await expect(raceWithTimeout(new Promise<string>(() => undefined), 10)).resolves.toBe(false);
  });

  it("propagates a rejection that finishes within the bound", async () => {
    await expect(raceWithTimeout(Promise.reject(new Error("boom")), 1_000)).rejects.toThrow("boom");
  });

  it("does not raise an unhandledRejection when the abandoned promise rejects after timeout", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      let rejectLate: (reason: unknown) => void = () => {};
      const promise = new Promise<never>((_resolve, reject) => {
        rejectLate = reject;
      });

      await expect(raceWithTimeout(promise, 10)).resolves.toBe(false);

      rejectLate(new Error("late telemetry drain failure"));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
