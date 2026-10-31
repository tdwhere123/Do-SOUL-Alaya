import type { BenchSignalSeedInput, CompileSeedBatchResult } from "../../harness/daemon.js";
import { captureStatementSourceSession, statementRequestSourceContexts } from "./compile-seed-source-session.js";
import type { SeededObjectResult } from "../../harness/daemon/seed/daemon-seed-types.js";
import { isUnscoredMaterializedSeedError } from "../../harness/seeding/seed-errors.js";
import { extractSeedInputs, stringifyError } from "./compile-seed-extract.js";
import type { CompileSeedResult, CompileSeedTurnInput } from "./compile-seed-types.js";
import type { CompileSeedRunnerContext } from "./compile-seed-runner-context.js";

export async function seedCompileTurn(context: CompileSeedRunnerContext, input: CompileSeedTurnInput): Promise<CompileSeedResult> {
  const normalized = input.turnContent.trim();
  resetRoundReceipts(context);
  if (normalized.length === 0 && (input.turnMessages?.length ?? 0) === 0) return summarizeSeedTurn([]);
  const signals = await buildTurnSignalInputs(context, input, normalized);
  // Source admission below already retains raw fallback. A second source-turn capsule
  // would duplicate its native root and silently change navigation membership.
  const seeds = signals.length === 0 ? [] : await publishStatements(context, input, signals);
  return summarizeSeedTurn(seeds);
}

function resetRoundReceipts(context: CompileSeedRunnerContext): void {
  delete context.stats.lastStatementSession;
  context.stats.lastStatementResponses = [];
  context.stats.lastTurnRawSignalCount = 0;
  context.stats.lastTurnDraftCount = 0;
  context.stats.lastExtractionSource = null;
  context.stats.lastCacheKey = null;
  context.stats.lastRawJsonSha256 = null;
  context.stats.lastExtractionShards = [];
  context.stats.lastSemanticSupplementShards = [];
}

async function buildTurnSignalInputs(context: CompileSeedRunnerContext, input: CompileSeedTurnInput,
  normalized: string): Promise<BenchSignalSeedInput[]> {
  const captured = await captureStatementSourceSession(input, context.statementSourceSessions);
  const own = captured.bySeed.get(input.seedIndex)!;
  const observedAt = captured.observedAt;
  const sourceSession = input.sourceSession ?? input.turnMessages ?? [];
  const seeds = await extractSeedInputs({
    provider: context.provider, statementSessions: context.statementSessions,
    sourceSession, sourceContexts: statementRequestSourceContexts(sourceSession, captured), stats: context.stats,
    turnContent: normalized, seedIndex: input.seedIndex,
    context: { workspace_id: input.workspaceId, run_id: input.runId, surface_id: input.surfaceId ?? null,
      turn_messages: input.turnMessages ?? [], artifact_key: own.source_id, source_root_id: own.root_id,
      source_observation: { observed_at: observedAt, authority: "trusted_host_event", source_event_id: input.evidenceRefBase },
      ...(input.sourceObservedAt === undefined ? {} : { source_observed_at: input.sourceObservedAt }) },
    diagnosticDir: context.diagnosticDir, modelId: context.config.model, providerKind: "official_api"
  });
  return seeds.map((seed, index) => ({ ...seed,
    evidenceRef: seeds.length === 1 ? input.evidenceRefBase : `${input.evidenceRefBase}-f${index}`,
    ...(input.surfaceId == null ? {} : { surfaceId: input.surfaceId }),
    ...(input.sourceObservedAt === undefined ? {} : { sourceObservedAt: input.sourceObservedAt })
  }));
}

async function publishStatements(context: CompileSeedRunnerContext, input: CompileSeedTurnInput,
  signals: readonly BenchSignalSeedInput[]): Promise<readonly SeededObjectResult[]> {
  try {
    const batch = await input.daemon.proposeMemoriesFromCompileSignals(signals);
    recordStatementDrops(context, batch);
    return batch.seeds;
  } catch (error) {
    if (isUnscoredMaterializedSeedError(error)) throw error;
    context.stats.signalsDropped += signals.length;
    context.stats.signalsDroppedByReason.materialization_drop += signals.length;
    process.stderr.write(`[longmemeval compile-seed] dropped ${signals.length} statement signal(s) during publication: ${stringifyError(error)}\n`);
    return [];
  }
}

function recordStatementDrops(context: CompileSeedRunnerContext, batch: CompileSeedBatchResult): void {
  context.stats.signalsDropped += batch.dropped.length;
  for (const drop of batch.dropped) context.stats.signalsDroppedByReason[drop.reason] += 1;
}

function summarizeSeedTurn(seeds: readonly SeededObjectResult[]): CompileSeedResult {
  let turnTruncated = false, charsClipped = 0;
  for (const seed of seeds) if (seed.truncated) { turnTruncated = true; charsClipped = seed.charsClipped; }
  return { seeds, turnTruncated, charsClipped };
}
