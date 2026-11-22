import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreError } from "@do-soul/alaya-core";
import { formatFileSecretRef } from "@do-soul/alaya-protocol";
import { resolveAlayaConfigPaths } from "../../cli/support/config-files.js";
import { withRuntimeEmbeddingConfigLock } from "../../services/env-file/env-file-io.js";
import {
  normalizeRuntimeEmbeddingConfigPatch,
  normalizeRuntimeGardenComputeConfigPatch
} from "../../services/env-file/env-file-service.js";

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

describe("normalizeRuntimeEmbeddingConfigPatch paste platform policy", () => {
  const paths = resolveAlayaConfigPaths(path.join(path.sep, "tmp", "alaya-config"));
  const secretPath = path.join(paths.secretsDir, "openai");

  it.each([
    { platform: "linux" as const, supported: true },
    { platform: "darwin" as const, supported: true },
    { platform: "win32" as const, supported: false }
  ])("paste mode on $platform", ({ platform, supported }) => {
    const patch = {
      secret_ref_mode: "paste",
      secret_value: "sk-test-plaintext-secret"
    };

    if (supported) {
      expect(normalizeRuntimeEmbeddingConfigPatch(patch, paths, platform)).toEqual({
        patch: {
          secret_ref: formatFileSecretRef(secretPath)
        },
        pastedSecret: {
          path: secretPath,
          value: "sk-test-plaintext-secret"
        }
      });
      return;
    }

    expect(() => normalizeRuntimeEmbeddingConfigPatch(patch, paths, platform)).toThrow(CoreError);
    expect(() => normalizeRuntimeEmbeddingConfigPatch(patch, paths, platform)).toThrow(
      "paste mode is not supported on win32"
    );
  });
});

describe("runtime file secret refs stay inside the secrets directory", () => {
  const paths = resolveAlayaConfigPaths(path.join(path.sep, "tmp", "alaya-config"));
  const containedPath = path.join(paths.secretsDir, "openai");

  it("accepts a file: ref under the secrets directory", () => {
    expect(
      normalizeRuntimeEmbeddingConfigPatch(
        { secret_ref: formatFileSecretRef(containedPath) },
        paths,
        "linux"
      )
    ).toEqual({
      patch: { secret_ref: formatFileSecretRef(path.resolve(containedPath)) },
      pastedSecret: null
    });
  });

  it("rejects a file: ref outside the secrets directory", () => {
    try {
      normalizeRuntimeEmbeddingConfigPatch(
        { secret_ref: "file:/etc/passwd" },
        paths,
        "linux"
      );
      expect.fail("expected embedding file: ref to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CoreError);
      expect((error as CoreError).code).toBe("VALIDATION");
    }
    try {
      normalizeRuntimeGardenComputeConfigPatch(
        {
          secret_ref_mode: "file",
          secret_value: "/etc/passwd"
        },
        paths,
        "linux"
      );
      expect.fail("expected garden file: ref to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CoreError);
      expect((error as CoreError).code).toBe("VALIDATION");
    }
  });

  it("rejects a private provider_url on runtime patches", () => {
    expect(() =>
      normalizeRuntimeEmbeddingConfigPatch(
        { provider_url: "http://169.254.169.254/latest/meta-data/" },
        paths,
        "linux"
      )
    ).toThrow(CoreError);
    expect(() =>
      normalizeRuntimeGardenComputeConfigPatch(
        { provider_url: "http://127.0.0.1:11434/v1" },
        paths,
        "linux"
      )
    ).toThrow(CoreError);
  });
});
