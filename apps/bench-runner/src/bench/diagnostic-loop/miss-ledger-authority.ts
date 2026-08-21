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
    exposure_sli: checkpoint.details.exposure_sli,
    gate7_polarity_matrix: checkpoint.details.gate7_polarity_matrix,
    diagnostic_100q_unlock: checkpoint.details.diagnostic_100q_unlock
  };
}
