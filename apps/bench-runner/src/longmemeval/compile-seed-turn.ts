import type {
  BenchSignalSeedInput,
  CompileSeedBatchResult,
  SeededMemoryResult
} from "../harness/daemon.js";
import { isUnscoredMaterializedSeedError } from "../harness/seed-errors.js";
import {
  extractSeedInputs,
  stringifyError
} from "./compile-seed-extract.js";
import type {
  CompileSeedResult,
  CompileSeedTurnInput
} from "./compile-seed-types.js";
import type { CompileSeedRunnerContext } from "./compile-seed-runner-context.js";

export async function seedCompileTurn(
  context: CompileSeedRunnerContext,
  input: CompileSeedTurnInput
): Promise<CompileSeedResult> {
  const normalized = input.turnContent.trim();
  if (normalized.length === 0) {
    return { seeds: [], turnTruncated: false, charsClipped: 0 };
  }
  const signalInputs = await buildTurnSignalInputs(context, input, normalized);
  const seeds =
    signalInputs[0]?.extractionProvider === "official_api_compile"
      ? await seedOfficialCompileSignals(context, input, signalInputs)
      : await seedFallbackSignals(context, input, signalInputs);
  return summarizeSeedTurn(seeds);
}

async function buildTurnSignalInputs(
  context: CompileSeedRunnerContext,
  input: CompileSeedTurnInput,
  normalized: string
): Promise<BenchSignalSeedInput[]> {
  const seedInputs = await extractSeedInputs({
    provider: context.provider,
    stats: context.stats,
    turnContent: normalized,
    seedIndex: input.seedIndex,
    context: {
      workspace_id: input.workspaceId,
      run_id: input.runId,
      surface_id: input.surfaceId ?? null,
      turn_messages: []
    },
    diagnosticDir: context.diagnosticDir,
    modelId: context.config.model,
    providerKind: "official_api"
  });
  return seedInputs.map((seedInput, index) => ({
    ...seedInput,
    evidenceRef:
      seedInputs.length === 1
        ? input.evidenceRefBase
        : `${input.evidenceRefBase}-f${index}`,
    ...(input.surfaceId === undefined || input.surfaceId === null
      ? {}
      : { surfaceId: input.surfaceId }),
    ...(input.sourceMemoryRefs === undefined || input.sourceMemoryRefs.length === 0
      ? {}
      : { sourceMemoryRefs: input.sourceMemoryRefs })
  }));
}

async function seedOfficialCompileSignals(
  context: CompileSeedRunnerContext,
  input: CompileSeedTurnInput,
  signalInputs: readonly BenchSignalSeedInput[]
): Promise<readonly SeededMemoryResult[]> {
  try {
    const batch: CompileSeedBatchResult =
      await input.daemon.proposeMemoriesFromCompileSignals(signalInputs);
    recordCompileSignalDrops(context, batch, signalInputs.length);
    return batch.seeds;
  } catch (error) {
    if (isUnscoredMaterializedSeedError(error)) throw error;
    context.stats.signalsDropped += signalInputs.length;
    context.stats.signalsDroppedByReason.materialization_error +=
      signalInputs.length;
    process.stderr.write(
      `[longmemeval compile-seed] dropped ${signalInputs.length} signal(s) ` +
        `during compile seed: ${stringifyError(error)}\n`
    );
    return [];
  }
}

function recordCompileSignalDrops(
  context: CompileSeedRunnerContext,
  batch: CompileSeedBatchResult,
  signalCount: number
): void {
  if (batch.dropped.length === 0) return;
  context.stats.signalsDropped += batch.dropped.length;
  for (const drop of batch.dropped) {
    context.stats.signalsDroppedByReason[drop.reason] += 1;
  }
  process.stderr.write(
    `[longmemeval compile-seed] ${batch.dropped.length} signal(s) of ` +
      `${signalCount} did not materialize a memory_entry ` +
      `(${formatDropBreakdown(batch)}); the round's other facts seeded normally\n`
  );
}

function formatDropBreakdown(batch: CompileSeedBatchResult): string {
  const byReason = batch.dropped.reduce<Record<string, number>>((acc, drop) => {
    acc[drop.reason] = (acc[drop.reason] ?? 0) + 1;
    return acc;
  }, {});
  return Object.entries(byReason)
    .map(([reason, count]) => `${reason}=${count}`)
    .join(" ");
}

async function seedFallbackSignals(
  context: CompileSeedRunnerContext,
  input: CompileSeedTurnInput,
  signalInputs: readonly BenchSignalSeedInput[]
): Promise<readonly SeededMemoryResult[]> {
  const seeds: SeededMemoryResult[] = [];
  for (const signalInput of signalInputs) {
    try {
      seeds.push(await input.daemon.proposeMemoryFromSignal(signalInput));
    } catch (error) {
      if (isUnscoredMaterializedSeedError(error)) throw error;
      context.stats.signalsDropped += 1;
      process.stderr.write(
        `[longmemeval compile-seed] dropped one signal during seed: ${stringifyError(error)}\n`
      );
    }
  }
  return seeds;
}

function summarizeSeedTurn(seeds: readonly SeededMemoryResult[]): CompileSeedResult {
  let turnTruncated = false;
  let charsClipped = 0;
  for (const seed of seeds) {
    if (seed.truncated) {
      turnTruncated = true;
      charsClipped = seed.charsClipped;
    }
  }
  return { seeds, turnTruncated, charsClipped };
}
