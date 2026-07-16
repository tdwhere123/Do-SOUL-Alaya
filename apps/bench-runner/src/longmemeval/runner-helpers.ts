import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BenchPolicyShape, SeedExtractionPath } from "@do-soul/alaya-eval";
import { DEFAULT_LOCAL_ONNX_MODEL_ID } from "@do-soul/alaya-core";
import {
  resolveBenchCommitInfo
} from "../shared/version.js";
import type {
  BenchEmbeddingMode,
  BenchEmbeddingProviderKind,
  BenchEmbeddingWarmupSummary,
  BenchQueryEmbeddingWarmupSummary
} from "../harness/daemon.js";
import { DEFAULT_BENCH_EMBEDDING_PROVIDER_KIND } from "../harness/daemon-types.js";
import type { LongMemEvalSnapshotQuestion } from "./snapshot.js";
import type { LongMemEvalRunProvenance } from "./provenance/run.js";
import { writeRecallEvalSnapshotArtifacts } from "./snapshot/writer.js";
import type {
  LongMemEvalEmbeddingVectorCacheSummary,
  LongMemEvalQueryEmbeddingCacheSummary
} from "./diagnostics.js";
import type { LongMemEvalQuestion, LongMemEvalVariant } from "./dataset.js";
export {
  buildLongMemEvalReportContextUsage,
  readLongMemEvalReportSideEffectSnapshot,
  runLongMemEvalRecallCycle,
  type LongMemEvalBenchRecallResult,
  type LongMemEvalRecallCycleResult,
  type LongMemEvalReportSimulationStats
} from "./runner-reporting.js";
export {
  buildLongMemEvalSidecarKey,
  deriveLongMemEvalGoldMemoryIds,
  deriveLongMemEvalMemoryObjectIds,
  enrichAbstentionConfidence,
  isLongMemEvalGoldEligibleResult,
  joinFusedScoresOntoResults,
  resolveLongMemEvalHitVerdict,
  scoreLongMemEvalRecallHits,
  type LongMemEvalHitScoringInput,
  type LongMemEvalHitScoringResult,
  type LongMemEvalSidecarEntry
} from "./runner-scoring.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BENCH_EMBEDDING_MODEL = "text-embedding-3-small";
const PINNED_META_ROOT = resolve(
  __dirname,
  "../../../../docs/bench-history/datasets"
);


export function resolveBenchEmbeddingProviderLabel(
  embeddingMode: BenchEmbeddingMode,
  env: Readonly<Record<string, string | undefined>> = process.env,
  providerKind: BenchEmbeddingProviderKind = DEFAULT_BENCH_EMBEDDING_PROVIDER_KIND
): string {
  if (embeddingMode === "disabled") {
    return "none";
  }

  if (providerKind === "local_onnx") {
    const localModel =
      env.ALAYA_LOCAL_EMBEDDING_MODEL?.trim() ||
      DEFAULT_LOCAL_ONNX_MODEL_ID;
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

// Recall pool width. Default 10 (production口径). A wide override lets a
// diagnostic probe (gold-rank / pool dump) see where buried gold ranks beyond
// the delivery window; delivery itself stays top-10. No fusion-weight change.
// Pool-dump runs widen to at least 100 automatically so the JSONL captures the
// deep-buried gold tail without a second env knob.
function resolveBenchRecallMaxK(): number {
  const configured = Math.floor(Number(process.env.ALAYA_BENCH_RECALL_MAXK ?? "10"));
  const base = Number.isFinite(configured) && configured > 0 ? configured : 10;
  if (process.env.ALAYA_BENCH_POOL_DUMP !== undefined) {
    return Math.max(100, base);
  }
  return Math.max(10, base);
}

export function recallOptionsForPolicyShape(
  policyShape: BenchPolicyShape
): { readonly maxResults: number; readonly conflictAwareness: boolean } {
  return {
    maxResults: resolveBenchRecallMaxK(),
    conflictAwareness: policyShape !== "chat"
  };
}

export function writeRecallEvalSnapshot(input: {
  readonly snapshotOut: string;
  readonly seedDataDirRoot: string;
  readonly variant: LongMemEvalVariant;
  readonly commitSha7: string;
  readonly canonicalQuestions: readonly LongMemEvalQuestion[];
  readonly snapshotQuestions: readonly LongMemEvalSnapshotQuestion[];
  readonly extractionCacheRoot: string;
  readonly datasetSha256: string;
  readonly seedExtractionPath: SeedExtractionPath;
  readonly runProvenance: LongMemEvalRunProvenance;
}): Promise<void> {
  return writeRecallEvalSnapshotArtifacts(input);
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

export function resolveCommitInfo() {
  return resolveBenchCommitInfo();
}

export type BenchCommitInfo = ReturnType<typeof resolveCommitInfo>;

export function resolveCommitSha7(): string {
  return resolveCommitInfo().sha7;
}

export type { LongMemEvalVariant };
