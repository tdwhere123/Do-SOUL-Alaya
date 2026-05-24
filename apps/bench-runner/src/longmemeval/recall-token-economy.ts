import type { RecallTokenEconomy } from "@do-soul/alaya-eval";
import type { BenchRecallTokenEconomy } from "../harness/recall-diagnostics-schema.js";

function readNonNegativeInt(
  record: Readonly<Record<string, unknown>>,
  key: string
): number | null {
  const value = record[key];
  if (typeof value !== "number") return null;
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

/**
 * Narrow `recallResult.diagnostics.token_economy` from the typed `unknown`
 * surface back to a BenchRecallTokenEconomy without re-parsing the whole
 * BenchRecallDiagnosticsSchema (the daemon already ran that parse). Returns
 * null when any expected integer is missing or shaped wrong, so a degraded
 * recall does not pollute the run-level distribution with synthetic zeros.
 */
export function extractRecallTokenEconomy(
  recallResult: unknown
): BenchRecallTokenEconomy | null {
  if (recallResult === null || typeof recallResult !== "object") return null;
  if (!("diagnostics" in recallResult)) return null;
  const diagnostics = (recallResult as { readonly diagnostics?: unknown })
    .diagnostics;
  if (diagnostics === null || typeof diagnostics !== "object") return null;
  if (!("token_economy" in diagnostics)) return null;
  const block = (diagnostics as { readonly token_economy?: unknown })
    .token_economy;
  if (block === null || typeof block !== "object") return null;
  const record = block as Readonly<Record<string, unknown>>;
  const delivered = readNonNegativeInt(
    record,
    "delivered_context_tokens_estimate"
  );
  const coarse = readNonNegativeInt(record, "coarse_pool_size");
  const fine = readNonNegativeInt(record, "fine_evaluated");
  const streams = readNonNegativeInt(record, "fusion_streams_with_hits");
  const inferences = readNonNegativeInt(record, "embedding_inference_calls");
  if (
    delivered === null ||
    coarse === null ||
    fine === null ||
    streams === null ||
    inferences === null
  ) {
    return null;
  }
  return Object.freeze({
    delivered_context_tokens_estimate: delivered,
    coarse_pool_size: coarse,
    fine_evaluated: fine,
    fusion_streams_with_hits: streams,
    embedding_inference_calls: inferences
  });
}

/**
 * @anchor recall-token-economy-aggregator — pure aggregation from the
 * BenchRecallDiagnostics.token_economy block (produced once per recall
 * by RecallService.computeRecallTokenEconomy) into the run-level KPI
 * shape consumed by kpi.json / report.md.
 *
 * The block is measure-only (D5 decision, phase 7): no field gates
 * ranking or admission; figures publish what the recall pipeline did,
 * never what it must do.
 *
 * Distribution stats are computed with linear-interpolation percentiles
 * over the sorted per-recall samples. Empty input yields an all-zero
 * RecallTokenEconomy with `sample_count: 0`; the consumer (report /
 * release notes) is responsible for not emitting the block when the
 * count is zero.
 *
 * see also:
 *   packages/core/src/recall-service.ts (computeRecallTokenEconomy)
 *   apps/bench-runner/src/harness/recall-diagnostics-schema.ts
 *   packages/eval/src/kpi-schema.ts (RecallTokenEconomy KPI block)
 */

const RECALL_TOKEN_ECONOMY_SCHEMA_VERSION =
  "bench-recall-token-economy.v1" as const;

const EMPTY_STAT = Object.freeze({
  mean: 0,
  p50: 0,
  p95: 0,
  max: 0
});

function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  // Linear interpolation between closest ranks. Matches the existing
  // bench latency percentile conventions used in apps/bench-runner so the
  // recall-token-economy distributions are comparable to neighboring KPI
  // distributions on the same report.
  const clamped = Math.min(Math.max(q, 0), 1);
  const position = clamped * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) {
    return sorted[lower]!;
  }
  const weight = position - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

function summarizeField(
  samples: readonly BenchRecallTokenEconomy[],
  pick: (s: BenchRecallTokenEconomy) => number
): { mean: number; p50: number; p95: number; max: number } {
  if (samples.length === 0) return EMPTY_STAT;
  const values: number[] = [];
  let sum = 0;
  let max = 0;
  for (const sample of samples) {
    const value = pick(sample);
    values.push(value);
    sum += value;
    if (value > max) max = value;
  }
  values.sort((left, right) => left - right);
  return {
    mean: sum / values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max
  };
}

/**
 * Aggregate per-recall token-economy samples (one per recall call) into
 * the run-level RecallTokenEconomy KPI block. Returns null when no
 * samples were collected — callers should omit `recall_token_economy`
 * from the KPI rather than persisting a zero-filled block whose
 * `sample_count` is misleading.
 */
export function aggregateRecallTokenEconomy(
  samples: readonly BenchRecallTokenEconomy[]
): RecallTokenEconomy | null {
  if (samples.length === 0) return null;
  return {
    schema_version: RECALL_TOKEN_ECONOMY_SCHEMA_VERSION,
    sample_count: samples.length,
    delivered_context_tokens_estimate: summarizeField(
      samples,
      (s) => s.delivered_context_tokens_estimate
    ),
    coarse_pool_size: summarizeField(samples, (s) => s.coarse_pool_size),
    fine_evaluated: summarizeField(samples, (s) => s.fine_evaluated),
    fusion_streams_with_hits: summarizeField(
      samples,
      (s) => s.fusion_streams_with_hits
    ),
    embedding_inference_calls: summarizeField(
      samples,
      (s) => s.embedding_inference_calls
    )
  };
}
