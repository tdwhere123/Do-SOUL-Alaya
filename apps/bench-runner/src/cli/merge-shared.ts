import { access } from "node:fs/promises";
import path from "node:path";
import {
  verifiedLongMemEvalEvidenceMatches,
  type KpiPayload,
  type VerifiedLongMemEvalEvidenceContext
} from "@do-soul/alaya-eval";
import { exitCodeForReleaseHardGates } from "./release-hard-gate-exit.js";

export function exitCodeForBenchmarkResult(
  payload: KpiPayload,
  evidence?: VerifiedLongMemEvalEvidenceContext
): number {
  const hardGateExitCode = exitCodeForReleaseHardGates(payload);
  if (hardGateExitCode !== 0) return hardGateExitCode;
  if (!verifiedLongMemEvalEvidenceMatches(payload, evidence)) return 1;
  return 0;
}

export function exitCodeForMergedLongMemEvalResult(
  payload: KpiPayload,
  evidence?: VerifiedLongMemEvalEvidenceContext
): number {
  return exitCodeForBenchmarkResult(payload, evidence);
}

export function ratio(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}

type SeedExtractionPathKpi = NonNullable<
  KpiPayload["kpi"]["seed_extraction_path"]
>;

export function mergeSeedExtractionPath(
  shards: readonly KpiPayload[]
): SeedExtractionPathKpi | undefined {
  const present = collectSeedExtractionPaths(shards);
  if (present === undefined) return undefined;
  return {
    path: present.some((path) => path.path === "no_credentials_fallback")
      ? "no_credentials_fallback"
      : "official_api_compile",
    ...mergeExtractionAttempts(present),
    cache_hits: sumSeedExtractionPaths(present, (path) => path.cache_hits),
    llm_calls: sumSeedExtractionPaths(present, (path) => path.llm_calls),
    offline_fallbacks: sumSeedExtractionPaths(present, (path) => path.offline_fallbacks),
    live_extraction_failures: sumSeedExtractionPaths(
      present, (path) => path.live_extraction_failures
    ),
    cached_extraction_failures: sumSeedExtractionPaths(
      present, (path) => path.cached_extraction_failures
    ),
    facts_produced: sumSeedExtractionPaths(present, (path) => path.facts_produced),
    signals_dropped: sumSeedExtractionPaths(present, (path) => path.signals_dropped),
    parse_dropped: sumSeedExtractionPaths(present, (path) => path.parse_dropped),
    compile_overflow_dropped: sumSeedExtractionPaths(
      present, (path) => path.compile_overflow_dropped
    ),
    signals_dropped_by_reason: {
      candidate_absent: sumSeedExtractionPaths(
        present, (path) => path.signals_dropped_by_reason.candidate_absent
      ),
      materialization_drop: sumSeedExtractionPaths(
        present, (path) => path.signals_dropped_by_reason.materialization_drop
      )
    }
  };
}

function collectSeedExtractionPaths(
  shards: readonly KpiPayload[]
): readonly SeedExtractionPathKpi[] | undefined {
  const present = shards
    .map((shard) => shard.kpi.seed_extraction_path)
    .filter((path): path is SeedExtractionPathKpi => path !== undefined);
  if (present.length === 0) return undefined;
  if (present.length !== shards.length) {
    throw new Error(
      "merge refused: seed_extraction_path is present on only some shards"
    );
  }
  return present;
}

function mergeExtractionAttempts(
  paths: readonly SeedExtractionPathKpi[]
): { readonly extraction_attempts?: number } {
  if (paths.some((path) => path.extraction_attempts === undefined)) return {};
  return {
    extraction_attempts: sumSeedExtractionPaths(
      paths, (path) => path.extraction_attempts ?? 0
    )
  };
}

function sumSeedExtractionPaths(
  paths: readonly SeedExtractionPathKpi[],
  select: (path: SeedExtractionPathKpi) => number
): number {
  return paths.reduce((sum, path) => sum + select(path), 0);
}

export function computePercentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([key, entryValue]) => `${JSON.stringify(key)}:${stableJson(entryValue)}`
    );
  return `{${entries.join(",")}}`;
}

const SHARD_POINTER_FILENAMES = [
  "latest-passing.json",
  "latest-run.json",
  "latest-baseline.json"
] as const;

export async function resolveShardPointerPath(shardRoot: string): Promise<string> {
  const pointerRoot = path.join(shardRoot, "public");
  for (const filename of SHARD_POINTER_FILENAMES) {
    const pointerPath = path.join(pointerRoot, filename);
    try {
      await access(pointerPath);
      return pointerPath;
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
    }
  }
  throw new Error(
    `shard ${shardRoot} no usable shard pointer; checked ${SHARD_POINTER_FILENAMES.join(", ")}`
  );
}

export function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
