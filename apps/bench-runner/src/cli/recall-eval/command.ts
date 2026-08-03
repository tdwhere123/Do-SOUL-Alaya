import process from "node:process";
import {
  runRecallEval,
  type RecallEvalOptions,
  type RecallEvalResult
} from "../../longmemeval/lifecycle/recall-eval/recall-eval-impl.js";
import type { ParsedFlags } from "../cli-options.js";
import { exitCodeForReleaseHardGates } from "../release-hard-gate-exit.js";
import { pct } from "../result-format.js";
import { verifyLongMemEvalExpansionContractInput } from
  "../promotion/expansion-input.js";

export async function runRecallEvalCommand(opts: ParsedFlags): Promise<number> {
  if (opts.snapshot === undefined) {
    process.stderr.write("alaya-bench-runner recall-eval: --snapshot <db> required\n");
    return 2;
  }
  try {
    assertLegacyFlags(opts);
    assertExperimentFlags(opts);
    const expansionCapability = opts.promotionContract === undefined
      ? undefined
      : await verifyLongMemEvalExpansionContractInput(opts.promotionContract);
    process.stdout.write(renderStart(opts));
    const result = await runRecallEval(buildRecallEvalOptions(
      opts, opts.snapshot, expansionCapability
    ));
    process.stdout.write(renderResult(result, opts.legacySnapshot));
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
  snapshot: string,
  expansionCapability?: Awaited<ReturnType<
    typeof verifyLongMemEvalExpansionContractInput
  >>
): RecallEvalOptions {
  return {
    snapshotDbPath: snapshot, variant: opts.variant,
    historyRoot: opts.historyRoot, policyShape: opts.policyShape,
    simulateReport: opts.simulateReport, legacySnapshot: opts.legacySnapshot,
    ...(opts.limit === undefined ? {} : { limit: opts.limit }),
    ...(opts.offset === undefined ? {} : { offset: opts.offset }),
    ...(opts.weightOverridesJson === undefined ? {} : { weightOverridesJson: opts.weightOverridesJson }),
    ...(opts.dataDir === undefined ? {} : { dataDir: opts.dataDir }),
    ...(opts.dataDirRoot === undefined ? {} : { dataDirRoot: opts.dataDirRoot }),
    ...(opts.pinnedMetaRoot === undefined ? {} : { pinnedMetaRoot: opts.pinnedMetaRoot }),
    ...(opts.legacyManifestSha256 === undefined ? {} : { legacyManifestSha256: opts.legacyManifestSha256 }),
    ...(opts.legacyDatasetSha256 === undefined ? {} : { legacyDatasetSha256: opts.legacyDatasetSha256 }),
    ...(opts.experiment === true ? { experiment: true } : {}),
    ...(opts.rebuildEvidenceSearchProjections === true
      ? { derivedEvidenceProjectionRebuild: true }
      : {}),
    ...(opts.factFrameRetrofitLedger === undefined
      ? {}
      : { factFrameRetrofitLedgerPath: opts.factFrameRetrofitLedger }),
    ...(opts.seedExtractionSystemPrompt === undefined
      ? {}
      : { seedExtractionSystemPromptPath: opts.seedExtractionSystemPrompt }),
    ...(expansionCapability === undefined ? {} : { expansionCapability })
  };
}

function assertExperimentFlags(opts: ParsedFlags): void {
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
  if (opts.rebuildEvidenceSearchProjections === true && opts.experiment !== true) {
    throw new Error(
      "--rebuild-evidence-search-projections requires --experiment"
    );
  }
  if (opts.experiment !== true) return;
  if (opts.legacySnapshot || opts.promotionContract !== undefined) {
    throw new Error("--experiment cannot be combined with legacy or promotion inputs");
  }
}

function assertLegacyFlags(opts: ParsedFlags): void {
  if (!opts.legacySnapshot) {
    if (opts.legacyManifestSha256 !== undefined || opts.legacyDatasetSha256 !== undefined) {
      throw new Error("legacy SHA-256 flags require --legacy-snapshot");
    }
    return;
  }
  if (opts.dataDir === undefined || opts.legacyManifestSha256 === undefined ||
      opts.legacyDatasetSha256 === undefined) {
    throw new Error(
      "--legacy-snapshot requires --data-dir, --legacy-manifest-sha256, and --legacy-dataset-sha256"
    );
  }
}

function renderStart(opts: ParsedFlags): string {
  return `Running recall-eval against snapshot ${opts.snapshot}` +
    (opts.experiment === true ? " mode=experiment" : "") +
    (opts.rebuildEvidenceSearchProjections === true
      ? " derived_projection_rebuild=true promotable=false"
      : "") +
    (opts.factFrameRetrofitLedger === undefined ? "" : " fact_frame_retrofit=true") +
    (opts.seedExtractionSystemPrompt === undefined ? "" : " historical_prompt=true") +
    (opts.legacySnapshot ? " mode=legacy-v1-old-cache diagnostic_only=true" : "") +
    (opts.offset !== undefined ? ` offset=${opts.offset}` : "") +
    (opts.limit !== undefined ? ` limit=${opts.limit}` : "") +
    ` policy_shape=${opts.policyShape}` +
    (opts.weightOverridesJson !== undefined ? " weights=cli" : "") + "...\n";
}

function renderResult(result: RecallEvalResult, legacy: boolean): string {
  const kpi = result.payload.kpi;
  const coverage = kpi.full_gold_coverage;
  const rebuild = result.derivedEvidenceProjectionRebuild;
  return `Done. Slug: ${result.slug}\n` +
    (legacy ? "  substrate=legacy-v1-old-cache measurement=diagnostic-only\n" : "") +
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
    `  KPI: ${result.kpiPath}\n`;
}
