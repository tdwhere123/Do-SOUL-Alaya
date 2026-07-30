import { describe, expect, it, vi } from "vitest";
import { enqueueRecallReadRequest } from "../../../runtime/recall-read-worker/request-queue.js";

describe("enqueueRecallReadRequest", () => {
  it("keeps per-request failures off the unexpected path when handle settles", async () => {
    const onUnexpectedFailure = vi.fn();
    let settled = false;

    const next = enqueueRecallReadRequest(
      Promise.resolve(),
      async () => {
        // Per-request handlers catch and settle; a resolved handle must not fatal.
        settled = true;
      },
      onUnexpectedFailure
    );

    await expect(next).resolves.toBeUndefined();
    expect(settled).toBe(true);
    expect(onUnexpectedFailure).not.toHaveBeenCalled();
  });

  it("reports unexpected queue-chain rejection instead of swallowing it", async () => {
    const boom = new Error("handler escaped");
    let resolveReported!: () => void;
    const reported = new Promise<void>((resolve) => {
      resolveReported = resolve;
    });
    const onUnexpectedFailure = vi.fn(() => {
      resolveReported();
    });

    const fatal = enqueueRecallReadRequest(
      Promise.resolve(),
      async () => {
        throw boom;
      },
      onUnexpectedFailure
    );

    await reported;
    expect(onUnexpectedFailure).toHaveBeenCalledTimes(1);
    expect(onUnexpectedFailure).toHaveBeenCalledWith(boom);

    let continued = false;
    void enqueueRecallReadRequest(
      fatal,
      async () => {
        continued = true;
      },
      vi.fn()
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(continued).toBe(false);
  });
});
