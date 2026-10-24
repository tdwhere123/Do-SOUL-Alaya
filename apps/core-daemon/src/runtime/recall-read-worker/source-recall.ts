import type { SourceSemanticResourceBudget, SourceSemanticResourceLedger } from "@do-soul/alaya-protocol";

/** Existing phase allocations are policy, not calibration or newly fungible reserves. */
export function sourceRecallPhaseAllowance(meter: SourceSemanticResourceLedger,
  phase: "observation" | "package_hydration" | "selection"): SourceSemanticResourceBudget {
  const divisor = phase === "package_hydration" ? 3 : 2;
  return { work_units: Math.floor(meter.work / divisor), memory_bytes: Math.floor(meter.bytes / divisor) };
}
