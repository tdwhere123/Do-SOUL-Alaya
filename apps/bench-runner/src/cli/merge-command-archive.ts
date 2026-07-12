import {
  benchArchiveDiscriminator,
  buildDiffVsPrevious,
  diffKpis,
  entrySlug,
  readLatest,
  renderFindings,
  renderReport,
  writeEntry,
  isHistoryEntryCommittedError,
  isCacheOnlySeedExtractionPath,
  type HistoryLayout,
  type KpiPayload
} from "@do-soul/alaya-eval";
import { rm } from "node:fs/promises";
import path from "node:path";
import {
  aggregateLongMemEvalArchiveEvidence,
  archiveEvidenceFromDiagnostics,
  buildLongMemEvalColdWarmComparisonSidecar,
  LONGMEMEVAL_COLD_WARM_COMPARISON_FILENAME,
  LONGMEMEVAL_DIAGNOSTICS_FILENAME,
  readLatestLongMemEvalOppositeArchive,
  renderLongMemEvalColdWarmComparisonSidecar
} from "../longmemeval/archive-evidence.js";
import {
  type LongMemEvalEmbeddingVectorCacheSummary,
  type LongMemEvalQueryEmbeddingCacheSummary
} from "../longmemeval/diagnostics.js";
import { resolveBenchDiagnosticsArtifactRoot } from "../longmemeval/diagnostics-artifacts.js";
import {
  LONGMEMEVAL_COHORT_LEDGER_FILENAME,
  renderLongMemEvalCohortLedger
} from "../longmemeval/cohort-ledger.js";
import {
  buildLongMemEvalEvidenceManifest,
  LONGMEMEVAL_EVIDENCE_MANIFEST_FILENAME,
  renderLongMemEvalEvidenceManifest,
  type LongMemEvalEvidenceArtifactInput
} from "../longmemeval/evidence-manifest.js";
import {
  buildMergedRunProvenanceSidecars,
  type MergedRunProvenanceSidecars
} from "../longmemeval/provenance/shard-aggregate.js";
import type { LongMemEvalDiagnosticsSpool } from "../longmemeval/diagnostics/spool.js";
import { buildBenchmarkMeasurementAttribution } from "../longmemeval/measurement/attribution.js";
import {
  prepareDiagnosticsArtifactStagingPath,
  withPublishedDiagnosticsArtifact
} from "../longmemeval/measurement/artifact-transaction.js";
import {
  appendSeedExtractionReleaseBlockerToFindings,
  appendSeedExtractionReleaseBlockerToReport
} from "../longmemeval/seed-extraction-release-blocker.js";
import {
  aggregateEmbeddingVectorCache,
  aggregateQueryEmbeddingCache,
  buildMergedLongMemEvalDiagnosticsSidecar,
  renderMergedLongMemEvalCompactDiagnosticsSidecar
} from "./merge-sidecar.js";
import type {
  MergedLongMemEvalBuild,
  ShardArchiveRef
} from "./merge-command-shards.js";
import { hasVerifiedShardEvidence } from "./merge/shard-evidence-verifier.js";

type ShardDiagnostics = ShardArchiveRef["diagnostics"];
type PreviousKpiPayload = Awaited<ReturnType<typeof readLatest>>;
type KpiDiff = ReturnType<typeof diffKpis>;

export interface WrittenMergedLongMemEvalArchive {
  readonly merged: KpiPayload;
  readonly slug: string;
  readonly kpiPath: string;
  readonly diagnosticsPath: string | null;
}

export async function writeMergedLongMemEvalArchive(input: {
  readonly historyRoot: string;
  readonly build: MergedLongMemEvalBuild;
  readonly shardArchiveRefs: readonly ShardArchiveRef[];
  readonly requestedConcurrency?: number;
  readonly diagnosticsSpool: LongMemEvalDiagnosticsSpool;
}): Promise<WrittenMergedLongMemEvalArchive> {
  const layout: HistoryLayout = { historyRoot: input.historyRoot };
  const shardDiagnostics = input.shardArchiveRefs.map((shard) => shard.diagnostics);
  const prepared = await prepareMergedWithDiff(
    layout,
    withCacheReadiness(input.build.payload, shardDiagnostics),
    input.build
  );
  const slug = entrySlug(
    input.build.runAt,
    input.build.commitSha7,
    benchArchiveDiscriminator(input.build.policyShape, input.build.simulateReport)
  );
  const archive = await buildMergedArchiveSidecars({
    layout,
    historyRoot: input.historyRoot,
    slug,
    merged: prepared.merged,
    previous: prepared.previous,
    diff: prepared.diff,
    shardDiagnostics,
    shardArchiveRefs: input.shardArchiveRefs,
    requestedConcurrency: input.requestedConcurrency,
    diagnosticsSpool: input.diagnosticsSpool
  });
  const entry = await withPublishedDiagnosticsArtifact(
    archive.diagnosticsArtifact,
    () => writeEntry(layout, "public", slug, archive.merged, archive.report, archive.findings, {
      sidecars: archive.sidecars,
      fileSidecars: [{
        filename: `${LONGMEMEVAL_DIAGNOSTICS_FILENAME}.gz`,
        sourcePath: archive.diagnosticsArtifact.finalPath
      }]
    }),
    isHistoryEntryCommittedError
  );
  return {
    merged: archive.merged,
    slug,
    kpiPath: entry.kpiPath,
    diagnosticsPath: entry.sidecarPaths[LONGMEMEVAL_DIAGNOSTICS_FILENAME] ?? null
  };
}

function withCacheReadiness(
  merged: KpiPayload,
  shardDiagnostics: readonly ShardDiagnostics[]
): KpiPayload {
  const embedding = aggregateEmbeddingVectorCache(
    shardDiagnostics
      .map((diagnostics) => diagnostics?.embedding_vector_cache)
      .filter(
        (summary): summary is LongMemEvalEmbeddingVectorCacheSummary =>
          summary !== undefined
      )
  );
  const query = aggregateQueryEmbeddingCache(
    shardDiagnostics
      .map((diagnostics) => diagnostics?.query_embedding_cache)
      .filter(
        (summary): summary is LongMemEvalQueryEmbeddingCacheSummary =>
          summary !== undefined
      )
  );
  return {
    ...merged,
    kpi: {
      ...merged.kpi,
      ...(embedding === null ? {} : { embedding_vector_cache_ready_rate: embedding.ready_rate }),
      ...(query === null ? {} : { query_embedding_cache_ready_rate: query.ready_rate })
    }
  };
}

async function prepareMergedWithDiff(
  layout: HistoryLayout,
  merged: KpiPayload,
  build: MergedLongMemEvalBuild
): Promise<{
  readonly merged: KpiPayload;
  readonly previous: PreviousKpiPayload;
  readonly diff: KpiDiff;
}> {
  const previous = await readLatest(layout, "public", {
    split: merged.split,
    policyShape: build.policyShape,
    simulateReport: build.simulateReport,
    embeddingProvider: merged.embedding_provider,
    pointerKind: "passing"
  });
  const diff = diffKpis(merged, previous);
  return {
    merged: {
      ...merged,
      diff_vs_previous: buildDiffVsPrevious(merged, previous, previous?.run_at ?? "")
    },
    previous,
    diff
  };
}

async function buildMergedArchiveSidecars(input: {
  readonly layout: HistoryLayout;
  readonly historyRoot: string;
  readonly slug: string;
  readonly merged: KpiPayload;
  readonly previous: PreviousKpiPayload;
  readonly diff: KpiDiff;
  readonly shardDiagnostics: readonly ShardDiagnostics[];
  readonly shardArchiveRefs: readonly ShardArchiveRef[];
  readonly requestedConcurrency?: number;
  readonly diagnosticsSpool: LongMemEvalDiagnosticsSpool;
}): Promise<{
  readonly merged: KpiPayload;
  readonly report: string;
  readonly findings: string | null;
  readonly sidecars: readonly { readonly filename: string; readonly contents: string }[];
  readonly diagnosticsArtifact: {
    readonly stagedPath: string;
    readonly finalPath: string;
  };
}> {
  const diagnostics = await buildMergedDiagnosticsSidecar(input);
  try {
    return await finishMergedArchiveSidecars(input, diagnostics);
  } catch (error) {
    await rm(diagnostics.stagedArtifactPath, { force: true });
    throw error;
  }
}

async function finishMergedArchiveSidecars(
  input: Parameters<typeof buildMergedArchiveSidecars>[0],
  diagnostics: Awaited<ReturnType<typeof buildMergedDiagnosticsSidecar>>
): ReturnType<typeof buildMergedArchiveSidecars> {
  const cohort = renderLongMemEvalCohortLedger(
    diagnostics.payload.sidecar.questions,
    diagnostics.payload.failed_question_ids
  );
  const provenance = await buildMergedRunProvenanceSidecars({
    shardArchiveRefs: input.shardArchiveRefs,
    requestedConcurrency: input.requestedConcurrency
  });
  const provenanceComplete = provenance.gateEligible &&
    input.shardDiagnostics.every(hasVerifiedShardEvidence) &&
    isCacheOnlySeedExtractionPath(input.merged.kpi.seed_extraction_path);
  const merged = buildAttributedMergedPayload(
    input,
    mergedCandidatePoolComplete(input, diagnostics),
    provenanceComplete
  );
  const attributedInput = { ...input, merged };
  const { report, findings } = renderMergedDocuments(attributedInput);
  const comparison = await buildMergedComparisonSidecar(attributedInput, diagnostics.evidence);
  const manifest = buildMergedEvidenceManifest({
    input: attributedInput, diagnostics, comparison, cohort, provenance,
    provenanceComplete, report, findings
  });
  return {
    merged,
    report,
    findings,
    sidecars: [
      { filename: LONGMEMEVAL_DIAGNOSTICS_FILENAME, contents: diagnostics.contents },
      { filename: LONGMEMEVAL_COHORT_LEDGER_FILENAME, contents: cohort },
      { filename: LONGMEMEVAL_COLD_WARM_COMPARISON_FILENAME, contents: comparison },
      ...provenance.sidecars,
      manifest
    ],
    diagnosticsArtifact: {
      stagedPath: diagnostics.stagedArtifactPath,
      finalPath: diagnostics.fullArtifactPath
    }
  };
}

function buildAttributedMergedPayload(
  input: Parameters<typeof buildMergedArchiveSidecars>[0],
  candidatePoolComplete: boolean,
  provenanceComplete: boolean
): KpiPayload {
  const metrics = input.merged.kpi.quality_metrics;
  return {
    ...input.merged,
    measurement_attribution: buildBenchmarkMeasurementAttribution({
      candidatePoolComplete,
      provenanceComplete,
      abstention: metrics?.abstention,
      noGoldCount: metrics?.no_gold_count,
      evaluatorIdentityIssueCount: metrics?.evaluator_identity_issue_count,
      evaluatorIdentityUnscorableCount:
        metrics?.evaluator_identity_unscorable_count
    })
  };
}

function mergedCandidatePoolComplete(
  input: Parameters<typeof buildMergedArchiveSidecars>[0],
  diagnostics: Awaited<ReturnType<typeof buildMergedDiagnosticsSidecar>>
): boolean {
  return diagnostics.payload.failed_question_ids.length === 0 &&
    diagnostics.payload.sidecar.questions.length === input.merged.evaluated_count &&
    diagnostics.payload.sidecar.questions.every(
      (question) => question.candidate_pool_complete
    );
}

function renderMergedDocuments(input: {
  readonly merged: KpiPayload;
  readonly previous: PreviousKpiPayload;
  readonly diff: KpiDiff;
}): { readonly report: string; readonly findings: string | null } {
  return {
    report: appendSeedExtractionReleaseBlockerToReport(
      renderReport(input.merged, input.previous, input.diff),
      input.merged
    ),
    findings: appendSeedExtractionReleaseBlockerToFindings(
      renderFindings(input.merged, input.diff),
      input.merged
    )
  };
}

interface MergedDiagnosticsInput {
  readonly historyRoot: string;
  readonly slug: string;
  readonly merged: KpiPayload;
  readonly shardDiagnostics: readonly ShardDiagnostics[];
  readonly diagnosticsSpool: LongMemEvalDiagnosticsSpool;
}

async function buildMergedDiagnosticsSidecar(input: MergedDiagnosticsInput): Promise<{
  readonly contents: string;
  readonly fullArtifactPath: string;
  readonly stagedArtifactPath: string;
  readonly fullArtifactIdentity: { readonly bytes: number; readonly sha256: string };
  readonly payload: ReturnType<typeof buildMergedLongMemEvalDiagnosticsSidecar>;
  readonly evidence: ReturnType<typeof aggregateLongMemEvalArchiveEvidence>;
}> {
  const evidence = aggregateLongMemEvalArchiveEvidence(
    input.shardDiagnostics.map((diagnostics) =>
      archiveEvidenceFromDiagnostics(diagnostics)
    )
  );
  const diagnosticsPayload = buildMergedLongMemEvalDiagnosticsSidecar(
    input.merged,
    input.shardDiagnostics,
    evidence
  );
  const artifactPath = path.join(
    resolveBenchDiagnosticsArtifactRoot(input.historyRoot),
    "public",
    input.slug,
    `${LONGMEMEVAL_DIAGNOSTICS_FILENAME}.gz`
  );
  const stagedArtifactPath = await prepareDiagnosticsArtifactStagingPath(
    resolveBenchDiagnosticsArtifactRoot(input.historyRoot),
    `${input.slug}-${LONGMEMEVAL_DIAGNOSTICS_FILENAME}.gz`
  );
  const artifact = await input.diagnosticsSpool.writeGzipArtifact(
    stagedArtifactPath,
    diagnosticsPayload.sidecar
  );
  return {
    contents: renderMergedLongMemEvalCompactDiagnosticsSidecar(
      diagnosticsPayload,
      `${LONGMEMEVAL_DIAGNOSTICS_FILENAME}.gz`
    ),
    fullArtifactPath: artifactPath,
    stagedArtifactPath: artifact.artifactPath,
    fullArtifactIdentity: { bytes: artifact.bytes, sha256: artifact.sha256 },
    payload: diagnosticsPayload,
    evidence
  };
}

interface MergedEvidenceInput {
  readonly input: Parameters<typeof buildMergedArchiveSidecars>[0];
  readonly diagnostics: Awaited<ReturnType<typeof buildMergedDiagnosticsSidecar>>;
  readonly comparison: string;
  readonly cohort: string;
  readonly provenance: MergedRunProvenanceSidecars;
  readonly provenanceComplete: boolean;
  readonly report: string;
  readonly findings: string | null;
}

function buildMergedEvidenceManifest(input: MergedEvidenceInput) {
  const datasetSha = input.input.merged.dataset.checksum_sha256;
  if (datasetSha === undefined) {
    throw new Error("LongMemEval evidence manifest requires dataset.checksum_sha256");
  }
  const cohort = JSON.parse(input.cohort) as { readonly question_id_digest: string };
  const questions = input.diagnostics.payload.sidecar.questions;
  const candidatePoolsComplete = input.diagnostics.payload.failed_question_ids.length === 0 &&
    questions.length === input.input.merged.evaluated_count &&
    questions.every((question) => question.candidate_pool_complete);
  const manifest = buildLongMemEvalEvidenceManifest({
    run: {
      slug: input.input.slug,
      bench_name: "public",
      split: input.input.merged.split,
      run_at: input.input.merged.run_at,
      alaya_commit: input.input.merged.alaya_commit,
      dataset_sha256: datasetSha,
      selection_manifest_sha256: input.provenance.selectionManifestSha256,
      question_id_digest: cohort.question_id_digest,
      candidate_pool_complete: candidatePoolsComplete,
      provenance_complete: input.provenanceComplete
    },
    artifacts: buildMergedEvidenceArtifacts(input)
  });
  return {
    filename: LONGMEMEVAL_EVIDENCE_MANIFEST_FILENAME,
    contents: renderLongMemEvalEvidenceManifest(manifest)
  };
}

function buildMergedEvidenceArtifacts(
  input: MergedEvidenceInput
): LongMemEvalEvidenceArtifactInput[] {
  const artifacts: LongMemEvalEvidenceArtifactInput[] = [
    { role: "kpi", path: "kpi.json", contents: `${JSON.stringify(input.input.merged, null, 2)}\n` },
    { role: "report", path: "report.md", contents: input.report },
    { role: "diagnostics", path: LONGMEMEVAL_DIAGNOSTICS_FILENAME, contents: input.diagnostics.contents },
    {
      role: "full_diagnostics",
      path: `${LONGMEMEVAL_DIAGNOSTICS_FILENAME}.gz`,
      identity: input.diagnostics.fullArtifactIdentity
    },
    { role: "cohort_ledger", path: LONGMEMEVAL_COHORT_LEDGER_FILENAME, contents: input.cohort },
    { role: "comparison", path: LONGMEMEVAL_COLD_WARM_COMPARISON_FILENAME, contents: input.comparison },
    ...input.provenance.artifacts
  ];
  if (input.findings !== null) {
    artifacts.splice(2, 0, { role: "findings", path: "findings.md", contents: input.findings });
  }
  return artifacts;
}

async function buildMergedComparisonSidecar(
  input: {
    readonly layout: HistoryLayout;
    readonly slug: string;
    readonly merged: KpiPayload;
  },
  currentEvidence: ReturnType<typeof aggregateLongMemEvalArchiveEvidence>
): Promise<string> {
  const opposite = await readLatestLongMemEvalOppositeArchive({
    layout: input.layout,
    current: input.merged
  });
  return renderLongMemEvalColdWarmComparisonSidecar(
    buildLongMemEvalColdWarmComparisonSidecar({
      currentSlug: input.slug,
      current: input.merged,
      currentEvidence,
      opposite
    })
  );
}
