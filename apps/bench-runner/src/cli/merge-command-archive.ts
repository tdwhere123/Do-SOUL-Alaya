import {
  benchArchiveDiscriminator,
  buildDiffVsPrevious,
  diffKpis,
  entrySlug,
  readLatest,
  renderFindings,
  renderReport,
  writeEntry,
  type HistoryLayout,
  type KpiPayload
} from "@do-soul/alaya-eval";
import {
  aggregateLongMemEvalArchiveEvidence,
  archiveEvidenceFromDiagnostics,
  buildLongMemEvalColdWarmComparisonSidecar,
  LONGMEMEVAL_COLD_WARM_COMPARISON_FILENAME,
  LONGMEMEVAL_DIAGNOSTICS_FILENAME,
  readLatestLongMemEvalOppositeArchive,
  readLongMemEvalDiagnosticsSidecar,
  renderLongMemEvalColdWarmComparisonSidecar
} from "../longmemeval/archive-evidence.js";
import {
  renderDiagnosticsSidecar,
  type LongMemEvalEmbeddingVectorCacheSummary,
  type LongMemEvalQueryEmbeddingCacheSummary
} from "../longmemeval/diagnostics.js";
import { writeExternalDiagnosticsArtifact } from "../longmemeval/diagnostics-artifacts.js";
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

type ShardDiagnostics = Awaited<
  ReturnType<typeof readLongMemEvalDiagnosticsSidecar>
>;
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
}): Promise<WrittenMergedLongMemEvalArchive> {
  const layout: HistoryLayout = { historyRoot: input.historyRoot };
  const shardDiagnostics = await readShardDiagnostics(input.shardArchiveRefs);
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
    shardDiagnostics
  });
  const entry = await writeEntry(layout, "public", slug, prepared.merged, archive.report, archive.findings, {
    sidecars: archive.sidecars
  });
  return {
    merged: prepared.merged,
    slug,
    kpiPath: entry.kpiPath,
    diagnosticsPath: entry.sidecarPaths[LONGMEMEVAL_DIAGNOSTICS_FILENAME] ?? null
  };
}

async function readShardDiagnostics(
  shardArchiveRefs: readonly ShardArchiveRef[]
): Promise<NonNullable<ShardDiagnostics>[]> {
  return Promise.all(
    shardArchiveRefs.map(async (shard) => {
      const diagnostics = await readLongMemEvalDiagnosticsSidecar(
        { historyRoot: shard.root },
        "public",
        shard.slug
      );
      if (diagnostics === null) {
        throw new Error(
          `merge refused: missing diagnostics sidecar for shard root=${shard.root} slug=${shard.slug}`
        );
      }
      return diagnostics;
    })
  );
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
}): Promise<{
  readonly report: string;
  readonly findings: string | null;
  readonly sidecars: readonly { readonly filename: string; readonly contents: string }[];
}> {
  const report = appendSeedExtractionReleaseBlockerToReport(
    renderReport(input.merged, input.previous, input.diff),
    input.merged
  );
  const findings = appendSeedExtractionReleaseBlockerToFindings(
    renderFindings(input.merged, input.diff),
    input.merged
  );
  const diagnostics = await buildMergedDiagnosticsSidecar(input);
  const comparison = await buildMergedComparisonSidecar(input, diagnostics.evidence);
  return {
    report,
    findings,
    sidecars: [
      { filename: LONGMEMEVAL_DIAGNOSTICS_FILENAME, contents: diagnostics.contents },
      { filename: LONGMEMEVAL_COLD_WARM_COMPARISON_FILENAME, contents: comparison }
    ]
  };
}

async function buildMergedDiagnosticsSidecar(input: {
  readonly historyRoot: string;
  readonly slug: string;
  readonly merged: KpiPayload;
  readonly shardDiagnostics: readonly ShardDiagnostics[];
}): Promise<{ readonly contents: string; readonly evidence: ReturnType<typeof aggregateLongMemEvalArchiveEvidence> }> {
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
  const artifactPath = await writeExternalDiagnosticsArtifact({
    historyRoot: input.historyRoot,
    benchName: "public",
    slug: input.slug,
    filename: LONGMEMEVAL_DIAGNOSTICS_FILENAME,
    contents: renderDiagnosticsSidecar(diagnosticsPayload.sidecar)
  });
  return {
    contents: renderMergedLongMemEvalCompactDiagnosticsSidecar(
      diagnosticsPayload,
      artifactPath
    ),
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
