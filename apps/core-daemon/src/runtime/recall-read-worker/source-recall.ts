import type { SourceSemanticResourceBudget, SourceSemanticResourceLedger } from "@do-soul/alaya-protocol";

type SourceRecallPhases = Readonly<{
  /** Adapters create the native child; the owner sets its unchanged allowance and lifetime. */
  observe: (allowance: SourceSemanticResourceBudget) => void;
  compute: () => void; absorbExploration: () => void;
  finalize: () => void; deliver: () => void;
}>;

/** Native process progression. Optional computation cannot bypass observation or finalization. */
export function runSourceRecall(meter: SourceSemanticResourceLedger, finalizationReserve: number, outputByteLimit: number,
  phases: SourceRecallPhases): void {
  let absorbed = false;
  try {
    phases.observe({
      work_units: Math.max(0, meter.work - Math.min(finalizationReserve, Math.floor(meter.work / 4))),
      memory_bytes: meter.bytes - Math.min(Math.floor(meter.bytes / 4), outputByteLimit * 8 + 65536)
    });
    phases.compute();
    absorbed = true; phases.absorbExploration();
    phases.finalize(); phases.deliver();
  } finally { if (!absorbed) phases.absorbExploration(); }
}

/** Existing phase allocations are policy, not calibration or newly fungible reserves. */
export function sourceRecallPhaseAllowance(meter: SourceSemanticResourceLedger,
  phase: "observation" | "package_hydration" | "selection"): SourceSemanticResourceBudget {
  const divisor = phase === "package_hydration" ? 3 : 2;
  return { work_units: Math.floor(meter.work / divisor), memory_bytes: Math.floor(meter.bytes / divisor) };
}
