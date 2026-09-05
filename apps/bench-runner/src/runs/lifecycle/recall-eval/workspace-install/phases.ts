import {
  freezeDeep,
  isObserved,
  notObserved,
  observedNumber,
  P00_PERFORMANCE_PROOF_CONTRACT,
  type CloneCopyObservation,
  type ObservedFiniteNumber
} from "../performance-proof/attribution-receipt.js";

export const P02_WORKSPACE_INSTALL_CONTRACT = Object.freeze({
  name: "recall-eval-workspace-install-io.v1",
  cites: P00_PERFORMANCE_PROOF_CONTRACT.name,
  module:
    "apps/bench-runner/src/runs/lifecycle/recall-eval/workspace-install/install.ts"
});

export const WORKSPACE_INSTALL_PHASES = [
  "receipt_read",
  "clone_copy",
  "fsync",
  "sqlite_reopen",
  "daemon_reload",
  "cleanup"
] as const;

export type WorkspaceInstallPhaseName = typeof WORKSPACE_INSTALL_PHASES[number];

export interface WorkspaceInstallPhaseTiming {
  readonly name: WorkspaceInstallPhaseName;
  readonly durationMs: ObservedFiniteNumber;
  readonly count: ObservedFiniteNumber;
}

export interface WorkspaceInstallIoReceipt {
  readonly contract: typeof P00_PERFORMANCE_PROOF_CONTRACT.name;
  readonly role: "diagnostic_only";
  readonly workerId: string;
  readonly questionId: string;
  readonly clockAMs: ObservedFiniteNumber;
  readonly diskPhaseMs: ObservedFiniteNumber;
  readonly clone: CloneCopyObservation;
  readonly phases: readonly WorkspaceInstallPhaseTiming[];
  readonly dominantPhase: WorkspaceInstallPhaseName | "unknown";
  readonly dominantReason: string;
}

export type WorkspaceInstallOptimizationDecision =
  | {
    readonly status: "NO_OPTIMIZATION_JUSTIFIED";
    readonly reason: string;
    readonly reflinkDominantPhase: WorkspaceInstallPhaseName | "unknown";
    readonly copyFallbackDominantPhase: WorkspaceInstallPhaseName | "unknown";
    readonly copyFsyncDominant: "not_verified";
    readonly cloneReuseProved: boolean;
  }
  | {
    readonly status: "OPTIMIZE_DOMINANT_OWNER";
    readonly owner: string;
    readonly dominantPhase: WorkspaceInstallPhaseName;
    readonly cloneReuseProved: true;
  };

const COPY_FSYNC_PHASES = new Set<WorkspaceInstallPhaseName>(["clone_copy", "fsync"]);

export function phaseByName(
  phases: readonly WorkspaceInstallPhaseTiming[],
  name: WorkspaceInstallPhaseName
): WorkspaceInstallPhaseTiming | undefined {
  return phases.find((phase) => phase.name === name);
}

export function selectDominantPhase(
  phases: readonly WorkspaceInstallPhaseTiming[]
): {
  readonly phase: WorkspaceInstallPhaseName | "unknown";
  readonly reason: string;
} {
  const missing = WORKSPACE_INSTALL_PHASES.filter((name) => {
    const row = phaseByName(phases, name);
    return row === undefined || !isObserved(row.durationMs);
  });
  if (missing.length > 0) {
    return {
      phase: "unknown",
      reason: `phase duration not observed: ${missing.join(",")}`
    };
  }
  let winner: WorkspaceInstallPhaseName = WORKSPACE_INSTALL_PHASES[0];
  let winnerMs = observedDuration(phases, winner);
  for (const name of WORKSPACE_INSTALL_PHASES.slice(1)) {
    const durationMs = observedDuration(phases, name);
    if (durationMs > winnerMs) {
      winner = name;
      winnerMs = durationMs;
    }
  }
  return {
    phase: winner,
    reason: `earliest max durationMs among observed phases (${winner}=${winnerMs})`
  };
}

export function decideWorkspaceInstallOptimization(input: {
  readonly reflink: WorkspaceInstallIoReceipt;
  readonly copyFallback: WorkspaceInstallIoReceipt;
  readonly cloneReuseProved: boolean;
}): WorkspaceInstallOptimizationDecision {
  if (input.cloneReuseProved !== true) {
    return Object.freeze({
      status: "NO_OPTIMIZATION_JUSTIFIED",
      reason:
        "safe clone reuse is not independently proved; retain one private copy per question. copy/fsync dominance on production installWorkspaceSlice is NOT_VERIFIED",
      reflinkDominantPhase: input.reflink.dominantPhase,
      copyFallbackDominantPhase: input.copyFallback.dominantPhase,
      copyFsyncDominant: "not_verified",
      cloneReuseProved: false
    });
  }
  const copyFsyncDominant =
    isCopyOrFsync(input.reflink.dominantPhase) ||
    isCopyOrFsync(input.copyFallback.dominantPhase);
  if (!copyFsyncDominant) {
    return Object.freeze({
      status: "NO_OPTIMIZATION_JUSTIFIED",
      reason:
        "clone reuse is proved but copy/fsync is not the measured dominant phase; production install owner remains NOT_VERIFIED",
      reflinkDominantPhase: input.reflink.dominantPhase,
      copyFallbackDominantPhase: input.copyFallback.dominantPhase,
      copyFsyncDominant: "not_verified",
      cloneReuseProved: true
    });
  }
  const dominantPhase = earliestCopyFsyncOwner(input.reflink, input.copyFallback);
  return Object.freeze({
    status: "OPTIMIZE_DOMINANT_OWNER",
    owner: P02_WORKSPACE_INSTALL_CONTRACT.module,
    dominantPhase,
    cloneReuseProved: true
  });
}

export function freezeWorkspaceInstallIoReceipt(input: {
  readonly workerId: string;
  readonly questionId: string;
  readonly clockAMs: ObservedFiniteNumber;
  readonly diskPhaseMs: ObservedFiniteNumber;
  readonly clone: CloneCopyObservation;
  readonly phases: readonly WorkspaceInstallPhaseTiming[];
}): WorkspaceInstallIoReceipt {
  const workerId = requireToken(input.workerId, "workerId");
  const questionId = requireToken(input.questionId, "questionId");
  const phases = freezePhases(input.phases);
  const dominant = selectDominantPhase(phases);
  return freezeDeep({
    contract: P00_PERFORMANCE_PROOF_CONTRACT.name,
    role: "diagnostic_only" as const,
    workerId,
    questionId,
    clockAMs: requireQuantity(input.clockAMs, "clockAMs"),
    diskPhaseMs: requireQuantity(input.diskPhaseMs, "diskPhaseMs"),
    clone: freezeClone(input.clone),
    phases,
    dominantPhase: dominant.phase,
    dominantReason: dominant.reason
  });
}

export function observedPhase(
  name: WorkspaceInstallPhaseName,
  durationMs: number,
  count: number
): WorkspaceInstallPhaseTiming {
  return Object.freeze({
    name,
    durationMs: observedNumber(durationMs),
    count: observedNumber(count)
  });
}

export function notObservedPhase(
  name: WorkspaceInstallPhaseName,
  reason: string
): WorkspaceInstallPhaseTiming {
  const missing = notObserved(reason);
  return Object.freeze({
    name,
    durationMs: missing,
    count: missing
  });
}

function freezePhases(
  phases: readonly WorkspaceInstallPhaseTiming[]
): readonly WorkspaceInstallPhaseTiming[] {
  const byName = new Map(phases.map((phase) => [phase.name, phase]));
  return Object.freeze(WORKSPACE_INSTALL_PHASES.map((name) => {
    const row = byName.get(name);
    if (row === undefined) {
      return notObservedPhase(name, `${name} was not recorded`);
    }
    return Object.freeze({
      name,
      durationMs: requireQuantity(row.durationMs, `${name}.durationMs`),
      count: requireQuantity(row.count, `${name}.count`)
    });
  }));
}

function freezeClone(clone: CloneCopyObservation): CloneCopyObservation {
  if (clone.status === "not_observed") {
    return Object.freeze({
      status: "not_observed",
      reason: requireToken(clone.reason, "clone.reason")
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
      "clone.physicalBytesWritten"
    )
  });
}

function observedDuration(
  phases: readonly WorkspaceInstallPhaseTiming[],
  name: WorkspaceInstallPhaseName
): number {
  const row = phaseByName(phases, name);
  if (row === undefined || !isObserved(row.durationMs)) {
    throw new Error(`${name} duration must be observed to select dominance`);
  }
  return row.durationMs.value;
}

function isCopyOrFsync(
  phase: WorkspaceInstallPhaseName | "unknown"
): phase is "clone_copy" | "fsync" {
  return phase !== "unknown" && COPY_FSYNC_PHASES.has(phase);
}

function earliestCopyFsyncOwner(
  reflink: WorkspaceInstallIoReceipt,
  copyFallback: WorkspaceInstallIoReceipt
): "clone_copy" | "fsync" {
  if (isCopyOrFsync(reflink.dominantPhase)) return reflink.dominantPhase;
  if (isCopyOrFsync(copyFallback.dominantPhase)) return copyFallback.dominantPhase;
  throw new Error("copy/fsync owner required after dominance proof");
}

function optimizationDeclineReason(
  copyFsyncDominant: boolean,
  cloneReuseProved: boolean
): string {
  if (!copyFsyncDominant && cloneReuseProved !== true) {
    return "copy/fsync is not the measured dominant phase and safe clone reuse is not proved";
  }
  if (!copyFsyncDominant) {
    return "copy/fsync is not the measured dominant phase on the provider-free fixture";
  }
  return "safe clone reuse is not independently proved; retain one private copy per question";
}

function requireQuantity(
  quantity: ObservedFiniteNumber,
  path: string
): ObservedFiniteNumber {
  if (quantity.status === "observed") return observedNumber(quantity.value);
  if (quantity.status === "not_observed") return notObserved(quantity.reason);
  throw new Error(`${path} must be observed or not_observed`);
}

function requireToken(value: string, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}
