import type { DiagnosticLoopCheckpoint } from "./types.js";
import { sha256Utf8 } from "./identity.js";

export function missLedgerContentIdentity(
  control: DiagnosticLoopCheckpoint | undefined,
  treatment: DiagnosticLoopCheckpoint | undefined
): string {
  return sha256Utf8(JSON.stringify({
    control: control?.content_identity ?? null,
    treatment: treatment?.content_identity ?? null
  }));
}

export function summarizeMissLedgerCheckpoint(
  checkpoint: DiagnosticLoopCheckpoint | undefined
): Readonly<Record<string, unknown>> | null {
  if (checkpoint === undefined) return null;
  return {
    content_identity: checkpoint.content_identity,
    artifact_paths: checkpoint.artifact_paths,
    physical_calls: checkpoint.physical_calls,
    exposed_denominator_gate: checkpoint.details.exposed_denominator_gate
  };
}
