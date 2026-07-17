import {
  benchArchiveDiscriminator,
  buildDiffVsPrevious,
  diffKpis,
  entrySlug,
  readLatest,
  renderFindings,
  renderReport,
  isCacheOnlySeedExtractionPath,
  type HistoryLayout,
  type KpiPayload,
  type VerifiedLongMemEvalEvidenceContext
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
} from "../../../longmemeval/archive/archive-evidence.js";
import {
  type LongMemEvalEmbeddingVectorCacheSummary,
  type LongMemEvalQueryEmbeddingCacheSummary
} from "../../../longmemeval/diagnostics.js";
import { resolveBenchDiagnosticsArtifactRoot } from "../../../longmemeval/diagnostics/artifacts/diagnostics-artifacts.js";
import {
  LONGMEMEVAL_COHORT_LEDGER_FILENAME,
  renderLongMemEvalCohortLedger
} from "../../../longmemeval/selection/cohort-ledger.js";
import {
  buildMergedEvidenceManifest
} from "../merged/merged-evidence-manifest.js";
import {
  buildMergedRunProvenanceSidecars,
  resolveMergedRequestedConcurrency,
  type MergedRunProvenanceSidecars
} from "../../../longmemeval/provenance/shard-aggregate.js";
import type { LoadedGlobalExtractionAuthority } from "../../../longmemeval/provenance/contract/extraction-authority-reference.js";
import type { LongMemEvalDiagnosticsSpool } from "../../../longmemeval/diagnostics/spool.js";
import { buildBenchmarkMeasurementAttribution } from "../../../longmemeval/measurement/attribution.js";
import { assertMeasurementCohortBinding } from "../../../longmemeval/measurement/cohort-binding.js";
import { prepareDiagnosticsArtifactStagingPath } from "../../../longmemeval/measurement/artifact-transaction.js";
import {
  appendSeedExtractionReleaseBlockerToFindings,
  appendSeedExtractionReleaseBlockerToReport
} from "../../../longmemeval/extraction/seed-fuel/seed-extraction-release-blocker.js";
import {
  aggregateEmbeddingVectorCache,
  aggregateQueryEmbeddingCache,
  buildMergedLongMemEvalDiagnosticsSidecar,
  renderMergedLongMemEvalCompactDiagnosticsSidecar
} from "../../merge-sidecar.js";
import type {
  MergedLongMemEvalBuild,
  ShardArchiveRef
} from "./merge-command-shards.js";
import { hasVerifiedShardEvidence } from "../shard/shard-evidence-verifier.js";
import {
  selectionContractIdentity,
  type LongMemEvalSelectionContract
} from "../../../longmemeval/selection/contract.js";
import { createLongMemEvalHistoryLayout } from "../../../longmemeval/history/evidence-context.js";
import { publishMergedArchive } from "../archive-publisher.js";
import type { LongMemEvalReleaseEvidenceAuthority } from
  "@do-soul/alaya-eval/internal";

type ShardDiagnostics = ShardArchiveRef["diagnostics"];
type PreviousKpiPayload = Awaited<ReturnType<typeof readLatest>>;
type KpiDiff = ReturnType<typeof diffKpis>;

export interface WrittenMergedLongMemEvalArchive {
  readonly merged: KpiPayload;
  readonly slug: string;
  readonly kpiPath: string;
  readonly diagnosticsPath: string | null;
  readonly evidenceContext: VerifiedLongMemEvalEvidenceContext | null;
}

export async function writeMergedLongMemEvalArchive(input: {
  readonly historyRoot: string;
  readonly releaseEvidenceAuthority?: LongMemEvalReleaseEvidenceAuthority | null;
  readonly build: MergedLongMemEvalBuild;
  readonly shardArchiveRefs: readonly ShardArchiveRef[];
  readonly requestedConcurrency?: number;
  readonly globalExtractionAuthority?: LoadedGlobalExtractionAuthority | null;
  readonly diagnosticsSpool: LongMemEvalDiagnosticsSpool;
}): Promise<WrittenMergedLongMemEvalArchive> {
  const trustedRequestedConcurrency = resolveMergedRequestedConcurrency({
    requestedConcurrency: input.requestedConcurrency,
    shardCount: input.shardArchiveRefs.length,
    globalExtractionAuthority: input.globalExtractionAuthority
  });
  const layout = createMergedHistoryLayout(input, trustedRequestedConcurrency);
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
    selectionContract: input.build.selectionContract,
    requestedConcurrency: trustedRequestedConcurrency ?? undefined,
    globalExtractionAuthority: input.globalExtractionAuthority,
    diagnosticsSpool: input.diagnosticsSpool
  });
  const published = await publishMergedArchive({ layout, slug, archive });
  return {
    merged: archive.merged,
    slug,
    ...published
  };
}

function createMergedHistoryLayout(
  input: Parameters<typeof writeMergedLongMemEvalArchive>[0],
  trustedRequestedConcurrency: number | null
): HistoryLayout {
  if (trustedRequestedConcurrency === null ||
      input.build.selectionContract === null ||
      input.releaseEvidenceAuthority == null) {
    return { historyRoot: input.historyRoot };
  }
  return createLongMemEvalHistoryLayout({
    historyRoot: input.historyRoot,
    authority: input.releaseEvidenceAuthority
  });
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
  readonly selectionContract: LongMemEvalSelectionContract | null;
  readonly requestedConcurrency?: number;
  readonly globalExtractionAuthority?: LoadedGlobalExtractionAuthority | null;
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
  const provenance = await buildMergedRunProvenanceSidecars({
    shardArchiveRefs: input.shardArchiveRefs,
    requestedConcurrency: input.requestedConcurrency,
    selectionContract: input.selectionContract,
    globalExtractionAuthority: input.globalExtractionAuthority
  });
  const evidence = await buildMergedEvidenceSidecars(input, diagnostics, provenance);
  return {
    merged: evidence.merged,
    report: evidence.report,
    findings: evidence.findings,
    sidecars: [
      { filename: LONGMEMEVAL_DIAGNOSTICS_FILENAME, contents: diagnostics.contents },
      { filename: LONGMEMEVAL_COHORT_LEDGER_FILENAME, contents: evidence.cohort },
      { filename: LONGMEMEVAL_COLD_WARM_COMPARISON_FILENAME,
        contents: evidence.comparison },
      ...provenance.sidecars,
      evidence.manifest
    ],
    diagnosticsArtifact: {
      stagedPath: diagnostics.stagedArtifactPath,
      finalPath: diagnostics.fullArtifactPath
    }
  };
}

async function buildMergedEvidenceSidecars(
  input: Parameters<typeof buildMergedArchiveSidecars>[0],
  diagnostics: Awaited<ReturnType<typeof buildMergedDiagnosticsSidecar>>,
  provenance: Awaited<ReturnType<typeof buildMergedRunProvenanceSidecars>>
) {
  assertMergedSelectionIdentity(input.merged, provenance.selectionContract);
  const cohort = renderLongMemEvalCohortLedger(
    diagnostics.payload.sidecar.questions,
    diagnostics.payload.failed_question_ids,
    provenance.selectionContract ?? undefined
  );
  const provenanceComplete = provenance.gateEligible &&
    provenance.selectionContract !== null &&
    input.shardDiagnostics.every(hasVerifiedShardEvidence) &&
    isCacheOnlySeedExtractionPath(input.merged.kpi.seed_extraction_path);
  const merged = buildAttributedMergedPayload(
    input,
    diagnostics.payload.sidecar.questions,
    mergedCandidatePoolComplete(input, diagnostics),
    provenanceComplete
  );
  const attributedInput = { ...input, merged };
  const { report, findings } = renderMergedDocuments(attributedInput);
  const comparison = await buildMergedComparisonSidecar(attributedInput, diagnostics.evidence);
  const manifest = buildMergedEvidenceManifest({
    slug: attributedInput.slug,
    merged: attributedInput.merged,
    diagnostics: {
      contents: diagnostics.contents,
      fullArtifactIdentity: diagnostics.fullArtifactIdentity,
      failedQuestionIds: diagnostics.payload.failed_question_ids,
      questions: diagnostics.payload.sidecar.questions
    },
    comparison,
    cohort,
    provenance,
    provenanceComplete,
    report,
    findings
  });
  return {
    merged,
    report,
    findings,
    cohort,
    comparison,
    manifest
  };
}

function assertMergedSelectionIdentity(
  merged: KpiPayload,
  contract: LongMemEvalSelectionContract | null
): void {
  const expected = contract === null ? undefined : selectionContractIdentity(contract);
  if (JSON.stringify(merged.selection_contract) !== JSON.stringify(expected)) {
    throw new Error("merged KPI selection contract differs from verified shard evidence");
  }
}

function buildAttributedMergedPayload(
  input: Parameters<typeof buildMergedArchiveSidecars>[0],
  diagnostics: Awaited<ReturnType<typeof buildMergedDiagnosticsSidecar>>["payload"]["sidecar"]["questions"],
  candidatePoolComplete: boolean,
  provenanceComplete: boolean
): KpiPayload {
  if (input.merged.answerable_evaluated_count === undefined) {
    return input.merged;
  }
  assertMeasurementCohortBinding(input.merged.kpi.per_scenario, diagnostics);
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
