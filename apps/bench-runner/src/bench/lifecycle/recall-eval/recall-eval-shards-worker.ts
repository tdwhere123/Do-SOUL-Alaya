import type { LongMemEvalVariant } from "../../../longmemeval/ingestion/dataset.js";
import {
  buildCredentiallessLongMemEvalWorkerEnv,
  buildLongMemEvalWorkerEnvOverrides,
  freezeProcessEnvForWorkers,
  runSupervisedWorkerGroup,
  spawnLongMemEvalWorkerProcess,
  shardHasMergeableKpi,
  type LongMemEvalWorkerShardPlan,
  type LongMemEvalWorkerSpawner
} from "../../../longmemeval/runner/runner-concurrency-worker.js";
import type { RecallEvalOptions } from "./recall-eval-contract.js";
import {
  REQUIRE_SLICE_REUSE_ENV,
  SEALED_SLICE_RESTORE_ENV
} from "../../snapshot/recall-eval/workspace-slice/names.js";

export type { LongMemEvalWorkerShardPlan, LongMemEvalWorkerSpawner };
export { runSupervisedWorkerGroup, spawnLongMemEvalWorkerProcess, shardHasMergeableKpi };

export function buildRecallEvalWorkerCliArgs(
  opts: RecallEvalOptions,
  plan: LongMemEvalWorkerShardPlan
): string[] {
  const args = [
    "recall-eval",
    "--snapshot", opts.snapshotDbPath,
    "--variant", variantToCliFlag(opts.variant),
    "--offset", String(plan.offset),
    "--limit", String(plan.limit),
    "--policy-shape", opts.policyShape ?? "stress",
    "--simulate-report", opts.simulateReport ?? "none",
    "--history-root", plan.historyRoot
  ];
  pushOptionalArg(args, "--weights", opts.weightOverridesJson);
  pushOptionalArg(args, "--data-dir", opts.dataDir);
  pushOptionalArg(args, "--pinned-meta-root", opts.pinnedMetaRoot);
  pushFlag(args, "--experiment", opts.experiment);
  pushFlag(args, "--rebuild-evidence-search-projections", opts.derivedEvidenceProjectionRebuild);
  pushFlag(
    args,
    "--backfill-missing-fact-frame-formations",
    opts.backfillMissingFactFrameFormations
  );
  pushOptionalArg(args, "--warm-derived-snapshot-receipt", opts.warmDerivedSnapshotReceiptPath);
  pushOptionalArg(args, "--embedding-cache-overlay", opts.embeddingCacheOverlayReceiptPath);
  pushOptionalArg(args, "--query-semantic-factor-cache", opts.querySemanticFactorCachePath);
  pushOptionalArg(args, "--seed-extraction-system-prompt", opts.seedExtractionSystemPromptPath);
  pushOptionalArg(args, "--fact-frame-retrofit-ledger", opts.factFrameRetrofitLedgerPath);
  return args;
}

export function buildRecallEvalWorkerEnv(input: {
  readonly concurrency: number;
  readonly embeddingMode: NonNullable<RecallEvalOptions["embeddingMode"]>;
  readonly shardRoot: string;
  readonly historyRoot: string;
}): NodeJS.ProcessEnv {
  return freezeProcessEnvForWorkers(
    buildCredentiallessLongMemEvalWorkerEnv(process.env, {
      ...buildLongMemEvalWorkerEnvOverrides({
        concurrency: input.concurrency,
        embeddingMode: input.embeddingMode,
        shardRoot: input.shardRoot,
        historyRoot: input.historyRoot
      }),
      ALAYA_RECALL_EVAL_EMBEDDING: input.embeddingMode,
      [SEALED_SLICE_RESTORE_ENV]: "1",
      [REQUIRE_SLICE_REUSE_ENV]: "1"
    })
  );
}

function pushOptionalArg(args: string[], name: string, value: string | undefined): void {
  if (value !== undefined) args.push(name, value);
}

function pushFlag(args: string[], name: string, enabled: boolean | undefined): void {
  if (enabled === true) args.push(name);
}

function variantToCliFlag(variant: LongMemEvalVariant): string {
  const map: Record<LongMemEvalVariant, string> = {
    longmemeval_oracle: "oracle",
    longmemeval_s: "s",
    longmemeval_m: "m"
  };
  return map[variant];
}
