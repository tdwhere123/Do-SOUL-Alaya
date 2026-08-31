import {
  renderCompactDiagnosticsSidecar,
  summarizeLongMemEvalRecallEvidence,
  summarizeLongMemEvalReportSideEffects,
  type LongMemEvalDiagnosticsSidecar
} from "../../../../diagnostics/diagnostics.js";
import {
  resolveBenchDiagnosticsArtifactRoot
} from "../../../../artifacts/diagnostics-artifacts.js";
import path from "node:path";
import {
  LONGMEMEVAL_DIAGNOSTICS_FILENAME
} from "../../../../runs/archive/archive-evidence.js";
import type { BenchCommitInfo } from "../runner-helpers.js";
import type { LongMemEvalRunOptions } from "../../runner.js";
import type { LongMemEvalRunArchiveAggregate } from "./runner-archive-aggregate.js";
import type { LongMemEvalPayloadBuild } from "./runner-archive-payload.js";
import type { KpiPayload } from "@do-soul/alaya-eval";
import type { LongMemEvalDiagnosticsSpool } from "../../../../diagnostics/spool.js";
import { prepareDiagnosticsArtifactStagingPath } from
  "../../../../runs/measurement/artifact-transaction.js";

export async function buildDiagnosticsSidecar(input: {
  readonly opts: LongMemEvalRunOptions;
  readonly aggregate: LongMemEvalRunArchiveAggregate;
  readonly build: LongMemEvalPayloadBuild;
  readonly commitInfo: BenchCommitInfo;
  readonly questionFailures: number;
  readonly failedQuestionIds: readonly string[];
  readonly collectedLength: number;
  readonly payload: KpiPayload;
  readonly slug: string;
  readonly diagnosticsSpool: LongMemEvalDiagnosticsSpool;
}): Promise<{
  readonly compact: string;
  readonly fullArtifactPath: string;
  readonly stagedArtifactPath: string;
  readonly fullArtifactIdentity: { readonly bytes: number; readonly sha256: string };
  readonly persistedPayload: LongMemEvalDiagnosticsSidecar;
  readonly currentEvidence: ReturnType<typeof buildCurrentEvidence>;
}> {
  const currentEvidence = buildCurrentEvidence(input);
  const diagnosticsPayload = buildDiagnosticsPayload(input, currentEvidence);
  const artifact = await writeFullDiagnosticsArtifact({
    historyRoot: input.opts.historyRoot,
    slug: input.slug,
    sidecar: diagnosticsPayload,
    diagnosticsSpool: input.diagnosticsSpool
  });
  return {
    compact: renderCompactDiagnosticsSidecar(
      diagnosticsPayload,
      `${LONGMEMEVAL_DIAGNOSTICS_FILENAME}.gz`,
      { includeQuestions: true }
    ),
    fullArtifactPath: artifact.finalPath,
    stagedArtifactPath: artifact.stagedPath,
    fullArtifactIdentity: artifact.identity,
    persistedPayload: diagnosticsPayload,
    currentEvidence
  };
}

function buildCurrentEvidence(input: {
  readonly aggregate: LongMemEvalRunArchiveAggregate;
  readonly payload: KpiPayload;
}): {
  readonly report_side_effects: ReturnType<typeof summarizeLongMemEvalReportSideEffects>;
  readonly scored_recall_evidence: ReturnType<typeof summarizeLongMemEvalRecallEvidence>;
} {
  return {
    report_side_effects: summarizeLongMemEvalReportSideEffects({
      mode: input.payload.simulate_report,
      snapshots: input.aggregate.reportSideEffectSnapshots
    }),
    scored_recall_evidence: summarizeLongMemEvalRecallEvidence(
      input.aggregate.questionDiagnostics
    )
  };
}

async function writeFullDiagnosticsArtifact(input: {
  readonly historyRoot: string;
  readonly slug: string;
  readonly sidecar: LongMemEvalDiagnosticsSidecar;
  readonly diagnosticsSpool: LongMemEvalDiagnosticsSpool;
}): Promise<{
  readonly finalPath: string;
  readonly stagedPath: string;
  readonly identity: { readonly bytes: number; readonly sha256: string };
}> {
  const artifactPath = path.join(
    resolveBenchDiagnosticsArtifactRoot(input.historyRoot),
    "public",
    input.slug,
    `${LONGMEMEVAL_DIAGNOSTICS_FILENAME}.gz`
  );
  const stagedPath = await prepareDiagnosticsArtifactStagingPath(
    resolveBenchDiagnosticsArtifactRoot(input.historyRoot),
    `${input.slug}-${LONGMEMEVAL_DIAGNOSTICS_FILENAME}.gz`
  );
  const written = await input.diagnosticsSpool.writeGzipArtifact(
    stagedPath,
    input.sidecar
  );
  return {
    finalPath: artifactPath,
    stagedPath: written.artifactPath,
    identity: { bytes: written.bytes, sha256: written.sha256 }
  };
}

function buildDiagnosticsPayload(
  input: Parameters<typeof buildDiagnosticsSidecar>[0],
  currentEvidence: ReturnType<typeof buildCurrentEvidence>
): LongMemEvalDiagnosticsSidecar {
  return {
    schema_version: 1,
    bench_name: "public",
    split: input.payload.split,
    run_at: input.payload.run_at,
    alaya_commit: input.payload.alaya_commit,
    commit_resolution: input.commitInfo,
    recall_pipeline_version: input.payload.recall_pipeline_version,
    embedding_provider: input.payload.embedding_provider,
    embedding_mode: input.opts.embeddingMode ?? "disabled",
    policy_shape: input.payload.policy_shape,
    simulate_report: input.payload.simulate_report,
    seed_extraction_path: input.payload.kpi.seed_extraction_path,
    ...(input.payload.kpi.seed_fuel_inventory === undefined
      ? {}
      : { seed_fuel_inventory: input.payload.kpi.seed_fuel_inventory }),
    report_usage: {
      mode: input.payload.simulate_report,
      reports_attempted: input.build.reportUsage.reportsAttempted,
      reports_used: input.build.reportUsage.reportsUsed,
      reports_skipped: input.build.reportUsage.reportsSkipped,
      used_object_count: input.build.reportUsage.reportUsedObjectCount
    },
    ...(input.questionFailures === 0
      ? {}
      : {
          question_failures: {
            failed_count: input.questionFailures,
            completed_count: input.collectedLength,
            failed_question_ids: input.failedQuestionIds
          }
        }),
    report_side_effects: currentEvidence.report_side_effects,
    scored_recall_evidence: currentEvidence.scored_recall_evidence,
    ...(input.build.embeddingVectorCache === null ? {} : { embedding_vector_cache: input.build.embeddingVectorCache }),
    ...(input.build.queryEmbeddingCache === null ? {} : { query_embedding_cache: input.build.queryEmbeddingCache }),
    provider_state_summary: input.build.providerSummary,
    questions: input.aggregate.questionDiagnostics
  } as const;
}
