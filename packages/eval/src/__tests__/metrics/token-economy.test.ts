import { describe, expect, it } from "vitest";
import {
  buildTokenEconomy,
  computeTokenSavedRatio,
  type TokenEconomyInput
} from "../../metrics/token-economy.js";
import { KpiPayloadSchema } from "../../schema/kpi-schema.js";

function input(overrides: Partial<TokenEconomyInput> = {}): TokenEconomyInput {
  return {
    raw_history_tokens: 10_000,
    stored_memory_tokens: 1_200,
    recalled_context_tokens_total: 2_000,
    recall_event_count: 10,
    recalled_context_tokens_mean: 200,
    seed_event_count: 40,
    ...overrides
  };
}

describe("buildTokenEconomy", () => {
  it("stamps the schema version and copies the raw counts verbatim", () => {
    const economy = buildTokenEconomy(input());
    expect(economy.schema_version).toBe("bench-token-economy.v1");
    expect(economy.raw_history_tokens).toBe(10_000);
    expect(economy.stored_memory_tokens).toBe(1_200);
    expect(economy.recalled_context_tokens_total).toBe(2_000);
    expect(economy.recall_event_count).toBe(10);
    expect(economy.recalled_context_tokens_mean).toBe(200);
    expect(economy.seed_event_count).toBe(40);
  });

  it("produces a block that parses inside KpiPayloadSchema", () => {
    const economy = buildTokenEconomy(input());
    const payload = {
      bench_name: "public",
      split: "longmemeval-s",
      run_at: "2026-05-21T00:00:00.000Z",
      alaya_commit: "abc1234",
      alaya_version: "0.3.10",
      embedding_provider: "none",
      chat_provider: "none",
      dataset: { name: "lme", size: 1, source: "hf" },
      sample_size: 1,
      evaluated_count: 1,
      harness_mode: "mcp_propose_review",
      kpi: {
        r_at_1: 0.3,
        r_at_5: 0.66,
        r_at_10: 0.78,
        latency_ms_p50: 80,
        latency_ms_p95: 150,
        token_saved_ratio_vs_full_prompt: 0.98,
        token_economy: economy,
        tier_distribution: { hot: 1, warm: 0, cold: 0 },
        degradation_reasons: {
          none: 1,
          warm_cascade_engaged: 0,
          cold_cascade_engaged: 0
        },
        per_scenario: []
      }
    };
    const parsed = KpiPayloadSchema.parse(payload);
    expect(parsed.kpi.token_economy?.schema_version).toBe(
      "bench-token-economy.v1"
    );
  });
});

describe("computeTokenSavedRatio", () => {
  it("derives the saved ratio as 1 - recalled_mean / raw_history", () => {
    // 200 recalled vs 10000 raw history => 0.98 saved.
    expect(computeTokenSavedRatio(input())).toBeCloseTo(0.98, 10);
  });

  it("returns 0 when there is no raw history to compare against", () => {
    expect(
      computeTokenSavedRatio(
        input({ raw_history_tokens: 0, recalled_context_tokens_mean: 0 })
      )
    ).toBe(0);
  });

  it("clamps to 0 when recalled context somehow exceeds the full history", () => {
    expect(
      computeTokenSavedRatio(
        input({ raw_history_tokens: 100, recalled_context_tokens_mean: 250 })
      )
    ).toBe(0);
  });

  it("clamps to 1 and never exceeds it for a near-zero recall payload", () => {
    const ratio = computeTokenSavedRatio(
      input({ raw_history_tokens: 10_000, recalled_context_tokens_mean: 0 })
    );
    expect(ratio).toBe(1);
  });

  it("uses the per-recall mean, not the summed total", () => {
    // total 2000 across 10 recalls => mean 200; the ratio must be driven by
    // the mean (0.98), not by the total (which would give a negative ratio).
    expect(computeTokenSavedRatio(input())).toBeGreaterThan(0.9);
  });
});
