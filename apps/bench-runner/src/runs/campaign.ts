import type { BenchDaemonHandle, BenchEmbeddingMode } from "../harness/daemon.js";
import { startBenchDaemon } from "../harness/daemon.js";
import { resolveBenchEmbeddingProviderLabel } from "../datasets/longmemeval/runner/runner-helpers.js";
import {
  resolveBenchCommitSha7,
  resolveBenchRunnerVersion
} from "../shared/version.js";
import { writeBenchArchive } from "./archive.js";
import { createCampaignSeedRunner } from "./seed.js";
import type {
  BenchCampaignAdapter,
  BenchPreparedCampaign,
  BenchRunOptions,
  BenchRunResult
} from "./types.js";
import { selectOffsetLimitWindow } from "./window.js";

export async function runBenchCampaign<
  TOpts extends BenchRunOptions,
  TUnit,
  TAggregate
>(
  adapter: BenchCampaignAdapter<TOpts, TUnit, TAggregate>,
  opts: TOpts
): Promise<BenchRunResult> {
  const prepared = await prepareBenchCampaign(adapter, opts);
  const aggregate = await adapter.runWindow({
    window: prepared.window,
    opts,
    embeddingMode: prepared.embeddingMode,
    seedRunner: prepared.seedRunner
  });
  adapter.logExtractionStats?.(prepared.seedRunner.stats);
  const built = adapter.buildPayload({
    opts,
    dataset: prepared.dataset,
    window: prepared.window,
    aggregate,
    runAt: prepared.runAt,
    alayaVersion: prepared.alayaVersion,
    commitSha7: prepared.commitSha7,
    embeddingProvider: prepared.embeddingProvider,
    embeddingMode: prepared.embeddingMode,
    extractionStats: prepared.seedRunner.stats
  });
  return writeBenchArchive({
    identity: adapter.identity,
    historyRoot: opts.historyRoot,
    runAt: prepared.runAt,
    commitSha7: prepared.commitSha7,
    payload: built.payload,
    diagnosticsPayload: built.diagnosticsPayload
  });
}

export async function prepareBenchCampaign<
  TOpts extends BenchRunOptions,
  TUnit,
  TAggregate
>(
  adapter: BenchCampaignAdapter<TOpts, TUnit, TAggregate>,
  opts: TOpts
): Promise<BenchPreparedCampaign<TUnit>> {
  const dataset = await adapter.loadDataset(opts);
  const window = selectOffsetLimitWindow(dataset, opts);
  const embeddingMode = opts.embeddingMode ?? "disabled";
  return {
    dataset,
    window,
    alayaVersion: resolveBenchRunnerVersion(),
    commitSha7: resolveBenchCommitSha7(),
    runAt: new Date(),
    embeddingMode,
    embeddingProvider: resolveBenchEmbeddingProviderLabel(
      embeddingMode,
      process.env,
      opts.embeddingProviderKind
    ),
    seedRunner: resolveCampaignSeedRunner(adapter, window, opts)
  };
}

export async function startCampaignDaemon(input: {
  readonly runLabel: string;
  readonly embeddingMode: BenchEmbeddingMode;
  readonly embeddingProviderKind?: BenchRunOptions["embeddingProviderKind"];
}): Promise<BenchDaemonHandle> {
  const benchRunId = `${input.runLabel}-bench-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return await startBenchDaemon({
    workspaceId: `${benchRunId}-default`,
    runId: `${benchRunId}-default-run`,
    embeddingMode: input.embeddingMode,
    ...(input.embeddingProviderKind === undefined
      ? {}
      : { embeddingProviderKind: input.embeddingProviderKind })
  });
}

function resolveCampaignSeedRunner<
  TOpts extends BenchRunOptions,
  TUnit,
  TAggregate
>(
  adapter: BenchCampaignAdapter<TOpts, TUnit, TAggregate>,
  window: readonly TUnit[],
  opts: TOpts
) {
  const offset = Math.max(0, opts.offset ?? 0);
  const requiredTurnContents = adapter.collectRequiredTurnContents(window);
  return adapter.createSeedRunner?.({
    window,
    offset,
    requiredTurnContents
  }) ?? createCampaignSeedRunner({
    requiredTurnContents,
    offset,
    windowLength: window.length
  });
}
