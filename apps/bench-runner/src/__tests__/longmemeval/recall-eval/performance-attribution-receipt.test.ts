import { describe, expect, it } from "vitest";
import {
  freezePerformanceAttributionReceipt,
  notObserved,
  observedNumber,
  observedVerification,
  P00_PERFORMANCE_PROOF_CONTRACT,
  type PerformanceAttributionReceipt
} from "../../../runs/lifecycle/recall-eval/performance-proof/attribution-receipt.js";

describe("P00 performance attribution receipt", () => {
  it("names the citation contract later P-cards must use", () => {
    expect(P00_PERFORMANCE_PROOF_CONTRACT).toEqual({
      name: "recall-eval-performance-attribution-and-exact-parity.v1",
      attributionSchema: "recall-eval-performance-attribution.v1",
      paritySchema: "recall-eval-exact-parity.v1",
      attributionModule:
        "apps/bench-runner/src/runs/lifecycle/recall-eval/performance-proof/attribution-receipt.ts",
      parityModule:
        "apps/bench-runner/src/runs/lifecycle/recall-eval/performance-proof/exact-parity.ts",
      fixtureModule:
        "apps/bench-runner/src/runs/lifecycle/recall-eval/performance-proof/provider-free-run.ts"
    });
  });

  it("keeps an observed Clock-A of 0 and does not treat it as unknown", () => {
    const receipt = freezeReceipt({
      clocks: clockFields({ clockAMs: observedNumber(0) })
    });
    expect(receipt.clocks.clockAMs).toEqual({ status: "observed", value: 0 });
    expect(receipt.role).toBe("diagnostic_only");
  });

  it("does not mint 0 when a required quantity was not observed", () => {
    const receipt = freezeReceipt({
      clocks: clockFields({ clockAMs: notObserved("daemon.recall was not executed") }),
      rss: {
        parentPeakBytes: observedNumber(12),
        childPeakBytes: notObserved("pager/model child RSS was not sampled"),
        aggregatePeakBytes: notObserved("pager/model child RSS was not sampled")
      }
    });
    expect(receipt.clocks.clockAMs).toEqual({
      status: "not_observed",
      reason: "daemon.recall was not executed"
    });
    expect(receipt.rss.childPeakBytes.status).toBe("not_observed");
    expect(receipt.rss.aggregatePeakBytes.status).toBe("not_observed");
    expect("value" in receipt.clocks.clockAMs).toBe(false);
    expect("value" in receipt.rss.childPeakBytes).toBe(false);
  });

  it("keeps Clock-A, harness, readiness, disk, and RSS as separate fields", () => {
    const receipt = freezeReceipt({
      clocks: {
        clockAMs: observedNumber(12),
        harnessOpenMs: observedNumber(3),
        harnessRecallMs: observedNumber(4),
        harnessTotalWallMs: observedNumber(9),
        modelReadinessMs: observedNumber(40),
        diskPhaseMs: observedNumber(7)
      }
    });
    expect(Object.keys(receipt.clocks)).toEqual([
      "clockAMs",
      "harnessOpenMs",
      "harnessRecallMs",
      "harnessTotalWallMs",
      "modelReadinessMs",
      "diskPhaseMs"
    ]);
    expect(receipt.clocks.clockAMs).toEqual({ status: "observed", value: 12 });
    expect(receipt.clocks.modelReadinessMs).toEqual({ status: "observed", value: 40 });
    expect(receipt.clocks.diskPhaseMs).toEqual({ status: "observed", value: 7 });
    expect(receipt.rss.parentPeakBytes).toEqual({ status: "observed", value: 1 });
    expect(receipt.disk.clone).toMatchObject({
      status: "observed",
      mode: "copy_fallback",
      logicalBytes: 8
    });
  });

  it("refuses to report aggregate RSS when child RSS was not observed", () => {
    expect(() => freezeReceipt({
      rss: {
        parentPeakBytes: observedNumber(100),
        childPeakBytes: notObserved("child RSS was not sampled"),
        aggregatePeakBytes: observedNumber(0)
      }
    })).toThrow(/aggregate peak RSS cannot be observed/u);
  });

  it("refuses to count workspace receipt verification as 0 when it was not observed", () => {
    expect(() => freezeReceipt({
      workspace: {
        receiptVerificationCount: observedNumber(0),
        receiptVerification: observedVerification("pass")
      }
    })).toThrow(/verification count is observed and >= 1/u);
    expect(() => freezeReceipt({
      workspace: {
        receiptVerificationCount: observedNumber(0),
        receiptVerification: {
          status: "not_observed",
          reason: "receipt was not checked"
        }
      }
    })).toThrow(/cannot be observed as a number when verification itself was not observed/u);
  });

  it("does not invent physical bytes written for a successful reflink", () => {
    const receipt = freezeReceipt({
      disk: {
        clone: {
          status: "observed",
          mode: "reflink",
          logicalBytes: 4096,
          physicalBytesWritten: notObserved("physical write size was not sampled")
        },
        fsyncCount: observedNumber(1),
        sqliteReopenCount: observedNumber(1),
        daemonRestartCount: observedNumber(1),
        questionExecutionCount: observedNumber(2)
      }
    });
    expect(receipt.disk.clone).toMatchObject({
      status: "observed",
      mode: "reflink",
      logicalBytes: 4096
    });
    if (receipt.disk.clone.status !== "observed") {
      throw new Error("clone should be observed");
    }
    expect(receipt.disk.clone.physicalBytesWritten).toEqual({
      status: "not_observed",
      reason: "physical write size was not sampled"
    });
  });

  it("rejects empty not_observed reasons and non-finite observed values", () => {
    expect(() => notObserved(" ")).toThrow(/not_observed reason must be non-empty/u);
    expect(() => observedNumber(Number.NaN)).toThrow(/finite number >= 0/u);
    expect(() => observedNumber(-1)).toThrow(/finite number >= 0/u);
  });

  it("freezes the receipt so later cards cannot mutate diagnostic fields into KPIs", () => {
    const receipt = freezeReceipt();
    expect(() => {
      (receipt as { role: string }).role = "kpi";
    }).toThrow();
    expect(() => {
      (receipt.clocks as { clockAMs: unknown }).clockAMs = observedNumber(0);
    }).toThrow();
  });
});

function freezeReceipt(
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
