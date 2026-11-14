import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeJsonAtomic } from "./checkpoint.js";
import { DIAGNOSTIC_LOOP_PHASES, type DiagnosticLoopPhase } from "./phases.js";

export type SmokeGateStatus = "passed" | "failed" | "absent";

export interface DiagnosticLoopSmokeGate {
  readonly schema_version: 1;
  readonly kind: "diagnostic_loop_smoke_gate";
  readonly status: Exclude<SmokeGateStatus, "absent">;
  readonly identity_digest: string;
  readonly failed_phase?: DiagnosticLoopPhase;
}

const SmokeGateSchema = z.object({
  schema_version: z.literal(1),
  kind: z.literal("diagnostic_loop_smoke_gate"),
  status: z.enum(["passed", "failed"]),
  identity_digest: z.string().regex(/^[a-f0-9]{64}$/u),
  failed_phase: z.enum(DIAGNOSTIC_LOOP_PHASES).optional()
}).strict();

export function smokeGatePath(workRoot: string): string {
  return join(workRoot, "smoke-gate.json");
}

export function readSmokeGate(workRoot: string, identityDigest: string): SmokeGateStatus {
  const path = smokeGatePath(workRoot);
  if (!existsSync(path)) return "absent";
  const parsed = SmokeGateSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) {
    throw new Error(`invalid smoke gate: ${path}`);
  }
  if (parsed.data.identity_digest !== identityDigest) {
    throw new Error(`smoke gate identity_digest does not match this run: ${path}`);
  }
  return parsed.data.status;
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
  writeJsonAtomic(smokeGatePath(input.workRoot), SmokeGateSchema.parse(record));
}
