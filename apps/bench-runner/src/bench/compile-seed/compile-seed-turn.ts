import type {
  BenchSignalSeedInput,
  CompileSeedBatchResult,
  SeededMemoryResult
} from "../../harness/daemon.js";
import type { SeededObjectResult } from
  "../../harness/daemon/seed/daemon-seed-types.js";
import { isUnscoredMaterializedSeedError } from "../../harness/seeding/seed-errors.js";
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
  resetTurnExtractionReceipts(context);
  const signalInputs = await buildTurnSignalInputs(context, input, normalized);
  const seeds =
    signalInputs[0]?.extractionProvider === "official_api_compile"
      ? await seedOfficialCompileSignals(context, input, signalInputs)
      : await seedFallbackSignals(context, input, signalInputs);
  return summarizeSeedTurn(seeds);
}

function resetTurnExtractionReceipts(context: CompileSeedRunnerContext): void {
  context.semanticSupplement?.beginTurn();
  context.stats.lastTurnRawSignalCount = 0;
  context.stats.lastTurnDraftCount = 0;
  context.stats.lastExtractionSource = null;
  context.stats.lastCacheKey = null;
  context.stats.lastRawJsonSha256 = null;
  context.stats.lastExtractionShards = [];
  context.stats.lastSemanticSupplementShards = [];
}

async function buildTurnSignalInputs(
  context: CompileSeedRunnerContext,
  input: CompileSeedTurnInput,
  normalized: string
): Promise<BenchSignalSeedInput[]> {
  const seedInputs = await extractSeedInputs({
    provider: context.provider,
    semanticSupplement: context.semanticSupplement,
    stats: context.stats,
    turnContent: normalized,
    seedIndex: input.seedIndex,
    context: {
      workspace_id: input.workspaceId,
      run_id: input.runId,
      surface_id: input.surfaceId ?? null,
      turn_messages: input.turnMessages ?? [],
      ...(input.sourceObservedAt === undefined
        ? {}
        : { source_observed_at: input.sourceObservedAt })
    },
    diagnosticDir: context.diagnosticDir,
    modelId: context.config.model,
    providerKind: "official_api"
  });
  if (
    seedInputs.length === 0 &&
    context.stats.path === "official_api_compile" &&
    sourceEvidenceFallbackEnabled(input)
  ) {
    return [buildEvidenceFallbackInput(input, normalized, "empty_extraction")];
  }
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
      : { sourceMemoryRefs: input.sourceMemoryRefs }),
    ...(input.sourceObservedAt === undefined
      ? {}
      : { sourceObservedAt: input.sourceObservedAt })
  }));
}

function buildEvidenceFallbackInput(
  input: CompileSeedTurnInput,
  turnContent: string,
  reason: NonNullable<BenchSignalSeedInput["evidenceFallbackReason"]>
): BenchSignalSeedInput {
  return {
    signalKind: "potential_evidence_anchor",
    objectKind: "source_turn",
    confidence: 1,
    distilledFact: turnContent,
    turnContent,
    evidenceRef: input.evidenceRefBase,
    turnSeedIndex: input.seedIndex,
    extractionProvider: "official_api_compile",
    evidenceFallbackReason: reason,
    ...(input.turnMessages === undefined
      ? {}
      : { turnMessages: input.turnMessages }),
    ...(input.surfaceId === undefined ? {} : { surfaceId: input.surfaceId }),
    ...(input.sourceObservedAt === undefined
      ? {}
      : { sourceObservedAt: input.sourceObservedAt })
  };
}

async function seedOfficialCompileSignals(
  context: CompileSeedRunnerContext,
  input: CompileSeedTurnInput,
  signalInputs: readonly BenchSignalSeedInput[]
): Promise<readonly SeededObjectResult[]> {
  // This projection is additional to the extraction envelope, so its failure
  // cannot enter the extracted-signal conservation ledger.
  const supplementalFallback =
    signalInputs[0]?.evidenceFallbackReason !== undefined;
  try {
    const batch: CompileSeedBatchResult =
      await input.daemon.proposeMemoriesFromCompileSignals(signalInputs);
    recordCompileSignalDrops(
      context,
      batch,
      signalInputs.length,
      !supplementalFallback
    );
    if (
      batchCreatedEvidence(batch) ||
      !sourceEvidenceFallbackEnabled(input) ||
      signalInputs.some((signal) => signal.evidenceFallbackReason !== undefined)
    ) {
      return batch.seeds;
    }
    const fallbackSeeds = await seedNoEvidenceCreatedFallback(context, input);
    return [...batch.seeds, ...fallbackSeeds];
  } catch (error) {
    if (isUnscoredMaterializedSeedError(error)) throw error;
    if (supplementalFallback) {
      process.stderr.write(
        `[longmemeval compile-seed] source evidence fallback dropped: ` +
          `${stringifyError(error)}\n`
      );
      return [];
    }
    context.stats.signalsDropped += signalInputs.length;
    context.stats.signalsDroppedByReason.materialization_drop +=
      signalInputs.length;
    process.stderr.write(
      `[longmemeval compile-seed] dropped ${signalInputs.length} signal(s) ` +
        `during compile seed: ${stringifyError(error)}\n`
    );
    return [];
  }
}

async function seedNoEvidenceCreatedFallback(
  context: CompileSeedRunnerContext,
  input: CompileSeedTurnInput
): Promise<readonly SeededObjectResult[]> {
  const fallbackInput = buildEvidenceFallbackInput(
    input,
    input.turnContent.trim(),
    "no_evidence_created"
  );
  try {
    const batch = await input.daemon.proposeMemoriesFromCompileSignals([
      fallbackInput
    ]);
    recordCompileSignalDrops(context, batch, 1, false);
    return batch.seeds;
  } catch (error) {
    if (isUnscoredMaterializedSeedError(error)) throw error;
    process.stderr.write(
      `[longmemeval compile-seed] source evidence fallback dropped: ` +
        `${stringifyError(error)}\n`
    );
    return [];
  }
}

function sourceEvidenceFallbackEnabled(input: CompileSeedTurnInput): boolean {
  return input.sourceEvidenceFallback === "trusted_source_turn";
}

function batchCreatedEvidence(batch: CompileSeedBatchResult): boolean {
  return batch.createdEvidence;
}

function recordCompileSignalDrops(
  context: CompileSeedRunnerContext,
  batch: CompileSeedBatchResult,
  signalCount: number,
  countsTowardExtractionConservation: boolean
): void {
  if (batch.dropped.length === 0) return;
  if (countsTowardExtractionConservation) {
    context.stats.signalsDropped += batch.dropped.length;
    for (const drop of batch.dropped) {
      context.stats.signalsDroppedByReason[drop.reason] += 1;
    }
  }
  process.stderr.write(
    `[longmemeval compile-seed] ${countsTowardExtractionConservation
      ? `${batch.dropped.length} signal(s) of ${signalCount}`
      : "source evidence fallback"} did not materialize a memory_entry ` +
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
      context.stats.signalsDroppedByReason.materialization_drop += 1;
      process.stderr.write(
        `[longmemeval compile-seed] dropped one signal during seed: ${stringifyError(error)}\n`
      );
    }
  }
  return seeds;
}

function summarizeSeedTurn(seeds: readonly SeededObjectResult[]): CompileSeedResult {
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
