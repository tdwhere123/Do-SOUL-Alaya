import { describe, expect, it, vi } from "vitest";
import { recallMaterializationWiringTestInternals } from "../../runtime/recall-materialization-wiring.js";

const { closeRecallReadWorkerAfterStartupFailure } = recallMaterializationWiringTestInternals;

describe("createRecallMaterializationWiring startup cleanup", () => {
  it("closes a started recall read worker and rethrows the original startup error", async () => {
    const startupError = new Error("config unavailable");
    const close = vi.fn(async () => undefined);
    const warn = vi.fn();

    await expect(
      closeRecallReadWorkerAfterStartupFailure({
        recallReadWorkerClient: { close },
        warn,
        error: startupError
      })
    ).rejects.toBe(startupError);

    expect(close).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns on worker cleanup failure while preserving the startup error", async () => {
    const startupError = new Error("startup failed");
    const close = vi.fn(async () => {
      throw new Error("close failed");
    });
    const warn = vi.fn();

    await expect(
      closeRecallReadWorkerAfterStartupFailure({
        recallReadWorkerClient: { close },
        warn,
        error: startupError
      })
    ).rejects.toBe(startupError);

    expect(close).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "recall read worker startup cleanup failed",
      expect.objectContaining({ error: "close failed" })
    );
  });
});
