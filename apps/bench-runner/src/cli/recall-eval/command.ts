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
    ...(expansionCapability === undefined ? {} : { expansionCapability })
  };
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
    (opts.legacySnapshot ? " mode=legacy-v1-old-cache diagnostic_only=true" : "") +
    (opts.offset !== undefined ? ` offset=${opts.offset}` : "") +
    (opts.limit !== undefined ? ` limit=${opts.limit}` : "") +
    ` policy_shape=${opts.policyShape}` +
    (opts.weightOverridesJson !== undefined ? " weights=cli" : "") + "...\n";
}

function renderResult(result: RecallEvalResult, legacy: boolean): string {
  const kpi = result.payload.kpi;
  const coverage = kpi.full_gold_coverage;
  return `Done. Slug: ${result.slug}\n` +
    (legacy ? "  substrate=legacy-v1-old-cache measurement=diagnostic-only\n" : "") +
    `  R@1=${pct(kpi.r_at_1)} R@5=${pct(kpi.r_at_5)} R@10=${pct(kpi.r_at_10)}\n` +
    (coverage === undefined ? "" :
      `  full-gold@5=${pct(coverage.full_gold_at_5)} cov@5=${pct(coverage.gold_coverage_at_5)} ` +
      `pool@50=${pct(coverage.pool_recall_at_50)} pool@100=${pct(coverage.pool_recall_at_100)}\n`) +
    `  latency p50=${kpi.latency_ms_p50}ms p95=${kpi.latency_ms_p95}ms\n` +
    `  KPI: ${result.kpiPath}\n`;
}
