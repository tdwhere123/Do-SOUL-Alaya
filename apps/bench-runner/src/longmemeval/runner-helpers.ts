import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RECALL_PIPELINE_VERSION,
  resolveBenchCommitSha7,
  resolveBenchRunnerVersion
} from "../shared/version.js";
import {
  monotonicElapsedMs,
  monotonicNowNs
} from "../shared/monotonic.js";
import {
  MemoryGraphEdgeType,
  mapRelationKindToGraphEdgeType
} from "@do-soul/alaya-protocol";
import type {
  BenchPolicyShape,
  BenchSimulateReportMode
} from "@do-soul/alaya-eval";
import type {
  BenchDaemonHandle,
  BenchEmbeddingMode,
  BenchEmbeddingProviderKind,
  BenchEmbeddingWarmupSummary,
  BenchQueryEmbeddingWarmupSummary,
  BenchRecallOptions,
  BenchReportContextUsageInput
} from "../harness/daemon.js";
import {
  BENCH_DAEMON_DB_FILENAME,
  RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION,
  checkpointAndCopyBenchDb,
  readSchemaMigrationVersion,
  writeSnapshotManifest,
  writeSnapshotSidecar,
  type LongMemEvalSnapshotQuestion,
  type SnapshotExtractionProvenance
} from "./snapshot.js";
import { readExtractionCacheManifest } from "./extraction-cache-manifest.js";
import {
  scoreAbstentionQuestion
} from "./abstention.js";
import type {
  LongMemEvalEmbeddingVectorCacheSummary,
  LongMemEvalQueryEmbeddingCacheSummary,
  LongMemEvalReportSideEffectSnapshot
} from "./diagnostics.js";
import type { LongMemEvalVariant } from "./dataset.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BENCH_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_LOCAL_ONNX_EMBEDDING_MODEL =
  "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
const PINNED_META_ROOT = resolve(
  __dirname,
  "../../../../docs/bench-history/datasets"
);

export interface LongMemEvalSidecarEntry {
  readonly objectId: string;
  readonly objectKind: "memory_entry" | "synthesis_capsule";
  readonly sessionId: string;
  readonly hasAnswer: boolean;
  readonly content?: string;
}

export interface LongMemEvalHitScoringInput {
  readonly results: readonly {
    readonly object_id: string;
    readonly object_kind?: string;
    readonly relevance_score: number;
  }[];
  readonly sidecar: ReadonlyMap<string, LongMemEvalSidecarEntry>;
  readonly answerSessionIds: ReadonlySet<string>;
}

export interface LongMemEvalHitScoringResult {
  readonly hitAt1: boolean;
  readonly hitAt5: boolean;
  readonly hitAt10: boolean;
  readonly firstTier: "hot" | "warm" | "cold";
}

export interface LongMemEvalReportSimulationStats {
  readonly reportsAttempted: number;
  readonly reportsUsed: number;
  readonly reportsSkipped: number;
  readonly usedObjectCount: number;
}

export type LongMemEvalBenchRecallResult = Awaited<
  ReturnType<BenchDaemonHandle["recall"]>
>;

export interface LongMemEvalRecallCycleResult {
  readonly scoredRecallResult: LongMemEvalBenchRecallResult;
  readonly scoredRecallLatencyMs: number;
  readonly reportUsageStats: LongMemEvalReportSimulationStats;
}

export async function runLongMemEvalRecallCycle(input: {
  readonly daemon: Pick<BenchDaemonHandle, "recall" | "reportContextUsage">;
  readonly query: string;
  readonly recallOptions: BenchRecallOptions;
  readonly simulateReport: BenchSimulateReportMode;
  readonly goldMemoryIds: readonly string[];
  readonly turnIndex: number;
  readonly questionText: string;
}): Promise<LongMemEvalRecallCycleResult> {
  if (input.simulateReport === "none") {
    const recallStart = monotonicNowNs();
    const scoredRecallResult = await input.daemon.recall(
      input.query,
      input.recallOptions
    );
    return {
      scoredRecallResult,
      scoredRecallLatencyMs: monotonicElapsedMs(recallStart),
      reportUsageStats: {
        reportsAttempted: 0,
        reportsUsed: 0,
        reportsSkipped: 0,
        usedObjectCount: 0
      }
    };
  }

  const preReportRecallResult = await input.daemon.recall(
    input.query,
    input.recallOptions
  );
  const reportUsage = buildLongMemEvalReportContextUsage({
    simulateReport: input.simulateReport,
    deliveryId: preReportRecallResult.delivery_id,
    results: preReportRecallResult.results,
    goldMemoryIds: input.goldMemoryIds,
    turnIndex: input.turnIndex,
    questionText: input.questionText
  });
  if (reportUsage.reportInput !== null) {
    await input.daemon.reportContextUsage(reportUsage.reportInput);
  }

  const recallStart = monotonicNowNs();
  const scoredRecallResult = await input.daemon.recall(
    input.query,
    input.recallOptions
  );
  return {
    scoredRecallResult,
    scoredRecallLatencyMs: monotonicElapsedMs(recallStart),
    reportUsageStats: reportUsage.stats
  };
}

export async function readLongMemEvalReportSideEffectSnapshot(
  questionId: string,
  daemon: Pick<BenchDaemonHandle, "runtime">,
  workspaceId: string
): Promise<LongMemEvalReportSideEffectSnapshot> {
  const status = await daemon.runtime.services.graphHealthService.getStatus(
    workspaceId
  );
  const byKind: Record<string, number> = Object.fromEntries(
    Object.values(MemoryGraphEdgeType).map((edgeType) => [edgeType, 0])
  );
  for (const [kind, count] of Object.entries(status.path_relations_by_kind)) {
    const edgeType = mapRelationKindToGraphEdgeType(kind);
    byKind[edgeType] = (byKind[edgeType] ?? 0) + count;
  }
  return {
    question_id: questionId,
    workspace_id: status.workspace_id,
    memory_graph_edges_total: status.path_relations_total,
    memory_graph_edges_by_type: byKind,
    recalls_edge_count: byKind.recalls ?? 0,
    path_relations_total: status.path_relations_total,
    latest_path_event_at: status.latest_path_event_at,
    warnings: status.warnings
  };
}

export function buildLongMemEvalReportContextUsage(input: {
  readonly simulateReport: BenchSimulateReportMode;
  readonly deliveryId: string;
  readonly results: readonly {
    readonly object_id: string;
    readonly object_kind?: string;
  }[];
  readonly goldMemoryIds: readonly string[];
  readonly turnIndex: number;
  readonly questionText: string;
}): {
  readonly reportInput: BenchReportContextUsageInput | null;
  readonly stats: LongMemEvalReportSimulationStats;
} {
  if (input.simulateReport === "none") {
    return {
      reportInput: null,
      stats: {
        reportsAttempted: 0,
        reportsUsed: 0,
        reportsSkipped: 0,
        usedObjectCount: 0
      }
    };
  }

  const deliveredResults = input.results.slice(0, 10);
  const deliveredMemoryResults = deliveredResults.filter(isLongMemEvalGoldEligibleResult);
  const deliveredMemoryIds = new Set(
    deliveredMemoryResults.map((result) => result.object_id)
  );
  const goldIds = new Set(input.goldMemoryIds);
  const deliveredGoldIds = deliveredMemoryResults
    .map((result) => result.object_id)
    .filter((objectId) => goldIds.has(objectId));

  let usedObjectIds: string[] = [];
  if (input.simulateReport === "gold-only") {
    usedObjectIds = deliveredGoldIds;
  } else if (input.simulateReport === "mixed") {
    if (deliveredGoldIds.length > 0) {
      const firstNonGold = deliveredMemoryResults.find(
        (result) => !goldIds.has(result.object_id)
      );
      usedObjectIds =
        firstNonGold === undefined
          ? deliveredGoldIds
          : [...deliveredGoldIds, firstNonGold.object_id];
    } else {
      usedObjectIds =
        deliveredMemoryResults[0] === undefined
          ? []
          : [deliveredMemoryResults[0].object_id];
    }
  } else if (input.simulateReport === "always-used") {
    usedObjectIds =
      deliveredMemoryResults[0] === undefined
        ? []
        : [deliveredMemoryResults[0].object_id];
  }

  const safeUsedObjectIds = usedObjectIds.filter((objectId) =>
    deliveredMemoryIds.has(objectId)
  );
  const usedSet = new Set(safeUsedObjectIds);
  const usageState = safeUsedObjectIds.length > 0 ? "used" : "skipped";
  const reportInput: BenchReportContextUsageInput = {
    deliveryId: input.deliveryId,
    usageState,
    ...(safeUsedObjectIds.length === 0
      ? {}
      : { usedObjectIds: safeUsedObjectIds }),
    deliveredObjects: deliveredResults.map((result) => ({
      objectId: result.object_id,
      objectKind: result.object_kind ?? "memory_entry",
      usageStatus:
        isLongMemEvalGoldEligibleResult(result) &&
        usedSet.has(result.object_id)
          ? "used"
          : "skipped"
    })),
    turnIndex: input.turnIndex,
    turnDigest: {
      lastMessages: [
        {
          role: "user",
          contentExcerpt: truncateExcerpt(input.questionText)
        }
      ]
    },
    reason:
      usageState === "used"
        ? `LongMemEval simulate_report=${input.simulateReport}: reported delivered object usage.`
        : `LongMemEval simulate_report=${input.simulateReport}: no delivered object selected.`
  };

  return {
    reportInput,
    stats: {
      reportsAttempted: 1,
      reportsUsed: usageState === "used" ? 1 : 0,
      reportsSkipped: usageState === "skipped" ? 1 : 0,
      usedObjectCount: safeUsedObjectIds.length
    }
  };
}

export function resolveBenchEmbeddingProviderLabel(
  embeddingMode: BenchEmbeddingMode,
  env: Readonly<Record<string, string | undefined>> = process.env,
  providerKind: BenchEmbeddingProviderKind = "openai"
): string {
  if (embeddingMode === "disabled") {
    return "none";
  }

  if (providerKind === "local_onnx") {
    const localModel =
      env.ALAYA_LOCAL_EMBEDDING_MODEL?.trim() ||
      DEFAULT_LOCAL_ONNX_EMBEDDING_MODEL;
    return `local_onnx:${localModel}`;
  }

  const model =
    env.OPENAI_EMBEDDING_MODEL?.trim() || DEFAULT_BENCH_EMBEDDING_MODEL;
  const providerUrl = env.OPENAI_EMBEDDING_PROVIDER_URL?.trim();
  if (providerUrl === undefined || providerUrl.length === 0) {
    return `openai:${model}`;
  }

  return `${labelEmbeddingProviderUrl(providerUrl)}:${model}`;
}

function labelEmbeddingProviderUrl(providerUrl: string): string {
  try {
    const hostname = new URL(providerUrl).hostname.toLowerCase();
    if (hostname.includes("yunwu")) {
      return "yunwu";
    }
  } catch {
    return "openai-compatible";
  }

  return "openai-compatible";
}

export function recallOptionsForPolicyShape(
  policyShape: BenchPolicyShape
): { readonly maxResults: 10; readonly conflictAwareness: boolean } {
  return {
    maxResults: 10,
    conflictAwareness: policyShape === "stress"
  };
}

export function writeRecallEvalSnapshot(input: {
  readonly snapshotOut: string;
  readonly seedDataDirRoot: string;
  readonly variant: LongMemEvalVariant;
  readonly commitSha7: string;
  readonly snapshotQuestions: readonly LongMemEvalSnapshotQuestion[];
  readonly extractionCacheRoot: string;
}): void {
  const liveDbPath = resolve(input.seedDataDirRoot, BENCH_DAEMON_DB_FILENAME);
  const schemaMigrationVersion = readSchemaMigrationVersion(liveDbPath);
  checkpointAndCopyBenchDb(liveDbPath, input.snapshotOut);

  const extractionManifest = readExtractionCacheManifest(input.extractionCacheRoot);
  const extractionProvenance: SnapshotExtractionProvenance | null =
    extractionManifest === undefined
      ? null
      : {
          extraction_model: extractionManifest.extraction_model,
          provider_url: extractionManifest.provider_url,
          system_prompt_sha256: extractionManifest.system_prompt_sha256,
          dataset: extractionManifest.dataset,
          dataset_revision: extractionManifest.dataset_revision,
          ...(extractionManifest.coverage === undefined
            ? {}
            : { coverage: extractionManifest.coverage }),
          ...(extractionManifest.cached_turns === undefined
            ? {}
            : { cached_turns: extractionManifest.cached_turns }),
          ...(extractionManifest.requested_turns === undefined
            ? {}
            : { requested_turns: extractionManifest.requested_turns })
        };

  writeSnapshotSidecar(input.snapshotOut, {
    schema_version: RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION,
    variant: input.variant,
    questions: input.snapshotQuestions
  });
  writeSnapshotManifest(input.snapshotOut, {
    schema_version: RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION,
    variant: input.variant,
    question_count: input.snapshotQuestions.length,
    recall_pipeline_version: RECALL_PIPELINE_VERSION,
    schema_migration_version: schemaMigrationVersion,
    bench_runner_version: resolveBenchRunnerVersion(),
    alaya_commit: input.commitSha7,
    db_filename: basename(input.snapshotOut),
    sidecar_filename: `${basename(input.snapshotOut)}.sidecar.json`,
    built_at: new Date().toISOString(),
    extraction_provenance: extractionProvenance
  });
}

export function resolveLongMemEvalHitVerdict(
  input: LongMemEvalHitScoringInput & { readonly isAbstention: boolean }
): LongMemEvalHitScoringResult {
  if (!input.isAbstention) {
    return scoreLongMemEvalRecallHits(input);
  }
  const abstention = scoreAbstentionQuestion({ results: input.results });
  const firstResult = input.results[0];
  return {
    hitAt1: abstention.correctAt1,
    hitAt5: abstention.correctAt5,
    hitAt10: abstention.correctAt10,
    firstTier:
      firstResult === undefined ? "cold" : inferTier(firstResult.relevance_score)
  };
}

export function scoreLongMemEvalRecallHits(
  input: LongMemEvalHitScoringInput
): LongMemEvalHitScoringResult {
  let hitAt1 = false;
  let hitAt5 = false;
  let hitAt10 = false;
  let firstTier: "hot" | "warm" | "cold" = "cold";

  for (let rank = 0; rank < input.results.length && rank < 10; rank++) {
    const pointer = input.results[rank];
    if (pointer === undefined) continue;
    if (rank === 0) {
      firstTier = inferTier(pointer.relevance_score);
    }
    if (!isLongMemEvalGoldEligibleResult(pointer)) {
      continue;
    }
    const meta = input.sidecar.get(
      buildLongMemEvalSidecarKey("memory_entry", pointer.object_id)
    );
    const isHit =
      meta !== undefined &&
      meta.hasAnswer &&
      input.answerSessionIds.has(meta.sessionId);
    if (isHit) {
      if (rank === 0) hitAt1 = true;
      if (rank < 5) hitAt5 = true;
      hitAt10 = true;
    }
  }

  return { hitAt1, hitAt5, hitAt10, firstTier };
}

function isLongMemEvalGoldEligibleResult(result: Readonly<{
  readonly object_kind?: string | null;
}>): boolean {
  return (result.object_kind ?? "memory_entry") === "memory_entry";
}

export function buildLongMemEvalSidecarKey(
  objectKind: LongMemEvalSidecarEntry["objectKind"],
  objectId: string
): string {
  return `${objectKind}:${objectId}`;
}

export function deriveLongMemEvalGoldMemoryIds(
  sidecar: ReadonlyMap<string, LongMemEvalSidecarEntry>,
  answerSessionIds: ReadonlySet<string>
): readonly string[] {
  return Object.freeze(
    [...sidecar.values()]
      .filter(
        (entry) =>
          entry.objectKind === "memory_entry" &&
          entry.hasAnswer &&
          answerSessionIds.has(entry.sessionId)
      )
      .map((entry) => entry.objectId)
  );
}

export function deriveLongMemEvalMemoryObjectIds(
  sidecar: ReadonlyMap<string, LongMemEvalSidecarEntry>
): readonly string[] {
  return Object.freeze(
    [...sidecar.values()]
      .filter((entry) => entry.objectKind === "memory_entry")
      .map((entry) => entry.objectId)
  );
}

export function readLongMemEvalPinnedMeta(
  variant: LongMemEvalVariant,
  root?: string
): { readonly sha256: string; readonly source: string } {
  const source = resolve(root ?? PINNED_META_ROOT, `${variant}.meta.json`);
  const parsed = JSON.parse(readFileSync(source, "utf8")) as {
    sha256?: unknown;
  };
  if (typeof parsed.sha256 !== "string" || parsed.sha256.length === 0) {
    throw new Error(`LongMemEval pinned meta missing sha256: ${source}`);
  }
  return { sha256: parsed.sha256, source };
}

function inferTier(relevanceScore: number): "hot" | "warm" | "cold" {
  if (relevanceScore >= 0.7) return "hot";
  if (relevanceScore >= 0.4) return "warm";
  return "cold";
}

export function computePercentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

export function summarizeEmbeddingVectorCache(
  summaries: readonly BenchEmbeddingWarmupSummary[]
): LongMemEvalEmbeddingVectorCacheSummary | null {
  const readySummaries = summaries.filter((summary) => summary.status === "ready");
  if (readySummaries.length === 0) {
    return null;
  }

  const expectedCount = readySummaries.reduce(
    (sum, summary) => sum + summary.expected_count,
    0
  );
  const readyCount = readySummaries.reduce(
    (sum, summary) => sum + summary.ready_count,
    0
  );
  const maxPassCount = readySummaries.reduce(
    (max, summary) => Math.max(max, summary.pass_count),
    0
  );

  return {
    expected_count: expectedCount,
    ready_count: readyCount,
    not_ready_count: Math.max(0, expectedCount - readyCount),
    ready_rate: ratio(readyCount, expectedCount),
    max_pass_count: maxPassCount
  };
}

export function summarizeQueryEmbeddingCache(
  summaries: readonly BenchQueryEmbeddingWarmupSummary[]
): LongMemEvalQueryEmbeddingCacheSummary | null {
  const readySummaries = summaries.filter((summary) => summary.status === "ready");
  if (readySummaries.length === 0) {
    return null;
  }

  const requestedCount = readySummaries.reduce(
    (sum, summary) => sum + summary.requested_count,
    0
  );
  const readyCount = readySummaries.reduce(
    (sum, summary) => sum + summary.ready_count,
    0
  );
  const cacheHitCount = readySummaries.reduce(
    (sum, summary) => sum + summary.cache_hit_count,
    0
  );
  const providerRequestedCount = readySummaries.reduce(
    (sum, summary) => sum + summary.provider_requested_count,
    0
  );
  const lastError = [...readySummaries]
    .reverse()
    .find((summary) => summary.last_error !== undefined)?.last_error;

  return {
    requested_count: requestedCount,
    ready_count: readyCount,
    not_ready_count: Math.max(0, requestedCount - readyCount),
    ready_rate: ratio(readyCount, requestedCount),
    cache_hit_count: cacheHitCount,
    provider_requested_count: providerRequestedCount,
    ...(lastError === undefined ? {} : { last_error: lastError })
  };
}

function ratio(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}

function truncateExcerpt(value: string): string {
  return value.length <= 500 ? value : `${value.slice(0, 497)}...`;
}

export function resolveCommitSha7(): string {
  return resolveBenchCommitSha7();
}

export type { LongMemEvalVariant };
