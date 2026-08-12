import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import {
  cleanupMaterializerFixtures, createMaterializerFixture, materialize
} from "../../materializer-fixture.js";

const CHILD_ENV = "ALAYA_TEST_MATERIALIZATION_MEMORY_CHILD";
const MAX_STREAMING_EXTERNAL_DELTA = 256 * 1024;

afterEach(cleanupMaterializerFixtures);

if (process.env[CHILD_ENV] === "1") {
  it("retains at most one bounded shard payload during preflight", () => {
    const fixture = createMaterializerFixture({
      hitCount: 6, totalCount: 6, rawJsonPaddingBytes: 96 * 1024
    });
    const tracker = installExternalPayloadTracker();
    try {
      materialize(fixture);
    } finally {
      tracker.restore();
    }
    expect(tracker.peakDelta()).toBeLessThanOrEqual(MAX_STREAMING_EXTERNAL_DELTA);
  });
} else {
  it("keeps preflight shard-payload memory O(1)", async () => {
    const result = await runMemoryChild();
    expect(result).toEqual({ code: 0, signal: null, stderr: "" });
  }, 30_000);
}

function installExternalPayloadTracker() {
  if (globalThis.gc === undefined) throw new Error("memory child requires --expose-gc");
  globalThis.gc();
  const baseline = process.memoryUsage().external;
  let peak = 0;
  const originalAlloc = Buffer.alloc;
  const originalAllocUnsafe = Buffer.allocUnsafe;
  const trackedAllocation = (allocate: (...args: unknown[]) => Buffer) =>
    (size: number, ...args: unknown[]) => {
    globalThis.gc!();
    if (size >= 64 * 1024) {
      peak = Math.max(peak, process.memoryUsage().external - baseline);
    }
      return allocate(size, ...args);
    };
  Buffer.alloc = trackedAllocation((...args) =>
    Reflect.apply(originalAlloc, Buffer, args)) as typeof Buffer.alloc;
  Buffer.allocUnsafe = trackedAllocation((...args) =>
    Reflect.apply(originalAllocUnsafe, Buffer, args)) as typeof Buffer.allocUnsafe;
  return {
    peakDelta: () => peak,
    restore: () => {
      Buffer.alloc = originalAlloc;
      Buffer.allocUnsafe = originalAllocUnsafe;
    }
  };
}

function runMemoryChild(): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
}> {
  const child = spawn(process.execPath, [
    "--expose-gc", join(process.cwd(), "node_modules/vitest/vitest.mjs"), "run",
    fileURLToPath(import.meta.url), "--pool=threads", "--maxWorkers=1"
  ], {
    cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, [CHILD_ENV]: "1" }
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({
      code, signal, stderr: code === 0 ? "" : stderr.slice(-2_000)
    }));
  });
}
