import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  diagnosticAuthorityDigest,
  resolveExtractionCacheIdentity,
  resolveSnapshotIdentity,
  type ResolvedDiagnosticLoopIdentity
} from "./identity.js";
import type {
  DiagnosticLoopCheckpoint,
  DiagnosticLoopRequest
} from "../types.js";
import type { DiagnosticLoopPhase } from "../phases.js";
import { sha256File } from "../../snapshot/integrity.js";
import { readFile } from "node:fs/promises";

export async function assertCheckpointAuthorities(
  request: DiagnosticLoopRequest,
  identity: ResolvedDiagnosticLoopIdentity,
  checkpoints: ReadonlyMap<DiagnosticLoopPhase, DiagnosticLoopCheckpoint>
): Promise<void> {
  const extraction = assertExtractionCheckpoint(
    request, identity, checkpoints.get("extraction")
  );
  const snapshot = await assertSnapshotCheckpoint(
    request, identity, checkpoints.get("snapshot")
  );
  assertRelationalAuthority(identity.extraction_cache, snapshot);
  await assertRecallArtifacts(checkpoints.get("control_recall"));
  await assertRecallArtifacts(checkpoints.get("treatment_recall"));
  await assertMissLedgerArtifact(checkpoints.get("miss_ledger"));
  await assertReportArtifact(checkpoints.get("report"));
}

async function assertMissLedgerArtifact(
  checkpoint: DiagnosticLoopCheckpoint | undefined
): Promise<void> {
  if (checkpoint === undefined) return;
  const path = checkpoint.artifact_paths.missLedger;
  if (typeof path !== "string" ||
      checkpoint.details.artifact_sha256 !== await sha256File(path)) {
    throw new Error("diagnostic-loop miss-ledger artifact authority mismatch");
  }
}

async function assertRecallArtifacts(
  checkpoint: DiagnosticLoopCheckpoint | undefined
): Promise<void> {
  if (checkpoint === undefined) return;
  const recorded = checkpoint.details.artifact_sha256;
  if (!isRecord(recorded) || !hasExactKeys(recorded, ["kpi", "report", "diagnostics"])) {
    throw new Error("diagnostic-loop recall checkpoint artifact authority is incomplete");
  }
  for (const key of ["kpi", "report", "diagnostics"] as const) {
    const path = checkpoint.artifact_paths[key];
    if (typeof path !== "string" || recorded[key] !== await sha256File(path)) {
      throw new Error("diagnostic-loop recall checkpoint artifact authority mismatch");
    }
  }
  if (!isEvaluationSlice(checkpoint.details.evaluation_slice)) {
    throw new Error("diagnostic-loop recall checkpoint evaluation slice is incomplete");
  }
}

async function assertReportArtifact(
  checkpoint: DiagnosticLoopCheckpoint | undefined
): Promise<void> {
  if (checkpoint === undefined) return;
  const path = checkpoint.artifact_paths.report;
  if (typeof path !== "string") {
    throw new Error("diagnostic-loop report checkpoint artifact authority is incomplete");
  }
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (diagnosticAuthorityDigest(parsed) !== checkpoint.content_identity) {
    throw new Error("diagnostic-loop report checkpoint artifact authority mismatch");
  }
}

function isEvaluationSlice(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, [
    "offset", "limit", "evaluated_count", "question_id_digest"
  ])) return false;
  return isCount(value.offset) &&
    (value.limit === null || (isCount(value.limit) && value.limit > 0)) &&
    isCount(value.evaluated_count) &&
    typeof value.question_id_digest === "string" &&
    /^[a-f0-9]{64}$/u.test(value.question_id_digest);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function assertExtractionCheckpoint(
  request: DiagnosticLoopRequest,
  identity: ResolvedDiagnosticLoopIdentity,
  checkpoint: DiagnosticLoopCheckpoint | undefined
): ResolvedDiagnosticLoopIdentity["extraction_cache"] {
  if (checkpoint === undefined) return undefined;
  const root = checkpoint.artifact_paths.cacheRoot;
  const recorded = checkpoint.details.extraction_cache_authority;
  const recordedDigest = checkpoint.details.extraction_cache_identity;
  if (root === undefined || typeof recordedDigest !== "string" ||
      typeof recorded !== "object" || recorded === null) {
    throw new Error("diagnostic-loop extraction checkpoint authority is incomplete");
  }
  const canonicalRoot = realpathSync(resolve(root));
  const current = identity.extraction_cache?.root === canonicalRoot
    ? identity.extraction_cache
    : resolveExtractionCacheIdentity({ ...request, extractionCacheRoot: root });
  const currentDigest = diagnosticAuthorityDigest(current);
  if (recordedDigest !== currentDigest || checkpoint.content_identity !== currentDigest ||
      !isDeepStrictEqual(recorded, current)) {
    throw new Error("diagnostic-loop extraction checkpoint authority mismatch");
  }
  return current;
}

async function assertSnapshotCheckpoint(
  request: DiagnosticLoopRequest,
  identity: ResolvedDiagnosticLoopIdentity,
  checkpoint: DiagnosticLoopCheckpoint | undefined
): Promise<ResolvedDiagnosticLoopIdentity["snapshot"]> {
  if (checkpoint === undefined) return undefined;
  const path = checkpoint.artifact_paths.snapshot;
  if (path === undefined || typeof checkpoint.details.identity_digest !== "string") {
    throw new Error("diagnostic-loop snapshot checkpoint authority is incomplete");
  }
  const canonicalPath = realpathSync(resolve(path));
  const current = identity.snapshot?.path === canonicalPath
    ? identity.snapshot
    : await resolveSnapshotIdentity(path, request.variant);
  const {
    no_provider_call_receipt: _receipt,
    ...recordedIdentity
  } = checkpoint.details;
  if (checkpoint.content_identity !== current.identity_digest ||
      !isDeepStrictEqual(recordedIdentity, current)) {
    throw new Error("diagnostic-loop snapshot checkpoint authority mismatch");
  }
  return current;
}

function assertRelationalAuthority(
  extraction: ResolvedDiagnosticLoopIdentity["extraction_cache"],
  snapshot: ResolvedDiagnosticLoopIdentity["snapshot"]
): void {
  if (extraction === undefined || snapshot === undefined) return;
  const { root: _root, ...binding } = extraction;
  if (!isDeepStrictEqual(binding, snapshot.extraction_binding)) {
    throw new Error(
      "diagnostic-loop snapshot and extraction cache authority mismatch"
    );
  }
}
