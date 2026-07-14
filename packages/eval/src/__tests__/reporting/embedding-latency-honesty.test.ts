import { describe, expect, it } from "vitest";
import { describeEmbeddingLatencyHonesty } from "../../reporting/report-absolute-kpis.js";
import type { KpiPayload } from "../../schema/kpi-schema.js";

function basePayload(
  overrides: Partial<KpiPayload> & {
    readonly kpi?: Partial<KpiPayload["kpi"]>;
  }
): KpiPayload {
  return {
    schema_version: "bench-kpi.v1",
    bench_name: "public",
    split: "longmemeval-s",
    sample_size: 100,
    evaluated_count: 100,
    embedding_provider: "local_onnx",
    simulate_report: "none",
    policy_shape: "default",
    harness_mode: "mcp_propose_review",
    ...overrides,
    kpi: {
      r_at_1: 0.5,
      r_at_5: 0.9,
      r_at_10: 0.95,
      latency_ms_p50: 400,
      latency_ms_p95: 900,
      latency_source: "exact",
      token_saved_ratio_vs_full_prompt: 0.5,
      tier_distribution: { hot: 0, warm: 0, cold: 100 },
      degradation_reasons: {
        none: 100,
        warm_cascade_engaged: 0,
        cold_cascade_engaged: 0,
        recall_explainability_partial: 0
      },
      seed_truncation: {
        seed_turns_truncated: 0,
        answer_turns_truncated: 0,
        seed_chars_clipped: 0
      },
      per_scenario: [],
      ...overrides.kpi
    }
  } as KpiPayload;
}

describe("describeEmbeddingLatencyHonesty", () => {
  it("flags warm-cache-only latency when bi-encoder inference mean is 0", () => {
    const message = describeEmbeddingLatencyHonesty(basePayload({
      kpi: {
        recall_token_economy: {
          schema_version: "bench-recall-token-economy.v1",
          sample_count: 100,
          delivered_context_tokens_estimate: { mean: 0, p50: 0, p95: 0, max: 0 },
          coarse_pool_size: { mean: 0, p50: 0, p95: 0, max: 0 },
          fine_evaluated: { mean: 0, p50: 0, p95: 0, max: 0 },
          fine_pruned_count: { mean: 0, p50: 0, p95: 0, max: 0 },
          fusion_families_with_hits: { mean: 0, p50: 0, p95: 0, max: 0 },
          embedding_inference_calls: { mean: 0, p50: 0, p95: 0, max: 0 }
        }
      }
    }));
    expect(message).toMatch(/warm-query-cache-only/u);
    expect(message).toMatch(/not claimable/u);
  });

  it("accepts in-timer encode when inference mean is ≥ 1", () => {
    const message = describeEmbeddingLatencyHonesty(basePayload({
      kpi: {
        recall_token_economy: {
          schema_version: "bench-recall-token-economy.v1",
          sample_count: 100,
          delivered_context_tokens_estimate: { mean: 0, p50: 0, p95: 0, max: 0 },
          coarse_pool_size: { mean: 0, p50: 0, p95: 0, max: 0 },
          fine_evaluated: { mean: 0, p50: 0, p95: 0, max: 0 },
          fine_pruned_count: { mean: 0, p50: 0, p95: 0, max: 0 },
          fusion_families_with_hits: { mean: 0, p50: 0, p95: 0, max: 0 },
          embedding_inference_calls: { mean: 1, p50: 1, p95: 1, max: 1 }
        }
      }
    }));
    expect(message).toMatch(/in-timer query encode/u);
  });
});
