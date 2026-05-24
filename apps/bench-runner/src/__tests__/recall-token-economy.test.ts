import { describe, expect, it } from "vitest";
import {
  aggregateRecallTokenEconomy,
  extractRecallTokenEconomy
} from "../longmemeval/recall-token-economy.js";
import type { BenchRecallTokenEconomy } from "../harness/recall-diagnostics-schema.js";

function sample(overrides: Partial<BenchRecallTokenEconomy> = {}): BenchRecallTokenEconomy {
  return {
    delivered_context_tokens_estimate: 100,
    coarse_pool_size: 80,
    fine_evaluated: 80,
    fusion_streams_with_hits: 6,
    embedding_inference_calls: 0,
    ...overrides
  };
}

describe("aggregateRecallTokenEconomy", () => {
  it("returns null on empty input so KPI consumers omit the block", () => {
    expect(aggregateRecallTokenEconomy([])).toBeNull();
  });

  it("computes mean, p50, p95, and max across per-recall samples", () => {
    const samples = [10, 20, 30, 40, 50].map((value) =>
      sample({ delivered_context_tokens_estimate: value })
    );
    const aggregate = aggregateRecallTokenEconomy(samples);
    expect(aggregate).not.toBeNull();
    expect(aggregate?.sample_count).toBe(5);
    expect(aggregate?.delivered_context_tokens_estimate.mean).toBeCloseTo(30, 5);
    expect(aggregate?.delivered_context_tokens_estimate.p50).toBeCloseTo(30, 5);
    // Linear interpolation between index 3 (value 40) and 4 (value 50):
    // q*(n-1) = 0.95*4 = 3.8 → 40 + 0.8 * (50-40) = 48.
    expect(aggregate?.delivered_context_tokens_estimate.p95).toBeCloseTo(48, 5);
    expect(aggregate?.delivered_context_tokens_estimate.max).toBe(50);
  });

  it("treats embedding_inference_calls as a 0/1 mean of fresh provider hits", () => {
    const samples = [
      sample({ embedding_inference_calls: 1 }),
      sample({ embedding_inference_calls: 0 }),
      sample({ embedding_inference_calls: 0 }),
      sample({ embedding_inference_calls: 1 })
    ];
    const aggregate = aggregateRecallTokenEconomy(samples);
    expect(aggregate?.embedding_inference_calls.mean).toBeCloseTo(0.5, 5);
    expect(aggregate?.embedding_inference_calls.max).toBe(1);
  });

  it("stamps the schema_version literal so kpi.json readers can pin versioning", () => {
    const aggregate = aggregateRecallTokenEconomy([sample()]);
    expect(aggregate?.schema_version).toBe("bench-recall-token-economy.v1");
  });
});

describe("extractRecallTokenEconomy", () => {
  it("returns null when the recall result lacks diagnostics", () => {
    expect(extractRecallTokenEconomy({ delivery_id: "d" })).toBeNull();
    expect(extractRecallTokenEconomy(null)).toBeNull();
    expect(extractRecallTokenEconomy({ diagnostics: null })).toBeNull();
  });

  it("returns null when token_economy is malformed", () => {
    expect(
      extractRecallTokenEconomy({
        diagnostics: {
          token_economy: {
            delivered_context_tokens_estimate: "not a number",
            coarse_pool_size: 0,
            fine_evaluated: 0,
            fusion_streams_with_hits: 0,
            embedding_inference_calls: 0
          }
        }
      })
    ).toBeNull();
  });

  it("narrows a well-formed token_economy block to BenchRecallTokenEconomy", () => {
    const sampleBlock = sample({
      delivered_context_tokens_estimate: 42,
      embedding_inference_calls: 1
    });
    const extracted = extractRecallTokenEconomy({
      diagnostics: { token_economy: sampleBlock }
    });
    expect(extracted).toEqual(sampleBlock);
  });
});
