import { access } from "node:fs/promises";
import path from "node:path";
import { releaseHardGateVerdict, type KpiPayload } from "@do-soul/alaya-eval";
import { seedExtractionReleaseBlockerExitCode } from "../longmemeval/seed-extraction-release-blocker.js";
import { exitCodeForVerdicts } from "./result-format.js";

export function exitCodeForBenchmarkResult(payload: KpiPayload): number {
  const seedExtractionExitCode = seedExtractionReleaseBlockerExitCode(payload);
  if (seedExtractionExitCode !== 0) return seedExtractionExitCode;
  if (releaseHardGateVerdict(payload) === "fail") return 1;
  return exitCodeForVerdicts(payload.diff_vs_previous?.verdict_per_kpi);
}

export function exitCodeForMergedLongMemEvalResult(payload: KpiPayload): number {
  return exitCodeForBenchmarkResult(payload);
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
  const present = shards
    .map((shard) => shard.kpi.seed_extraction_path)
    .filter((path): path is SeedExtractionPathKpi => path !== undefined);
  if (present.length === 0) {
    return undefined;
  }
  if (present.length !== shards.length) {
    throw new Error(
      "merge refused: seed_extraction_path is present on only some shards"
    );
  }

  return {
    path: present.some((path) => path.path === "no_credentials_fallback")
      ? "no_credentials_fallback"
      : "official_api_compile",
    cache_hits: present.reduce((sum, path) => sum + path.cache_hits, 0),
    llm_calls: present.reduce((sum, path) => sum + path.llm_calls, 0),
    offline_fallbacks: present.reduce(
      (sum, path) => sum + path.offline_fallbacks,
      0
    ),
    live_extraction_failures: present.reduce(
      (sum, path) => sum + path.live_extraction_failures,
      0
    ),
    cached_extraction_failures: present.reduce(
      (sum, path) => sum + path.cached_extraction_failures,
      0
    ),
    facts_produced: present.reduce((sum, path) => sum + path.facts_produced, 0),
    signals_dropped: present.reduce(
      (sum, path) => sum + path.signals_dropped,
      0
    ),
    parse_dropped: present.reduce((sum, path) => sum + path.parse_dropped, 0),
    compile_overflow_dropped: present.reduce(
      (sum, path) => sum + path.compile_overflow_dropped,
      0
    ),
    signals_dropped_by_reason: {
      candidate_absent: present.reduce(
        (sum, path) => sum + path.signals_dropped_by_reason.candidate_absent,
        0
      ),
      materialization_error: present.reduce(
        (sum, path) =>
          sum + path.signals_dropped_by_reason.materialization_error,
        0
      )
    }
  };
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

