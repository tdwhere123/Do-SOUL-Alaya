import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseFlags } from "../../cli/cli-options.js";
import { runExtractionFillCommand } from "../../cli/extraction-fill/command-core.js";
import { acquireExtractionCacheWriteLease, withExtractionCacheWriteLease } from
  "../../runs/extraction/fill/manifest/fill-root-guard.js";

// The diagnostic seam needs real directory ownership checks, not a socket listener.
vi.mock("../../runs/extraction/fill/manifest/kernel-write-lease.js", () => ({
  acquireKernelWriteLease: () => ({ assertOwned() {}, release() {} }),
  isKernelWriteLeaseActive: () => false
}));
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

it("renders the original and release errors from the filesystem lease wrapper at the extraction CLI", async () => {
  const cacheRoot = mkdtempSync(join(tmpdir(), "fill-failure-")); roots.push(cacheRoot);
  const primary = new Error("local extraction preparation failed");
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  let failure: unknown;
  const exitCode = await runExtractionFillCommand(parseFlags(["--variant", "longmemeval_oracle"]), {
    signalSource: { on() {}, off() {} },
    runExtractionFill: async () => {
      const lease = acquireExtractionCacheWriteLease(cacheRoot);
      try {
        return await withExtractionCacheWriteLease(lease, async () => {
          writeFileSync(join(cacheRoot, ".extraction-fill.lock", "owner.json"), JSON.stringify({ pid: process.pid, token: "replaced" }));
          throw primary;
        });
      } catch (error) { failure = error; throw error; }
    }
  });
  expect(failure).toBeInstanceOf(AggregateError);
  if (!(failure instanceof AggregateError)) throw new Error("expected paired failure");
  expect(failure.errors[0]).toBe(primary);
  expect(String(failure.errors[1])).toContain("ownership changed");
  expect(exitCode).toBe(2);
  expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join(""))
    .toMatch(/local extraction preparation failed.*ownership changed/su);
});
