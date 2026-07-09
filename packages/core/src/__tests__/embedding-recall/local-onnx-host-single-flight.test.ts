import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  localOnnxHostSingleFlightEnabled,
  resolveLocalOnnxHostLockPath,
  shouldAttemptStaleLockReclaim,
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

  it("reclaims a lock whose first line is a dead PID", async () => {
    const root = mkdtempSync(join(tmpdir(), "alaya-onnx-lock-"));
    roots.push(root);
    const lockPath = join(root, "stale.lock");
    // PID 1<<30 is far outside typical OS pid ranges and is not running.
    writeFileSync(lockPath, `${1 << 30}\n2020-01-01T00:00:00.000Z\n`, { flag: "wx" });
    const value = await withLocalOnnxHostSingleFlight(async () => "reclaimed", {
      enabled: true,
      lockPath,
      retryMs: 5,
      timeoutMs: 2_000
    });
    expect(value).toBe("reclaimed");
  });

  it("throttles reclaim attempts to at most once per interval", () => {
    // First attempt always allowed; subsequent polls within 1000ms are skipped.
    expect(shouldAttemptStaleLockReclaim(undefined, 0, 1_000)).toBe(true);
    expect(shouldAttemptStaleLockReclaim(0, 25, 1_000)).toBe(false);
    expect(shouldAttemptStaleLockReclaim(0, 999, 1_000)).toBe(false);
    expect(shouldAttemptStaleLockReclaim(0, 1_000, 1_000)).toBe(true);
    // ~100 polls at 25ms over 2500ms → at most 3 reclaim windows, not 100.
    let lastReclaimAt: number | undefined;
    let reclaimAttempts = 0;
    for (let t = 0; t <= 2_500; t += 25) {
      if (shouldAttemptStaleLockReclaim(lastReclaimAt, t, 1_000)) {
        reclaimAttempts += 1;
        lastReclaimAt = t;
      }
    }
    expect(reclaimAttempts).toBe(3);
  });
});
