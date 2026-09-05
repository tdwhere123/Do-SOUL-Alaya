import { copyFileSync, constants, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDirectory } from "../../support/temp-cleanup.js";
import {
  freezePerformanceAttributionReceipt,
  notObserved,
  observedNumber,
  observedVerification,
  type PerformanceAttributionReceipt
} from "../../../runs/lifecycle/recall-eval/performance-proof/attribution-receipt.js";
import {
  compareExactParity,
  freezeExactParityReceipt,
  type ExactParityInputIdentity,
  type ExactParityObservedResult,
  type ExactParityReceipt
} from "../../../runs/lifecycle/recall-eval/performance-proof/exact-parity.js";
import {
  hasResourceLeak,
  runProviderFreePerformanceProof,
  scanResourceLeaks
} from "../../../runs/lifecycle/recall-eval/performance-proof/provider-free-run.js";
import type { CopyFileFn } from "../../../runs/snapshot/freeze/db-copy.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeTempDirectory(root)));
});

describe("P00 exact-parity contract", () => {
  it("binds identity first and compares delivered IDs and order", () => {
    const left = freezeReceipt();
    const right = freezeReceipt({
      result: resultFields({ deliveredObjectIds: ["mem-b", "mem-a"] })
    });
    const comparison = compareExactParity(left, right);
    expect(comparison.identityBound).toBe(true);
    expect(comparison.resultEquivalent).toBe(false);
    expect(comparison.byteCountEquivalent).toBe(false);
    expect(comparison.diagnosticTimersExcluded).toBe(true);
    expect(comparison.mismatches.map((row) => row.path)).toContain(
      "result.deliveredObjectIds"
    );
  });

  it("does not use Clock-A or harness timers as result-equivalence inputs", () => {
    const left = freezeReceipt({
      attribution: attributionFields({
        clocks: clockFields({ clockAMs: observedNumber(12), harnessTotalWallMs: observedNumber(40) })
      })
    });
    const right = freezeReceipt({
      attribution: attributionFields({
        clocks: clockFields({
          clockAMs: notObserved("daemon.recall was not executed"),
          harnessTotalWallMs: observedNumber(99)
        })
      })
    });
    const comparison = compareExactParity(left, right);
    expect(comparison.resultEquivalent).toBe(true);
    expect(comparison.byteCountEquivalent).toBe(true);
    expect(comparison.mismatches).toEqual([]);
  });

  it("treats observed-zero provider calls as different from not observing a count", () => {
    const left = freezeReceipt({
      attribution: attributionFields({
        pager: {
          childSpawnCount: observedNumber(0),
          modelChildSpawnCount: observedNumber(0),
          modelReadinessCount: observedNumber(0)
        }
      })
    });
    const right = freezeReceipt({
      attribution: attributionFields({
        pager: {
          childSpawnCount: notObserved("pager spawn was not sampled"),
          modelChildSpawnCount: observedNumber(0),
          modelReadinessCount: observedNumber(0)
        }
      })
    });
    const comparison = compareExactParity(left, right);
    expect(comparison.resultEquivalent).toBe(true);
    expect(comparison.byteCountEquivalent).toBe(false);
    expect(comparison.mismatches.map((row) => row.path)).toContain(
      "attribution.pager.childSpawnCount"
    );
  });

  it("rejects reference|optimized in the bound identity", () => {
    expect(() => freezeReceipt({
      identity: identityFields({ embeddingMode: "reference|optimized" })
    })).toThrow(/must not encode execution_arch or reference\|optimized/u);
  });

  it("fails closed when source or overlay digests drift", () => {
    const comparison = compareExactParity(
      freezeReceipt(),
      freezeReceipt({
        result: resultFields({ sourceDigestAfter: DIGEST_B, overlayDigestAfter: DIGEST_B })
      })
    );
    expect(comparison.resultEquivalent).toBe(false);
    expect(comparison.mismatches.map((row) => row.path)).toEqual([
      "result.sourceDigestAfter",
      "result.overlayDigestAfter"
    ]);
  });
});

describe("P00 provider-free control run", () => {
  it("produces a reproducible attribution and parity receipt without dataset or network", async () => {
    const first = await runProviderFreePerformanceProof();
    const second = await runProviderFreePerformanceProof();
    const comparison = compareExactParity(first.receipt, second.receipt);

    expect(first.receipt.schema).toBe("recall-eval-exact-parity.v1");
    expect(first.receipt.attribution.schema).toBe("recall-eval-performance-attribution.v1");
    expect(first.receipt.attribution.role).toBe("diagnostic_only");
    expect(first.receipt.attribution.clocks.clockAMs).toEqual({
      status: "not_observed",
      reason: "provider-free fixture did not execute daemon.recall"
    });
    expect(first.receipt.result.providerCalls).toEqual([]);
    expect(first.receipt.result.cacheCalls).toEqual([]);
    expect(first.receipt.attribution.disk.clone.status).toBe("observed");
    expect(first.receipt.attribution.rss.childPeakBytes.status).toBe("not_observed");
    expect(first.receipt.attribution.rss.aggregatePeakBytes.status).toBe("not_observed");
    expect(comparison.identityBound).toBe(true);
    expect(comparison.resultEquivalent).toBe(true);
    expect(comparison.byteCountEquivalent).toBe(true);
    expect(hasResourceLeak(first.leaks)).toBe(false);
    expect(hasResourceLeak(second.leaks)).toBe(false);
    expect(first.tempRoot).toBeNull();
    expect(second.tempRoot).toBeNull();
  });

  it("attributes reflink success and copy fallback without inventing physical bytes", async () => {
    const reflink = await runProviderFreePerformanceProof({
      copyFile: (source, dest) => copyFileSync(source, dest)
    });
    const fallback = await runProviderFreePerformanceProof({
      copyFile: fallbackCopy
    });

    expect(reflink.receipt.attribution.disk.clone).toMatchObject({
      status: "observed",
      mode: "reflink"
    });
    expect(fallback.receipt.attribution.disk.clone).toMatchObject({
      status: "observed",
      mode: "copy_fallback"
    });
    if (reflink.receipt.attribution.disk.clone.status !== "observed") {
      throw new Error("reflink clone should be observed");
    }
    expect(reflink.receipt.attribution.disk.clone.physicalBytesWritten.status)
      .toBe("not_observed");
    expect(fallback.receipt.attribution.workspace.receiptVerification).toEqual({
      status: "observed",
      result: "pass"
    });
    expect(fallback.receipt.attribution.disk.fsyncCount).toEqual({
      status: "observed",
      value: 1
    });
    expect(fallback.receipt.attribution.retained.compactRowCount).toEqual({
      status: "observed",
      value: 3
    });
  });

  it("keeps fixture clocks distinct from disk bytes and RSS", async () => {
    const run = await runProviderFreePerformanceProof({ clockAMs: observedNumber(0) });
    const clocks = run.receipt.attribution.clocks;
    expect(clocks.clockAMs).toEqual({ status: "observed", value: 0 });
    expect(clocks.harnessTotalWallMs.status).toBe("observed");
    expect(clocks.modelReadinessMs.status).toBe("observed");
    expect(clocks.diskPhaseMs.status).toBe("observed");
    expect(run.receipt.attribution.rss.parentPeakBytes.status).toBe("observed");
    if (run.receipt.attribution.disk.clone.status !== "observed") {
      throw new Error("clone should be observed");
    }
    expect(run.receipt.attribution.disk.clone.logicalBytes).toBeGreaterThan(0);
    expect(clocks).not.toHaveProperty("harnessOverheadMs");
  });

  it("reports remaining children, temp dirs, WAL, and SHM instead of minting a clean 0", async () => {
    const root = mkdtempSync(join(tmpdir(), "p00-leak-"));
    roots.push(root);
    const walPath = join(root, "alaya.db-wal");
    const shmPath = join(root, "alaya.db-shm");
    writeFileSync(walPath, "wal");
    writeFileSync(shmPath, "shm");

    const leaked = scanResourceLeaks({
      liveChildPids: [9010],
      tempRoot: root,
      walPaths: [walPath],
      shmPaths: [shmPath]
    });
    expect(hasResourceLeak(leaked)).toBe(true);
    expect(leaked.liveChildPids).toEqual([9010]);
    expect(leaked.remainingTempPaths).toEqual([root]);
    expect(leaked.remainingWalPaths).toEqual([walPath]);
    expect(leaked.remainingShmPaths).toEqual([shmPath]);

    await removeTempDirectory(root);
    const cleaned = scanResourceLeaks({
      liveChildPids: [],
      tempRoot: existsSync(root) ? root : null,
      walPaths: [walPath],
      shmPaths: [shmPath]
    });
    expect(hasResourceLeak(cleaned)).toBe(false);
  });
});

const fallbackCopy: CopyFileFn = (source, dest, mode) => {
  if (mode === constants.COPYFILE_FICLONE_FORCE) {
    const error = new Error("clone unsupported") as NodeJS.ErrnoException;
    error.code = "ENOTSUP";
    throw error;
  }
  copyFileSync(source, dest);
};

function freezeReceipt(overrides: {
  readonly identity?: ExactParityInputIdentity;
  readonly result?: ExactParityObservedResult;
  readonly attribution?: PerformanceAttributionReceipt;
} = {}): ExactParityReceipt {
  return freezeExactParityReceipt({
    identity: overrides.identity ?? identityFields(),
    result: overrides.result ?? resultFields(),
    attribution: overrides.attribution ?? attributionFields()
  });
}

function identityFields(
  overrides: Partial<ExactParityInputIdentity> = {}
): ExactParityInputIdentity {
  return {
    datasetRevision: "p00-provider-free-control",
    questionIds: ["q-control-a", "q-control-b"],
    providerKind: "none",
    providerLabel: "provider-free-fixture",
    cacheKeyAlgo: "none",
    embeddingMode: "none",
    ...overrides
  };
}

function resultFields(
  overrides: Partial<ExactParityObservedResult> = {}
): ExactParityObservedResult {
  return {
    deliveredObjectIds: ["mem-a", "mem-b"],
    deliveryBytes: 16,
    captureBytes: 32,
    diagnosticsDigest: DIGEST_A,
    providerCalls: [],
    cacheCalls: [],
    sourceDigestBefore: DIGEST_A,
    sourceDigestAfter: DIGEST_A,
    overlayDigestBefore: DIGEST_A,
    overlayDigestAfter: DIGEST_A,
    processExits: [{ pid: 9000, code: 0, signal: null }],
    archiveContents: [{ path: "kpi.json", sha256: DIGEST_A, bytes: 4 }],
    ...overrides
  };
}

function attributionFields(
  overrides: Overlay<Omit<PerformanceAttributionReceipt, "schema" | "role">> = {}
): PerformanceAttributionReceipt {
  return freezePerformanceAttributionReceipt({
    clocks: clockFields(overrides.clocks),
    pager: overlay({
      childSpawnCount: observedNumber(1),
      modelChildSpawnCount: observedNumber(1),
      modelReadinessCount: observedNumber(1)
    }, overrides.pager),
    workspace: overlay({
      receiptVerificationCount: observedNumber(1),
      receiptVerification: observedVerification("pass")
    }, overrides.workspace),
    disk: overlay<PerformanceAttributionReceipt["disk"]>({
      clone: {
        status: "observed",
        mode: "copy_fallback",
        logicalBytes: 8,
        physicalBytesWritten: notObserved("physical write size was not sampled")
      },
      fsyncCount: observedNumber(1),
      sqliteReopenCount: observedNumber(1),
      daemonRestartCount: observedNumber(1),
      questionExecutionCount: observedNumber(2)
    }, overrides.disk),
    rss: overlay({
      parentPeakBytes: observedNumber(1),
      childPeakBytes: notObserved("pager/model child RSS was not sampled"),
      aggregatePeakBytes: notObserved("pager/model child RSS was not sampled")
    }, overrides.rss),
    retained: overlay({
      compactRowCount: observedNumber(3),
      shardPayloadBytes: observedNumber(20)
    }, overrides.retained)
  });
}

function clockFields(
  overrides: Overlay<PerformanceAttributionReceipt["clocks"]> = {}
): PerformanceAttributionReceipt["clocks"] {
  return overlay({
    clockAMs: notObserved("daemon.recall was not executed"),
    harnessOpenMs: observedNumber(1),
    harnessRecallMs: observedNumber(2),
    harnessTotalWallMs: observedNumber(3),
    modelReadinessMs: observedNumber(4),
    diskPhaseMs: observedNumber(5)
  }, overrides);
}

type Overlay<T> = { readonly [K in keyof T]?: T[K] };

function overlay<T extends object>(base: T, patch: Overlay<T> = {}): T {
  return { ...base, ...patch } as T;
}
