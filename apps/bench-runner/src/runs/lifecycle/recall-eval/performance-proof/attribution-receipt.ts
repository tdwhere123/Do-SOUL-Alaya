export const P00_PERFORMANCE_PROOF_CONTRACT = Object.freeze({
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

export const RECALL_EVAL_PERFORMANCE_ATTRIBUTION_RECEIPT =
  P00_PERFORMANCE_PROOF_CONTRACT.attributionSchema;

export type ObservedFiniteNumber =
  | { readonly status: "observed"; readonly value: number }
  | { readonly status: "not_observed"; readonly reason: string };

export type ObservedVerification =
  | { readonly status: "observed"; readonly result: "pass" | "fail" }
  | { readonly status: "not_observed"; readonly reason: string };

export type CloneCopyObservation =
  | {
    readonly status: "observed";
    readonly mode: "reflink" | "copy_fallback";
    readonly logicalBytes: number;
    readonly physicalBytesWritten: ObservedFiniteNumber;
  }
  | { readonly status: "not_observed"; readonly reason: string };

export interface PerformanceAttributionClocks {
  readonly clockAMs: ObservedFiniteNumber;
  readonly harnessOpenMs: ObservedFiniteNumber;
  readonly harnessRecallMs: ObservedFiniteNumber;
  readonly harnessTotalWallMs: ObservedFiniteNumber;
  readonly modelReadinessMs: ObservedFiniteNumber;
  readonly diskPhaseMs: ObservedFiniteNumber;
}

export interface PerformanceAttributionReceipt {
  readonly schema: typeof RECALL_EVAL_PERFORMANCE_ATTRIBUTION_RECEIPT;
  readonly role: "diagnostic_only";
  readonly clocks: PerformanceAttributionClocks;
  readonly pager: {
    readonly childSpawnCount: ObservedFiniteNumber;
    readonly modelChildSpawnCount: ObservedFiniteNumber;
    readonly modelReadinessCount: ObservedFiniteNumber;
  };
  readonly workspace: {
    readonly receiptVerificationCount: ObservedFiniteNumber;
    readonly receiptVerification: ObservedVerification;
  };
  readonly disk: {
    readonly clone: CloneCopyObservation;
    readonly fsyncCount: ObservedFiniteNumber;
    readonly sqliteReopenCount: ObservedFiniteNumber;
    readonly daemonRestartCount: ObservedFiniteNumber;
    readonly questionExecutionCount: ObservedFiniteNumber;
  };
  readonly rss: {
    readonly parentPeakBytes: ObservedFiniteNumber;
    readonly childPeakBytes: ObservedFiniteNumber;
    readonly aggregatePeakBytes: ObservedFiniteNumber;
  };
  readonly retained: {
    readonly compactRowCount: ObservedFiniteNumber;
    readonly shardPayloadBytes: ObservedFiniteNumber;
  };
}

export function observedNumber(value: number): ObservedFiniteNumber {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("performance attribution observed value must be a finite number >= 0");
  }
  return Object.freeze({ status: "observed", value });
}

export function notObserved(reason: string): ObservedFiniteNumber {
  return Object.freeze({
    status: "not_observed",
    reason: requireReason(reason)
  });
}

export function observedVerification(result: "pass" | "fail"): ObservedVerification {
  return Object.freeze({ status: "observed", result });
}

export function notObservedVerification(reason: string): ObservedVerification {
  return Object.freeze({
    status: "not_observed",
    reason: requireReason(reason)
  });
}

export function isObserved(
  quantity: ObservedFiniteNumber
): quantity is { readonly status: "observed"; readonly value: number } {
  return quantity.status === "observed";
}

export function freezePerformanceAttributionReceipt(
  input: Omit<PerformanceAttributionReceipt, "schema" | "role">
): PerformanceAttributionReceipt {
  const clocks = freezeClocks(input.clocks);
  const rss = freezeRss(input.rss);
  return freezeDeep({
    schema: RECALL_EVAL_PERFORMANCE_ATTRIBUTION_RECEIPT,
    role: "diagnostic_only",
    clocks,
    pager: {
      childSpawnCount: requireQuantity(input.pager.childSpawnCount, "pager.childSpawnCount"),
      modelChildSpawnCount: requireQuantity(
        input.pager.modelChildSpawnCount,
        "pager.modelChildSpawnCount"
      ),
      modelReadinessCount: requireQuantity(
        input.pager.modelReadinessCount,
        "pager.modelReadinessCount"
      )
    },
    workspace: freezeWorkspace(input.workspace),
    disk: freezeDisk(input.disk),
    rss,
    retained: {
      compactRowCount: requireQuantity(
        input.retained.compactRowCount,
        "retained.compactRowCount"
      ),
      shardPayloadBytes: requireQuantity(
        input.retained.shardPayloadBytes,
        "retained.shardPayloadBytes"
      )
    }
  });
}

export function freezeDeep<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    for (const item of value) freezeDeep(item);
    return Object.freeze(value) as T;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) freezeDeep(record[key]);
  return Object.freeze(value);
}

function freezeClocks(clocks: PerformanceAttributionClocks): PerformanceAttributionClocks {
  return {
    clockAMs: requireQuantity(clocks.clockAMs, "clocks.clockAMs"),
    harnessOpenMs: requireQuantity(clocks.harnessOpenMs, "clocks.harnessOpenMs"),
    harnessRecallMs: requireQuantity(clocks.harnessRecallMs, "clocks.harnessRecallMs"),
    harnessTotalWallMs: requireQuantity(clocks.harnessTotalWallMs, "clocks.harnessTotalWallMs"),
    modelReadinessMs: requireQuantity(clocks.modelReadinessMs, "clocks.modelReadinessMs"),
    diskPhaseMs: requireQuantity(clocks.diskPhaseMs, "clocks.diskPhaseMs")
  };
}

function freezeWorkspace(workspace: PerformanceAttributionReceipt["workspace"]):
  PerformanceAttributionReceipt["workspace"]
{
  const count = requireQuantity(
    workspace.receiptVerificationCount,
    "workspace.receiptVerificationCount"
  );
  const verification = requireVerification(workspace.receiptVerification);
  if (verification.status === "observed" && (!isObserved(count) || count.value < 1)) {
    throw new Error(
      "workspace receipt verification cannot be observed unless verification count is observed and >= 1"
    );
  }
  if (verification.status === "not_observed" && isObserved(count)) {
    throw new Error(
      "workspace receipt verification count cannot be observed as a number when verification itself was not observed"
    );
  }
  return { receiptVerificationCount: count, receiptVerification: verification };
}

function freezeDisk(disk: PerformanceAttributionReceipt["disk"]):
  PerformanceAttributionReceipt["disk"]
{
  return {
    clone: freezeClone(disk.clone),
    fsyncCount: requireQuantity(disk.fsyncCount, "disk.fsyncCount"),
    sqliteReopenCount: requireQuantity(disk.sqliteReopenCount, "disk.sqliteReopenCount"),
    daemonRestartCount: requireQuantity(disk.daemonRestartCount, "disk.daemonRestartCount"),
    questionExecutionCount: requireQuantity(
      disk.questionExecutionCount,
      "disk.questionExecutionCount"
    )
  };
}

function freezeClone(clone: CloneCopyObservation): CloneCopyObservation {
  if (clone.status === "not_observed") {
    return Object.freeze({
      status: "not_observed",
      reason: requireReason(clone.reason)
    });
  }
  if (clone.mode !== "reflink" && clone.mode !== "copy_fallback") {
    throw new Error("clone observation mode must be reflink or copy_fallback");
  }
  if (!Number.isFinite(clone.logicalBytes) || clone.logicalBytes < 0) {
    throw new Error("clone logicalBytes must be a finite number >= 0");
  }
  return Object.freeze({
    status: "observed",
    mode: clone.mode,
    logicalBytes: clone.logicalBytes,
    physicalBytesWritten: requireQuantity(
      clone.physicalBytesWritten,
      "disk.clone.physicalBytesWritten"
    )
  });
}

function freezeRss(rss: PerformanceAttributionReceipt["rss"]): PerformanceAttributionReceipt["rss"] {
  const parentPeakBytes = requireQuantity(rss.parentPeakBytes, "rss.parentPeakBytes");
  const childPeakBytes = requireQuantity(rss.childPeakBytes, "rss.childPeakBytes");
  const aggregatePeakBytes = requireQuantity(rss.aggregatePeakBytes, "rss.aggregatePeakBytes");
  if (isObserved(aggregatePeakBytes) && (!isObserved(parentPeakBytes) || !isObserved(childPeakBytes))) {
    throw new Error(
      "aggregate peak RSS cannot be observed unless parent and child peak RSS were observed"
    );
  }
  return { parentPeakBytes, childPeakBytes, aggregatePeakBytes };
}

function requireQuantity(
  quantity: ObservedFiniteNumber,
  path: string
): ObservedFiniteNumber {
  if (quantity.status === "observed") return observedNumber(quantity.value);
  if (quantity.status === "not_observed") return notObserved(quantity.reason);
  throw new Error(`${path} must be observed or not_observed`);
}

function requireVerification(value: ObservedVerification): ObservedVerification {
  if (value.status === "observed") {
    if (value.result !== "pass" && value.result !== "fail") {
      throw new Error("workspace receipt verification result must be pass or fail");
    }
    return observedVerification(value.result);
  }
  if (value.status === "not_observed") return notObservedVerification(value.reason);
  throw new Error("workspace receipt verification must be observed or not_observed");
}

function requireReason(reason: string): string {
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new Error("performance attribution not_observed reason must be non-empty");
  }
  return reason;
}
