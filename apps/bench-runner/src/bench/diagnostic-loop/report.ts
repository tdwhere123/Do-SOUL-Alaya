import { join } from "node:path";
import { writeJsonAtomic } from "./checkpoint.js";
import { sha256Utf8 } from "./identity.js";
import type { DiagnosticLoopPhase } from "./phases.js";
import type {
  DiagnosticLoopAvoidedWork,
  DiagnosticLoopCheckpoint,
  DiagnosticLoopIdentity,
  DiagnosticLoopPhaseResult
} from "./types.js";
import { DIAGNOSTIC_100Q_KPI_PROMOTION } from
  "../diagnostics/stage-attribution/exposure/diagnostic-unlock.js";
import { summarizeMissLedgerCheckpoint } from "./miss-ledger-authority.js";

export function writeDiagnosticLoopReport(input: {
  readonly workRoot: string;
  readonly identity: DiagnosticLoopIdentity;
  readonly identityDigest: string;
  readonly checkpoints: ReadonlyMap<DiagnosticLoopPhase, DiagnosticLoopCheckpoint>;
  readonly avoidedWork: DiagnosticLoopAvoidedWork;
  readonly skippedPhases: readonly DiagnosticLoopPhase[];
}): DiagnosticLoopPhaseResult {
  const report = buildReport(input);
  const reportPath = join(input.workRoot, "report.json");
  writeJsonAtomic(reportPath, report);
  return reportPhaseResult(report, reportPath);
}

function buildReport(input: {
  readonly identity: DiagnosticLoopIdentity;
  readonly identityDigest: string;
  readonly checkpoints: ReadonlyMap<DiagnosticLoopPhase, DiagnosticLoopCheckpoint>;
  readonly avoidedWork: DiagnosticLoopAvoidedWork;
  readonly skippedPhases: readonly DiagnosticLoopPhase[];
}) {
  const control = requireCompleted(input.checkpoints, "control_recall");
  const treatment = requireCompleted(input.checkpoints, "treatment_recall");
  assertSharedSubstrate(control, treatment);
  return {
    schema_version: 4,
    kind: "diagnostic_loop_report",
    identity_digest: input.identityDigest,
    identity: {
      datasetRevision: input.identity.datasetRevision,
      requestedKeys: input.identity.requestedKeys,
      providerRoute: input.identity.providerRoute,
      model: input.identity.model,
      requestProfile: input.identity.requestProfile,
      promptDigest: input.identity.promptDigest,
      schemaDigest: input.identity.schemaDigest,
      operatorDigest: input.identity.operatorDigest,
      cacheMode: input.identity.cacheMode,
      variant: input.identity.variant,
      limit: input.identity.limit ?? null,
      offset: input.identity.offset ?? 0,
      worker: input.identity.worker
    },
    avoided_work: input.avoidedWork,
    skipped_phases: input.skippedPhases,
    control: summarizeArm(control),
    treatment: summarizeArm(treatment),
    miss_ledger: summarizeMissLedgerCheckpoint(input.checkpoints.get("miss_ledger")),
    diagnostic_100q_unlock: summarizeUnlock(input.checkpoints.get("miss_ledger")),
    diagnostic_100q_promotion: DIAGNOSTIC_100Q_KPI_PROMOTION,
    shared_substrate: {
      cache_identity: control.details.cache_identity,
      snapshot_identity: control.details.snapshot_identity
    }
  };
}

function reportPhaseResult(
  report: ReturnType<typeof buildReport>,
  reportPath: string
): DiagnosticLoopPhaseResult {
  return {
    contentIdentity: sha256Utf8(JSON.stringify(report)),
    physicalCalls: 0,
    artifactPaths: { report: reportPath },
    details: { shared_substrate: report.shared_substrate },
    noProviderCallReceipt: {
      schema_version: 1,
      kind: "internal_no_provider_port",
      provider_port: "absent",
      physical_calls: 0
    }
  };
}

function requireCompleted(
  checkpoints: ReadonlyMap<DiagnosticLoopPhase, DiagnosticLoopCheckpoint>,
  phase: DiagnosticLoopPhase
): DiagnosticLoopCheckpoint {
  const checkpoint = checkpoints.get(phase);
  if (checkpoint === undefined || checkpoint.status !== "completed") {
    throw new Error(`report-only requires a completed ${phase} checkpoint`);
  }
  return checkpoint;
}

function assertSharedSubstrate(
  control: DiagnosticLoopCheckpoint,
  treatment: DiagnosticLoopCheckpoint
): void {
  if (control.details.cache_identity !== treatment.details.cache_identity) {
    throw new Error("control and treatment cache identities differ");
  }
  if (control.details.snapshot_identity !== treatment.details.snapshot_identity) {
    throw new Error("control and treatment snapshot identities differ");
  }
}

function summarizeArm(checkpoint: DiagnosticLoopCheckpoint): Readonly<Record<string, unknown>> {
  return {
    content_identity: checkpoint.content_identity,
    physical_calls: checkpoint.physical_calls,
    artifact_paths: checkpoint.artifact_paths,
    evaluation_slice: checkpoint.details.evaluation_slice,
    cache_identity: checkpoint.details.cache_identity,
    snapshot_identity: checkpoint.details.snapshot_identity
  };
}

function summarizeUnlock(
  checkpoint: DiagnosticLoopCheckpoint | undefined
): Readonly<Record<string, unknown>> | null {
  const unlock = checkpoint?.details.diagnostic_100q_unlock;
  return unlock === undefined ? null : unlock as Readonly<Record<string, unknown>>;
}
