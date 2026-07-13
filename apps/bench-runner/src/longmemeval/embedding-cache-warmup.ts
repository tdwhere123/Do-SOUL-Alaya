import type {
  BenchEmbeddingMode,
  BenchEmbeddingWarmupSummary,
  BenchQueryEmbeddingWarmupSummary,
  BenchWorkspaceHandle
} from "../harness/daemon.js";
import { resolveBenchEmbeddingModelId } from "../harness/daemon-handle-ops-support.js";
import { resolveTreatmentEmbeddingInputIdentity } from "../harness/strict-treatment-config.js";

export interface LongMemEvalEmbeddingCacheWarmup {
  readonly embeddingWarmup: BenchEmbeddingWarmupSummary | null;
  readonly queryEmbeddingWarmup: BenchQueryEmbeddingWarmupSummary | null;
}

export async function warmLongMemEvalEmbeddingCaches(input: {
  readonly embeddingMode: BenchEmbeddingMode;
  readonly workspace: Pick<
    BenchWorkspaceHandle,
    "warmEmbeddingCache" | "warmQueryEmbeddingCache"
  >;
  readonly objectIds: readonly string[];
  readonly queryText: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): Promise<LongMemEvalEmbeddingCacheWarmup> {
  if (input.embeddingMode !== "env") {
    return { embeddingWarmup: null, queryEmbeddingWarmup: null };
  }
  const embeddingWarmup = await input.workspace.warmEmbeddingCache(input.objectIds);
  const queryEmbeddingWarmup = await input.workspace.warmQueryEmbeddingCache([
    input.queryText
  ]);
  assertQueryEmbeddingWarmupReady(
    queryEmbeddingWarmup,
    input.queryText.trim().length === 0 ? 0 : 1,
    input.env ?? process.env
  );
  return { embeddingWarmup, queryEmbeddingWarmup };
}

function assertQueryEmbeddingWarmupReady(
  summary: BenchQueryEmbeddingWarmupSummary,
  expectedCount: number,
  env: Readonly<Record<string, string | undefined>>
): void {
  const expected = resolveExpectedEmbeddingIdentity(env);
  const countPartition = summary.cache_hit_count + summary.provider_requested_count;
  const ready = summary.status === "ready" &&
    summary.requested_count === expectedCount &&
    summary.ready_count === expectedCount &&
    summary.missing_count === 0 &&
    countPartition === expectedCount &&
    summary.last_error === undefined &&
    summary.provider_kind === expected.providerKind &&
    summary.model_id === expected.modelId &&
    summary.schema_version === expected.schema_version &&
    summary.d2q_input === expected.d2q_input;
  if (!ready) throw new Error(formatQueryWarmupError(summary, expectedCount, expected));
}

function resolveExpectedEmbeddingIdentity(
  env: Readonly<Record<string, string | undefined>>
): Readonly<{
  providerKind: "openai" | "local_onnx";
  modelId: string;
  schema_version: number;
  d2q_input: "raw_content" | "content_plus_hq";
}> {
  const providerKind = env.ALAYA_EMBEDDING_PROVIDER?.trim() === "local_onnx"
    ? "local_onnx" as const
    : "openai" as const;
  return {
    ...resolveBenchEmbeddingModelId(providerKind, env),
    ...resolveTreatmentEmbeddingInputIdentity(providerKind, env)
  };
}

function formatQueryWarmupError(
  summary: BenchQueryEmbeddingWarmupSummary,
  expectedCount: number,
  expected: ReturnType<typeof resolveExpectedEmbeddingIdentity>
): string {
  return "query embedding warmup not ready: " +
    `status=${summary.status} ready=${summary.ready_count} requested=${summary.requested_count} ` +
    `expected=${expectedCount} missing=${summary.missing_count} ` +
    `provider=${summary.provider_kind ?? "none"} expected_provider=${expected.providerKind} ` +
    `model=${summary.model_id ?? "none"} expected_model=${expected.modelId} ` +
    `schema=${summary.schema_version ?? "none"} expected_schema=${expected.schema_version} ` +
    `d2q=${summary.d2q_input ?? "none"} expected_d2q=${expected.d2q_input} ` +
    `error=${summary.last_error ?? "none"}`;
}
