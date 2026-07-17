import type { AlayaDaemonRuntime } from "@do-soul/alaya";

export interface BenchEmbeddingWarmupOptions {
  readonly maxPasses?: number;
}

export interface BenchEmbeddingProviderReadinessInput {
  readonly embeddingMode: "disabled" | "env";
  readonly providerWarmup?: AlayaDaemonRuntime["services"]["embeddingProviderWarmup"];
}

export async function awaitBenchEmbeddingProviderReady(
  input: BenchEmbeddingProviderReadinessInput
): Promise<void> {
  if (input.embeddingMode !== "env") return;
  if (input.providerWarmup === undefined) {
    throw new Error("embedding provider readiness requested but provider warmup is unavailable");
  }
  const status = await input.providerWarmup;
  if (status !== "ready") {
    throw new Error(`embedding provider readiness barrier failed: status=${status}`);
  }
}

export interface BenchEmbeddingWarmupSummary {
  readonly status: "not_requested" | "ready";
  readonly expected_count: number;
  readonly ready_count: number;
  readonly ready_rate: number;
  readonly pass_count: number;
  readonly missing_object_ids: readonly string[];
  readonly provider_kind: string | null;
  readonly model_id: string | null;
  readonly schema_version: number | null;
  readonly d2q_input: "raw_content" | "content_plus_hq" | null;
}

export interface DrainEmbeddingWarmupPassesInput {
  readonly maxPasses: number;
  readonly maxStallPasses: number;
  readonly runPass: () => Promise<void>;
  readonly readSummary: (passCount: number) => Promise<BenchEmbeddingWarmupSummary>;
}

export interface DrainEmbeddingWarmupPassesResult {
  readonly summary: BenchEmbeddingWarmupSummary;
  readonly lastPassError: string | null;
}

export function formatEmbeddingWarmupNotReadyError(
  summary: BenchEmbeddingWarmupSummary,
  lastPassError: string | null
): string {
  const preview = summary.missing_object_ids.slice(0, 5).join(", ");
  return (
    `embedding warm cache not ready after ${summary.pass_count} pass(es): ` +
    `ready=${summary.ready_count} expected=${summary.expected_count} ` +
    `missing=${summary.missing_object_ids.length}` +
    (preview.length === 0 ? "" : ` first_missing=${preview}`) +
    (lastPassError === null ? "" : ` last_error=${lastPassError}`)
  );
}

export async function drainEmbeddingWarmupPasses(
  input: DrainEmbeddingWarmupPassesInput
): Promise<DrainEmbeddingWarmupPassesResult> {
  let passCount = 0;
  let stallPasses = 0;
  let lastPassError: string | null = null;
  let summary = await input.readSummary(passCount);

  while (
    summary.ready_count < summary.expected_count &&
    passCount < input.maxPasses &&
    stallPasses < input.maxStallPasses
  ) {
    const readyBefore = summary.ready_count;
    try {
      await input.runPass();
      lastPassError = null;
    } catch (error) {
      lastPassError = error instanceof Error ? error.message : String(error);
    }
    passCount++;
    summary = await input.readSummary(passCount);
    stallPasses = summary.ready_count > readyBefore ? 0 : stallPasses + 1;
  }

  return { summary, lastPassError };
}

export interface BenchQueryEmbeddingWarmupSummary {
  readonly status: "not_requested" | "ready";
  readonly requested_count: number;
  readonly ready_count: number;
  readonly cache_hit_count: number;
  readonly provider_requested_count: number;
  readonly missing_count: number;
  readonly provider_kind: string | null;
  readonly model_id: string | null;
  readonly schema_version: number | null;
  readonly d2q_input: "raw_content" | "content_plus_hq" | null;
  readonly last_error?: string;
}
