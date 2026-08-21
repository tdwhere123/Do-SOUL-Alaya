import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readDiagnostic100QComparisonArtifact } from
  "../diagnostics/stage-attribution/exposure/comparison-artifact.js";
import { rebuildDiagnostic100QComparison } from
  "../diagnostics/stage-attribution/exposure/rebuild-comparison.js";
import { DIAGNOSTIC_100Q_KPI_PROMOTION } from
  "../diagnostics/stage-attribution/exposure/diagnostic-unlock.js";
import type { Diagnostic100QComparison } from
  "../diagnostics/stage-attribution/diagnostic-100q.js";
import type { DiagnosticLoopRequest } from "./types.js";
import { readRunRecord, runRecordPath } from "./run-state.js";
import type {
  DiagnosticExtractionCacheIdentity,
  DiagnosticSnapshotIdentity,
  ResolvedDiagnosticLoopIdentity
} from "./authority/identity.js";
import { missLedgerContentIdentity } from "./miss-ledger-authority.js";
import { parseContainedCheckpoint, readContainedFile, resolveContainedPath } from
  "./gate7-unlock-closure.js";
import { assertGate7QueryWindowCompatibility } from "./gate7-unlock-query-window.js";
import { GATE7_CANARY_LIMIT, gate7UnlockRequired } from "./gate7-unlock-policy.js";

export { gate7UnlockRequired };

export async function assertGate7DiagnosticUnlock(input: {
  readonly unlockWorkRoot: string | undefined;
  readonly currentRequest: DiagnosticLoopRequest;
  readonly currentIdentity: ResolvedDiagnosticLoopIdentity;
}): Promise<void> {
  if (input.unlockWorkRoot === undefined || input.unlockWorkRoot.trim().length === 0) {
    throw new Error("diagnostic-loop limit>3 requires --gate7-unlock <3q-work-root>");
  }
  const workRoot = resolveContainedPath(input.unlockWorkRoot, input.unlockWorkRoot);
  const prior = readRunRecord((await readContainedFile(workRoot, runRecordPath(workRoot))).path);
  if ((prior.identity.request.limit ?? 0) !== GATE7_CANARY_LIMIT ||
      (prior.identity.request.offset ?? 0) !== 0) {
    throw new Error("gate7 unlock is not an exact 3Q canary window");
  }
  assertMatchingAuthorities(prior.identity, input.currentIdentity);
  await assertGate7QueryWindowCompatibility(prior.identity, input.currentIdentity);
  const comparison = await rebuildContainedComparison(workRoot, prior.run_record_digest);
  if (comparison.physical_calls !== 0 ||
      !comparison.diagnostic_100q_unlock.eligible ||
      comparison.diagnostic_100q_unlock.reason !== "gate7_polarity_matrix_passed" ||
      !comparison.gate7_polarity_matrix.applicable ||
      !comparison.gate7_polarity_matrix.passed) {
    throw new Error("gate7 unlock comparison is not a passing current polarity matrix");
  }
  await assertUnlockReport(workRoot, comparison);
}

function assertMatchingAuthorities(
  prior: ResolvedDiagnosticLoopIdentity,
  current: ResolvedDiagnosticLoopIdentity
): void {
  if (!codeIdentityMatches(prior.request, current.request)) {
    throw new Error("gate7 unlock code identity does not match the current request");
  }
  if (!extractionMatches(prior.extraction_cache, current.extraction_cache)) {
    throw new Error("gate7 unlock extraction authority does not match the current request");
  }
  if (!snapshotBindingMatches(prior.snapshot, current.snapshot)) {
    throw new Error("gate7 unlock snapshot authority does not match the current request");
  }
}

function codeIdentityMatches(
  prior: DiagnosticLoopRequest,
  current: DiagnosticLoopRequest
): boolean {
  return prior.datasetRevision === current.datasetRevision &&
    prior.providerRoute === current.providerRoute &&
    prior.model === current.model &&
    prior.requestProfile === current.requestProfile &&
    prior.promptDigest === current.promptDigest &&
    prior.schemaDigest === current.schemaDigest &&
    prior.operatorDigest === current.operatorDigest &&
    prior.variant === current.variant &&
    prior.cacheMode === current.cacheMode;
}

function extractionMatches(
  prior: DiagnosticExtractionCacheIdentity | undefined,
  current: DiagnosticExtractionCacheIdentity | undefined
): boolean {
  if (current === undefined) return prior === undefined;
  if (prior === undefined) return false;
  return prior.manifest_sha256 === current.manifest_sha256 &&
    prior.system_prompt_sha256 === current.system_prompt_sha256 &&
    prior.content_closure_sha256 === current.content_closure_sha256 &&
    prior.dataset_revision === current.dataset_revision &&
    prior.extraction_model === current.extraction_model &&
    prior.request_profile === current.request_profile;
}

function snapshotBindingMatches(
  prior: DiagnosticSnapshotIdentity | undefined,
  current: DiagnosticSnapshotIdentity | undefined
): boolean {
  if (current === undefined) return prior === undefined;
  if (prior === undefined) return false;
  return isDeepStrictEqual(prior.extraction_binding, current.extraction_binding);
}

async function rebuildContainedComparison(
  workRoot: string,
  identityDigest: string
): Promise<Diagnostic100QComparison> {
  const control = parseContainedCheckpoint(
    (await readContainedFile(workRoot, join(workRoot, "checkpoints", "control_recall.json"))).bytes,
    join(workRoot, "checkpoints", "control_recall.json")
  );
  const treatment = parseContainedCheckpoint(
    (await readContainedFile(workRoot, join(workRoot, "checkpoints", "treatment_recall.json"))).bytes,
    join(workRoot, "checkpoints", "treatment_recall.json")
  );
  const miss = parseContainedCheckpoint(
    (await readContainedFile(workRoot, join(workRoot, "checkpoints", "miss_ledger.json"))).bytes,
    join(workRoot, "checkpoints", "miss_ledger.json")
  );
  assertZeroCallCheckpoint(control, "control_recall");
  assertZeroCallCheckpoint(treatment, "treatment_recall");
  assertZeroCallCheckpoint(miss, "miss_ledger");
  if (control.identity_digest !== identityDigest ||
      treatment.identity_digest !== identityDigest ||
      miss.identity_digest !== identityDigest) {
    throw new Error("gate7 unlock arm checkpoints do not bind the current run record");
  }
  if (miss.content_identity !== missLedgerContentIdentity(control, treatment)) {
    throw new Error("gate7 unlock miss-ledger does not bind the arm checkpoint identities");
  }
  const missLedger = await readContainedFile(
    workRoot, requiredArtifactPath(miss.artifact_paths.missLedger, "miss_ledger")
  );
  const artifact = await readDiagnostic100QComparisonArtifact(missLedger.path);
  const controlDiag = await readContainedFile(
    workRoot, requiredArtifactPath(control.artifact_paths.diagnostics, "control_recall")
  );
  const treatmentDiag = await readContainedFile(
    workRoot, requiredArtifactPath(treatment.artifact_paths.diagnostics, "treatment_recall")
  );
  const snapshot = await mkdtemp(join(tmpdir(), "gate7-unlock-arms-"));
  const controlCopy = join(snapshot, "control.diagnostics.json.gz");
  const treatmentCopy = join(snapshot, "treatment.diagnostics.json.gz");
  // Rebuild from the first-read bytes; later replacement of the originals is residual.
  await writeFile(controlCopy, controlDiag.bytes);
  await writeFile(treatmentCopy, treatmentDiag.bytes);
  const rebuilt = await rebuildDiagnostic100QComparison({
    controlDiagnosticsPath: controlCopy,
    treatmentDiagnosticsPath: treatmentCopy
  });
  if (!isDeepStrictEqual(artifact, rebuilt)) {
    throw new Error("gate7 unlock comparison does not rebuild from arm diagnostics");
  }
  return rebuilt;
}

function requiredArtifactPath(path: string | undefined, phase: string): string {
  if (path === undefined || path.trim().length === 0) {
    throw new Error(`gate7 unlock ${phase} is missing a bound artifact path`);
  }
  return path;
}

function assertZeroCallCheckpoint(
  checkpoint: ReturnType<typeof parseContainedCheckpoint>,
  phase: string
): void {
  const receipt = checkpoint.details.no_provider_call_receipt;
  if (checkpoint.physical_calls !== 0 || !isRecord(receipt) ||
      receipt.provider_port !== "absent" || receipt.physical_calls !== 0) {
    throw new Error(`gate7 unlock ${phase} is missing a zero-call no-provider receipt`);
  }
}

async function assertUnlockReport(
  workRoot: string,
  comparison: Diagnostic100QComparison
): Promise<void> {
  const reportFile = await readContainedFile(workRoot, join(workRoot, "report.json"));
  const report = JSON.parse(reportFile.bytes.toString("utf8")) as unknown;
  if (!isRecord(report)) {
    throw new Error("gate7 unlock report is not a current diagnostic-loop report");
  }
  if (report.schema_version === 3) {
    throw new Error(
      "historical diagnostic-loop report cannot be reinterpreted as current gate authority"
    );
  }
  if (report.schema_version !== 4 || report.kind !== "diagnostic_loop_report" ||
      !isDeepStrictEqual(report.diagnostic_100q_unlock, comparison.diagnostic_100q_unlock) ||
      !isDeepStrictEqual(report.diagnostic_100q_promotion, DIAGNOSTIC_100Q_KPI_PROMOTION)) {
    throw new Error("gate7 unlock report does not bind the rebuilt polarity matrix");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
