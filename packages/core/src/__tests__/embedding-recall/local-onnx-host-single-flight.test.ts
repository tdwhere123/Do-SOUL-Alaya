import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  localOnnxHostSingleFlightEnabled,
  resolveLocalOnnxHostLockPath,
  withLocalOnnxHostSingleFlight
} from "../../embedding-recall/local-onnx-host-single-flight.js";

describe("local-onnx-host-single-flight", () => {
  const roots: string[] = [];

  afterEach(() => {
    while (roots.length > 0) {
      rmSync(roots.pop()!, { recursive: true, force: true });
    }
  });

  it("treats only explicit truthy env values as enabled", () => {
    expect(localOnnxHostSingleFlightEnabled({})).toBe(false);
    expect(localOnnxHostSingleFlightEnabled({ ALAYA_LOCAL_ONNX_HOST_SINGLE_FLIGHT: "0" })).toBe(
      false
    );
    expect(localOnnxHostSingleFlightEnabled({ ALAYA_LOCAL_ONNX_HOST_SINGLE_FLIGHT: "1" })).toBe(
      true
    );
    expect(localOnnxHostSingleFlightEnabled({ ALAYA_LOCAL_ONNX_HOST_SINGLE_FLIGHT: "on" })).toBe(
      true
    );
  });

  it("resolves lock path from override or TMPDIR", () => {
    expect(
      resolveLocalOnnxHostLockPath({ ALAYA_LOCAL_ONNX_LOCK_PATH: "/tmp/custom.lock" })
    ).toBe("/tmp/custom.lock");
    expect(resolveLocalOnnxHostLockPath({ TMPDIR: "/var/tmp" })).toBe(
      join("/var/tmp", "alaya-local-onnx-inference.lock")
    );
  });

  it("passes through when disabled", async () => {
    const value = await withLocalOnnxHostSingleFlight(async () => 7, { enabled: false });
    expect(value).toBe(7);
  });

  it("serializes concurrent holders on the same lock path", async () => {
    const root = mkdtempSync(join(tmpdir(), "alaya-onnx-lock-"));
    roots.push(root);
    const lockPath = join(root, "inference.lock");
    let active = 0;
    let maxActive = 0;
    const run = async (delayMs: number) =>
      withLocalOnnxHostSingleFlight(
        async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          active -= 1;
          return delayMs;
        },
        { enabled: true, lockPath, retryMs: 5, timeoutMs: 5_000 }
      );

    const [a, b] = await Promise.all([run(40), run(40)]);
    expect(a).toBe(40);
    expect(b).toBe(40);
    expect(maxActive).toBe(1);
  });

  it("times out when the lock file is already held", async () => {
    const root = mkdtempSync(join(tmpdir(), "alaya-onnx-lock-"));
    roots.push(root);
    const lockPath = join(root, "stuck.lock");
    // Pre-create the O_EXCL lock so the waiter never acquires.
    writeFileSync(lockPath, "held\n", { flag: "wx" });
    let now = 1_000;
    await expect(
      withLocalOnnxHostSingleFlight(async () => "never", {
        enabled: true,
        lockPath,
        retryMs: 5,
        timeoutMs: 30,
        now: () => now,
        sleep: async () => {
          now += 20;
        }
      })
    ).rejects.toThrow(/timed out/);
  });
});
