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
import { readDiagnostic100QComparisonArtifact } from
  "../../../diagnostics/stage-attribution/exposure/comparison-artifact.js";
import { rebuildDiagnostic100QComparison } from
  "../../../diagnostics/stage-attribution/exposure/rebuild-comparison.js";
import type { Diagnostic100QComparison } from
  "../../../diagnostics/stage-attribution/diagnostic-100q.js";
import { DIAGNOSTIC_100Q_KPI_PROMOTION } from
  "../../../diagnostics/stage-attribution/exposure/diagnostic-unlock.js";
import {
  missLedgerContentIdentity,
  summarizeMissLedgerCheckpoint
} from "../miss-ledger-authority.js";

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
  const control = checkpoints.get("control_recall");
  const treatment = checkpoints.get("treatment_recall");
  await assertRecallArtifacts(control);
  await assertRecallArtifacts(treatment);
  const comparison = await assertMissLedgerArtifact(
    checkpoints.get("miss_ledger"), control, treatment
  );
  await assertReportArtifact(
    checkpoints.get("report"), checkpoints.get("miss_ledger"), comparison
  );
}

async function assertMissLedgerArtifact(
  checkpoint: DiagnosticLoopCheckpoint | undefined,
  control: DiagnosticLoopCheckpoint | undefined,
  treatment: DiagnosticLoopCheckpoint | undefined
): Promise<Diagnostic100QComparison | undefined> {
  if (checkpoint === undefined) return undefined;
  const path = checkpoint.artifact_paths.missLedger;
  if (typeof path !== "string" ||
      checkpoint.details.artifact_sha256 !== await sha256File(path)) {
    throw new Error("diagnostic-loop miss-ledger artifact authority mismatch");
  }
  const artifact = await readDiagnostic100QComparisonArtifact(path);
  if (checkpoint.content_identity !== missLedgerContentIdentity(control, treatment)) {
    throw new Error("diagnostic-loop miss-ledger content identity mismatch");
  }
  const source = await rebuildDiagnostic100QComparison({
    controlDiagnosticsPath: requireDiagnosticsPath(control, "control"),
    treatmentDiagnosticsPath: requireDiagnosticsPath(treatment, "treatment")
  });
  if (!isDeepStrictEqual(artifact, source)) {
    throw new Error("diagnostic-loop miss-ledger source authority mismatch");
  }
  if (!isDeepStrictEqual(checkpoint.details.exposure_sli, artifact.exposure_sli) ||
      !isDeepStrictEqual(
        checkpoint.details.canary_polarity_matrix, artifact.canary_polarity_matrix
      ) ||
      !isDeepStrictEqual(
        checkpoint.details.diagnostic_100q_unlock, artifact.diagnostic_100q_unlock
      )) {
    throw new Error("diagnostic-loop miss-ledger exposure contract authority mismatch");
  }
  return source;
}

function requireDiagnosticsPath(
  checkpoint: DiagnosticLoopCheckpoint | undefined,
  arm: string
): string {
  const path = checkpoint?.artifact_paths.diagnostics;
  if (typeof path !== "string") {
    throw new Error(`diagnostic-loop ${arm} diagnostics authority is incomplete`);
  }
  return path;
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
  checkpoint: DiagnosticLoopCheckpoint | undefined,
  missLedger: DiagnosticLoopCheckpoint | undefined,
  comparison: Diagnostic100QComparison | undefined
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
  if (isRecord(parsed) && parsed.schema_version === 3) {
    throw new Error(
      "historical diagnostic-loop report cannot be reinterpreted as current gate authority"
    );
  }
  if (missLedger === undefined || comparison === undefined) {
    throw new Error("diagnostic-loop report unlock/promotion authority is incomplete");
  }
  if (!isReportUnlockPromotionBound(parsed, missLedger, comparison)) {
    throw new Error("diagnostic-loop report unlock/promotion authority mismatch");
  }
}

function isReportUnlockPromotionBound(
  value: unknown,
  missLedger: DiagnosticLoopCheckpoint | undefined,
  comparison: Diagnostic100QComparison
): boolean {
  if (!isRecord(value) || value.schema_version !== 4 ||
      value.kind !== "diagnostic_loop_report") return false;
  const promotion = value.diagnostic_100q_promotion;
  const unlock = value.diagnostic_100q_unlock;
  const parsedLedger = value.miss_ledger;
  if (!isRecord(promotion) || !isRecord(parsedLedger)) return false;
  return promotion.eligible === DIAGNOSTIC_100Q_KPI_PROMOTION.eligible &&
    promotion.reason === DIAGNOSTIC_100Q_KPI_PROMOTION.reason &&
    isDeepStrictEqual(unlock, comparison.diagnostic_100q_unlock) &&
    isDeepStrictEqual(value.miss_ledger, summarizeMissLedgerCheckpoint(missLedger)) &&
    isDeepStrictEqual(parsedLedger.exposure_sli, comparison.exposure_sli) &&
    isDeepStrictEqual(parsedLedger.canary_polarity_matrix, comparison.canary_polarity_matrix) &&
    isDeepStrictEqual(parsedLedger.diagnostic_100q_unlock, comparison.diagnostic_100q_unlock);
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
