export const DIAGNOSTIC_LOOP_PHASES = [
  "preflight",
  "authority_cache",
  "extraction",
  "snapshot",
  "control_recall",
  "treatment_recall",
  "miss_ledger",
  "report"
] as const;

export type DiagnosticLoopPhase = (typeof DIAGNOSTIC_LOOP_PHASES)[number];

export const DIAGNOSTIC_LOOP_MODES = [
  "smoke",
  "run",
  "cache-only",
  "report-only"
] as const;

export type DiagnosticLoopMode = (typeof DIAGNOSTIC_LOOP_MODES)[number];

export const EXPENSIVE_DIAGNOSTIC_LOOP_PHASES = [
  "extraction",
  "snapshot",
  "control_recall",
  "treatment_recall"
] as const;

export const SMOKE_LIMIT_CEILING = 10;

export function isDiagnosticLoopPhase(value: string): value is DiagnosticLoopPhase {
  return (DIAGNOSTIC_LOOP_PHASES as readonly string[]).includes(value);
}

export function isDiagnosticLoopMode(value: string): value is DiagnosticLoopMode {
  return (DIAGNOSTIC_LOOP_MODES as readonly string[]).includes(value);
}

export function phasesForMode(mode: DiagnosticLoopMode): readonly DiagnosticLoopPhase[] {
  return mode === "report-only" ? ["report"] : DIAGNOSTIC_LOOP_PHASES;
}

export function phasesFrom(start: DiagnosticLoopPhase): readonly DiagnosticLoopPhase[] {
  const index = DIAGNOSTIC_LOOP_PHASES.indexOf(start);
  return DIAGNOSTIC_LOOP_PHASES.slice(index);
}

export function isExpensivePhase(phase: DiagnosticLoopPhase): boolean {
  return (EXPENSIVE_DIAGNOSTIC_LOOP_PHASES as readonly string[]).includes(phase);
}
