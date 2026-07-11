import { afterEach, describe, expect, it, vi } from "vitest";
import { withRuntimeEmbeddingConfigLock } from "../../services/env-file-io.js";

describe("withRuntimeEmbeddingConfigLock", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not emit unhandledRejection when a lone lock operation fails", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    await expect(
      withRuntimeEmbeddingConfigLock("lone-failure-key", async () => {
        throw new Error("lone write failed");
      })
    ).rejects.toThrow("lone write failed");

    await Promise.resolve();
    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
  });

  it("warns when a prior lock-chain promise rejects", async () => {
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);

    const first = withRuntimeEmbeddingConfigLock("lock-key", async () => {
      throw new Error("first write failed");
    });
    const second = withRuntimeEmbeddingConfigLock("lock-key", async () => "second");

    await expect(first).rejects.toThrow("first write failed");
    await expect(second).resolves.toBe("second");

    expect(emitWarning).toHaveBeenCalledWith(
      "[EnvFileIo] prior runtime-embedding-config rejected; continuing lock chain",
      expect.objectContaining({
        code: "ALAYA_ENV_FILE_IO_LATE_REJECT",
        detail: expect.stringContaining("first write failed")
      })
    );
  });

  it("times out when the lock chain does not drain", async () => {
    vi.useFakeTimers();

    void withRuntimeEmbeddingConfigLock("blocked-key", async () => {
      await new Promise<void>(() => undefined);
    });

    const pending = withRuntimeEmbeddingConfigLock("blocked-key", async () => "done");
    const rejection = expect(pending).rejects.toMatchObject({
      code: "CONFLICT",
      message: "runtime-embedding-config lock wait timed out"
    });

    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;
  });

  it("keeps chain ownership after waiter timeout so later callers still serialize behind the holder", async () => {
    vi.useFakeTimers();

    let concurrentHolders = 0;
    let maxConcurrentHolders = 0;
    let cStarted = false;

    void withRuntimeEmbeddingConfigLock("serialize-key", async () => {
      concurrentHolders += 1;
      maxConcurrentHolders = Math.max(maxConcurrentHolders, concurrentHolders);
      try {
        await new Promise<void>(() => undefined);
      } finally {
        concurrentHolders -= 1;
      }
    });

    const waiterB = withRuntimeEmbeddingConfigLock("serialize-key", async () => "B");

    await vi.advanceTimersByTimeAsync(29_000);

    // C must enqueue before B times out — successors must await the live holder,
    // not a timed-out intermediate waiter whose rejection was swallowed.
    void withRuntimeEmbeddingConfigLock("serialize-key", async () => {
      cStarted = true;
      concurrentHolders += 1;
      maxConcurrentHolders = Math.max(maxConcurrentHolders, concurrentHolders);
      concurrentHolders -= 1;
      return "C";
    }).catch(() => undefined);

    const waiterBRejection = expect(waiterB).rejects.toMatchObject({
      code: "CONFLICT",
      message: "runtime-embedding-config lock wait timed out"
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await waiterBRejection;

    await vi.advanceTimersByTimeAsync(0);
    expect(cStarted).toBe(false);
    expect(maxConcurrentHolders).toBe(1);
  });
});
