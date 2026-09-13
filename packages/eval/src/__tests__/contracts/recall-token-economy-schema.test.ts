import { describe, expect, it } from "vitest";
import {
  RecallTokenEconomySampleSchema,
  RecallTokenEconomySchema
} from "../../contracts/kpi-auxiliary-schema.js";

const SAMPLE = {
  delivered_context_tokens_estimate: 12,
  coarse_pool_size: 8,
  fine_evaluated: 8,
  fine_pruned_count: 1,
  fine_priority_overflow_count: 0,
  fusion_families_with_hits: 3,
  embedding_inference_calls: 1
};

describe("recall token economy sample schema", () => {
  it("parses a per-call sample payload", () => {
    expect(RecallTokenEconomySampleSchema.parse(SAMPLE)).toMatchObject(SAMPLE);
  });

  it("keeps the aggregate schema as the KPI owner", () => {
    const aggregate = RecallTokenEconomySchema.parse({
      schema_version: "bench-recall-token-economy.v1",
      sample_count: 1,
      delivered_context_tokens_estimate: { mean: 12, p50: 12, p95: 12, max: 12 },
      coarse_pool_size: { mean: 8, p50: 8, p95: 8, max: 8 },
      fine_evaluated: { mean: 8, p50: 8, p95: 8, max: 8 },
      fine_pruned_count: { mean: 1, p50: 1, p95: 1, max: 1 },
      fusion_families_with_hits: { mean: 3, p50: 3, p95: 3, max: 3 },
      embedding_inference_calls: { mean: 1, p50: 1, p95: 1, max: 1 }
    });
    expect(aggregate.sample_count).toBe(1);
    expect(aggregate.delivered_context_tokens_estimate.mean).toBe(12);
  });
});
