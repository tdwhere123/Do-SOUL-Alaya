import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "./checkpoint.js";
import type { DiagnosticLoopPhase } from "./phases.js";

export type SmokeGateStatus = "passed" | "failed" | "absent";

export interface DiagnosticLoopSmokeGate {
  readonly schema_version: 1;
  readonly kind: "diagnostic_loop_smoke_gate";
  readonly status: Exclude<SmokeGateStatus, "absent">;
  readonly identity_digest: string;
  readonly failed_phase?: DiagnosticLoopPhase;
}

export function smokeGatePath(workRoot: string): string {
  return join(workRoot, "smoke-gate.json");
}

export function readSmokeGate(workRoot: string): SmokeGateStatus {
  const path = smokeGatePath(workRoot);
  if (!existsSync(path)) return "absent";
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DiagnosticLoopSmokeGate>;
  if (parsed.kind !== "diagnostic_loop_smoke_gate") {
    throw new Error(`invalid smoke gate: ${path}`);
  }
  return parsed.status === "failed" ? "failed" : "passed";
}

export function writeSmokeGate(input: {
  readonly workRoot: string;
  readonly status: Exclude<SmokeGateStatus, "absent">;
  readonly identityDigest: string;
  readonly failedPhase?: DiagnosticLoopPhase;
}): void {
  const record: DiagnosticLoopSmokeGate = {
    schema_version: 1,
    kind: "diagnostic_loop_smoke_gate",
    status: input.status,
    identity_digest: input.identityDigest,
    ...(input.failedPhase === undefined ? {} : { failed_phase: input.failedPhase })
  };
  writeJsonAtomic(smokeGatePath(input.workRoot), record);
}
