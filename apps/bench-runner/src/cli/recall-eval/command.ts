import process from "node:process";
import {
  runRecallEval,
  type RecallEvalOptions,
  type RecallEvalResult
} from "../../runs/lifecycle/recall-eval/recall-eval-impl.js";
import type { ParsedFlags } from "../cli-options.js";
import { exitCodeForReleaseHardGates } from "../release-hard-gate-exit.js";
import { pct } from "../result-format.js";
import { renderLifecycleFailure } from
  "../../runs/lifecycle/errors.js";

export async function runRecallEvalCommand(opts: ParsedFlags): Promise<number> {
  if (opts.snapshot === undefined) {
    process.stderr.write("alaya-bench-runner recall-eval: --snapshot <db> required\n");
    return 2;
  }
  try {
    assertExperimentFlags(opts);
    process.stdout.write(renderStart(opts));
    const result = await runRecallEval(buildRecallEvalOptions(opts, opts.snapshot));
    process.stdout.write(renderResult(result));
    if (result.completion.status !== "complete" ||
        result.memoryProfile.status === "incomplete") return 2;
    return exitCodeForReleaseHardGates(result.payload);
  } catch (error) {
    process.stderr.write(
      `alaya-bench-runner recall-eval: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return 2;
  }
}

export function buildRecallEvalOptions(
  opts: ParsedFlags,
  snapshot: string
): RecallEvalOptions {
  return {
    snapshotDbPath: snapshot, variant: opts.variant,
    historyRoot: opts.historyRoot, policyShape: opts.policyShape,
    simulateReport: opts.simulateReport,
    ...(opts.limit === undefined ? {} : { limit: opts.limit }),
    ...(opts.offset === undefined ? {} : { offset: opts.offset }),
    ...(opts.concurrency === undefined ? {} : { concurrency: opts.concurrency }),
    ...(opts.weightOverridesJson === undefined ? {} : { weightOverridesJson: opts.weightOverridesJson }),
    ...(opts.dataDir === undefined ? {} : { dataDir: opts.dataDir }),
    ...(opts.dataDirRoot === undefined ? {} : { dataDirRoot: opts.dataDirRoot }),
    ...(opts.pinnedMetaRoot === undefined ? {} : { pinnedMetaRoot: opts.pinnedMetaRoot }),
    ...(opts.experiment === true ? { experiment: true } : {}),
    ...(opts.rebuildEvidenceSearchProjections === true
      ? { derivedEvidenceProjectionRebuild: true }
      : {}),
    ...(opts.backfillMissingFactFrameFormations === true
      ? { backfillMissingFactFrameFormations: true }
      : {}),
    ...(opts.warmDerivedSnapshotReceipt === undefined
      ? {}
      : { warmDerivedSnapshotReceiptPath: opts.warmDerivedSnapshotReceipt }),
    ...(opts.embeddingCacheOverlayReceipt === undefined
      ? {}
      : { embeddingCacheOverlayReceiptPath: opts.embeddingCacheOverlayReceipt }),
    ...(opts.factFrameRetrofitLedger === undefined
      ? {}
      : { factFrameRetrofitLedgerPath: opts.factFrameRetrofitLedger }),
    ...(opts.seedExtractionSystemPrompt === undefined
      ? {}
      : { seedExtractionSystemPromptPath: opts.seedExtractionSystemPrompt }),
    ...(opts.querySemanticFactorCache === undefined
      ? {}
      : { querySemanticFactorCachePath: opts.querySemanticFactorCache })
  };
}

function assertExperimentFlags(opts: ParsedFlags): void {
  if (opts.warmDerivedSnapshotReceipt !== undefined && opts.experiment !== true) {
    throw new Error("--warm-derived-snapshot-receipt requires --experiment");
  }
  if (opts.warmDerivedSnapshotReceipt !== undefined &&
      opts.rebuildEvidenceSearchProjections === true) {
    throw new Error(
      "--warm-derived-snapshot-receipt cannot be combined with projection rebuild"
    );
  }
  if (opts.seedExtractionSystemPrompt !== undefined && opts.experiment !== true) {
    throw new Error(
      "--seed-extraction-system-prompt requires --experiment"
    );
  }
  if (opts.factFrameRetrofitLedger !== undefined &&
      opts.rebuildEvidenceSearchProjections !== true) {
    throw new Error(
      "--fact-frame-retrofit-ledger requires --rebuild-evidence-search-projections"
    );
  }
  if (opts.backfillMissingFactFrameFormations === true &&
      opts.rebuildEvidenceSearchProjections !== true) {
    throw new Error(
      "--backfill-missing-fact-frame-formations requires " +
      "--rebuild-evidence-search-projections"
    );
  }
  if (opts.backfillMissingFactFrameFormations === true &&
      opts.factFrameRetrofitLedger !== undefined) {
    throw new Error(
      "--backfill-missing-fact-frame-formations cannot be combined with " +
      "--fact-frame-retrofit-ledger"
    );
  }
  if (opts.rebuildEvidenceSearchProjections === true && opts.experiment !== true) {
    throw new Error(
      "--rebuild-evidence-search-projections requires --experiment"
    );
  }
}

function renderStart(opts: ParsedFlags): string {
  return `Running recall-eval against snapshot ${opts.snapshot}` +
    (opts.experiment === true ? " mode=experiment" : "") +
    (opts.rebuildEvidenceSearchProjections === true
      ? " derived_projection_rebuild=true promotable=false"
      : "") +
    (opts.warmDerivedSnapshotReceipt === undefined
      ? ""
      : " warm_derived_snapshot=true promotable=false") +
    (opts.embeddingCacheOverlayReceipt === undefined
      ? ""
      : " embedding_cache_overlay=true") +
    (opts.factFrameRetrofitLedger === undefined ? "" : " fact_frame_retrofit=true") +
    (opts.backfillMissingFactFrameFormations === true
      ? " fact_frame_default_backfill=true"
      : "") +
    (opts.seedExtractionSystemPrompt === undefined ? "" : " historical_prompt=true") +
    (opts.offset !== undefined ? ` offset=${opts.offset}` : "") +
    (opts.limit !== undefined ? ` limit=${opts.limit}` : "") +
    ` policy_shape=${opts.policyShape}` +
    (opts.weightOverridesJson !== undefined ? " weights=cli" : "") + "...\n";
}

function renderResult(result: RecallEvalResult): string {
  const kpi = result.payload.kpi;
  const coverage = kpi.full_gold_coverage;
  const rebuild = result.derivedEvidenceProjectionRebuild;
  return `Done. Slug: ${result.slug}\n` +
    `  R@1=${pct(kpi.r_at_1)} R@5=${pct(kpi.r_at_5)} R@10=${pct(kpi.r_at_10)}\n` +
    (coverage === undefined ? "" :
      `  full-gold@5=${pct(coverage.full_gold_at_5)} cov@5=${pct(coverage.gold_coverage_at_5)} ` +
      `pool@50=${pct(coverage.pool_recall_at_50)} pool@100=${pct(coverage.pool_recall_at_100)}\n`) +
    `  latency p50=${kpi.latency_ms_p50}ms p95=${kpi.latency_ms_p95}ms\n` +
    (rebuild === undefined ? "" :
      `  derived-projections owners=${rebuild.rebuilt_owner_count}/${rebuild.eligible_owner_count} ` +
      `zero=${rebuild.zero_child_owner_count} nonzero=${rebuild.nonzero_child_owner_count} ` +
      `children=${rebuild.child_count} rejected=${rebuild.rejected_owner_count} ` +
      `sha256=${rebuild.projection_content_sha256} promotable=false\n`) +
    (rebuild?.fact_frame_retrofit === undefined ? "" :
      `  fact-frame-retrofit owners=${rebuild.fact_frame_retrofit.rebuilt_owner_count} ` +
      `projections=${rebuild.fact_frame_retrofit.projection_count} ` +
      `ledger_sha256=${rebuild.fact_frame_retrofit.ledger_sha256}\n`) +
    (rebuild?.fact_frame_formation_backfill === undefined ? "" :
      `  fact-frame-default-backfill owners=` +
      `${rebuild.fact_frame_formation_backfill.backfilled_capture_count}/` +
      `${rebuild.fact_frame_formation_backfill.eligible_owner_count} ` +
      `formed=${rebuild.fact_frame_formation_backfill.formed_capture_count} ` +
      `projections=${rebuild.fact_frame_formation_backfill.projection_count}\n`) +
    renderCompletion(result) +
    `  KPI: ${result.kpiPath}\n`;
}

function renderCompletion(result: RecallEvalResult): string {
  return `  completion status=${result.completion.status}` +
    renderFailures(result.completion.failures) + "\n" +
    `  memory-profile status=${result.memoryProfile.status}` +
    renderFailures(result.memoryProfile.failures) + "\n";
}

function renderFailures(
  failures: RecallEvalResult["completion"]["failures"]
): string {
  return failures.length === 0
    ? ""
    : ` failures=${failures.map(renderLifecycleFailure).join(",")}`;
}
