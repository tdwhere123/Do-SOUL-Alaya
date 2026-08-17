import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "./checkpoint.js";
import { diagnosticLoopIdentityDigest } from "./identity.js";
import type { DiagnosticLoopMode } from "./phases.js";
import type { DiagnosticLoopIdentity } from "./types.js";

export interface DiagnosticLoopRunRecord {
  readonly schema_version: 1;
  readonly kind: "diagnostic_loop_run";
  readonly identity_digest: string;
  readonly identity: DiagnosticLoopIdentity;
  readonly mode: DiagnosticLoopMode;
  readonly argv: readonly string[];
}

export function runRecordPath(workRoot: string): string {
  return join(workRoot, "run.json");
}

export function persistRunRecord(input: {
  readonly workRoot: string;
  readonly identity: DiagnosticLoopIdentity;
  readonly mode: DiagnosticLoopMode;
  readonly argv: readonly string[];
}): string {
  mkdirSync(input.workRoot, { recursive: true });
  const identityDigest = diagnosticLoopIdentityDigest(input.identity);
  const existingPath = runRecordPath(input.workRoot);
  if (existsSync(existingPath)) {
    const existing = readRunRecord(existingPath);
    if (existing.identity_digest !== identityDigest) {
      throw new Error(
        "diagnostic-loop work root already binds a different identity; " +
        "use a new --work-root"
      );
    }
  }
  const record: DiagnosticLoopRunRecord = {
    schema_version: 1,
    kind: "diagnostic_loop_run",
    identity_digest: identityDigest,
    identity: input.identity,
    mode: input.mode,
    argv: input.argv
  };
  writeJsonAtomic(existingPath, record);
  return identityDigest;
}

export function readRunRecord(path: string): DiagnosticLoopRunRecord {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DiagnosticLoopRunRecord>;
  if (parsed.schema_version !== 1 || parsed.kind !== "diagnostic_loop_run") {
    throw new Error(`invalid diagnostic-loop run record: ${path}`);
  }
  return parsed as DiagnosticLoopRunRecord;
}
