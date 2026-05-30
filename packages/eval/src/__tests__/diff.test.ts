import { describe, expect, it } from "vitest";
import { buildDiffVsPrevious, diffKpis } from "../diff.js";
import { KpiPayloadSchema, type KpiPayload } from "../kpi-schema.js";

function buildPayload(overrides: Partial<KpiPayload["kpi"]>): KpiPayload {
  return {
    bench_name: "self",
    split: "golden",
    run_at: "2026-05-14T10:00:00.000Z",
    alaya_commit: "ec44a05",
    alaya_version: "0.3.6",
    embedding_provider: "yunwu:text-embedding-3-small",
    chat_provider: "yunwu:gpt-5.4-mini",
    policy_shape: "stress",
    simulate_report: "none",
    dataset: { name: "host-autonomy-fixtures", size: 6, source: "internal" },
    sample_size: 10,
    evaluated_count: 10,
    harness_mode: "mcp_propose_review",
    kpi: {
      r_at_1: 0.7,
      r_at_5: 0.95,
      r_at_10: 0.97,
      latency_ms_p50: 80,
      latency_ms_p95: 120,
      latency_source: "exact",
      token_saved_ratio_vs_full_prompt: 0.9,
      tier_distribution: { hot: 60, warm: 30, cold: 10 },
      degradation_reasons: {
        none: 90,
        warm_cascade_engaged: 8,
        cold_cascade_engaged: 2,
        recall_explainability_partial: 0
      },
      seed_truncation: {
        seed_turns_truncated: 0,
        answer_turns_truncated: 0,
        seed_chars_clipped: 0
      },
      per_scenario: [
        { id: "f1", version: 1, hit_at_5: true, tier: "hot" },
        { id: "f2", version: 1, hit_at_5: true, tier: "hot" }
      ],
      ...overrides
    }
  };
}

describe("diffKpis", () => {
  it("returns ok and zero deltas when no previous baseline exists", () => {
    const current = buildPayload({});
    const result = diffKpis(current, null);
    expect(result.worst_verdict).toBe("ok");
    expect(result.deltas).toHaveLength(0);
    expect(result.fixture_regressions).toHaveLength(0);
  });

  it("marks ok when current and previous match", () => {
    const previous = buildPayload({});
    const current = buildPayload({});
    const result = diffKpis(current, previous);
    expect(result.worst_verdict).toBe("ok");
    expect(result.deltas.length).toBeGreaterThan(0);
  });

  it("emits warn when R@5 drops just past the warn threshold on a large-N run", () => {
    const previous: KpiPayload = {
      ...buildPayload({}),
      sample_size: 500,
      evaluated_count: 500
    };
    const current: KpiPayload = {
      ...buildPayload({ r_at_5: 0.92 }),
      sample_size: 500,
      evaluated_count: 500
    };
    const result = diffKpis(current, previous);
    const rAt5 = result.deltas.find((d) => d.key === "r_at_5");
    expect(rAt5?.verdict).toBe("warn");
    expect(result.worst_verdict).toBe("warn");
  });

  it("emits fail and records the regressed fixture id when a golden hit flips to miss", () => {
    const previous = buildPayload({});
    const current = buildPayload({
      per_scenario: [
        { id: "f1", version: 1, hit_at_5: false, tier: "warm" },
        { id: "f2", version: 1, hit_at_5: true, tier: "hot" }
      ]
    });
    const result = diffKpis(current, previous);
    expect(result.worst_verdict).toBe("fail");
    expect(result.fixture_regressions).toEqual(["f1"]);
  });

  it("does not count a version bump as a fixture regression but reports it as rebaselined", () => {
    const previous = buildPayload({});
    const current = buildPayload({
      per_scenario: [
        { id: "f1", version: 2, hit_at_5: false, tier: "warm" },
        { id: "f2", version: 1, hit_at_5: true, tier: "hot" }
      ]
    });
    const result = diffKpis(current, previous);
    expect(result.fixture_regressions).toHaveLength(0);
    expect(result.rebaselined_scenarios).toEqual(["f1"]);
    expect(result.new_scenarios).toHaveLength(0);
  });

  it("reports scenario ids missing from the previous baseline under new_scenarios", () => {
    const previous = buildPayload({});
    const current = buildPayload({
      per_scenario: [
        { id: "f1", version: 1, hit_at_5: true, tier: "hot" },
        { id: "f2", version: 1, hit_at_5: true, tier: "hot" },
        { id: "f3", version: 1, hit_at_5: true, tier: "hot" }
      ]
    });
    const result = diffKpis(current, previous);
    expect(result.new_scenarios).toEqual(["f3"]);
    expect(result.fixture_regressions).toHaveLength(0);
  });

  // @anchor min-sample-test: see thresholds.min_sample_for_ratio_diff
  // ci-aware band widening absorbs small-N noise on ratio KPIs, so the
  // verdict comes out ok directly; the sample-size downgrade still
  // matters for non-ratio KPIs (latency, hot share). See the next test.
  it("ci-aware band absorbs ratio-KPI noise when current evaluated_count is small", () => {
    const previous: KpiPayload = {
      ...buildPayload({ r_at_5: 1.0, r_at_10: 1.0 }),
      evaluated_count: 5
    };
    const current = buildPayload({ r_at_5: 0.798, r_at_10: 0.892 });
    const result = diffKpis(current, previous);
    const r5 = result.deltas.find((d) => d.key === "r_at_5");
    expect(r5?.verdict).toBe("ok");
  });

  it("downgrades latency FAIL to WARN when previous baseline is undersampled", () => {
    // Latency growth crossing the +50% FAIL band against an undersampled
    // baseline. The min-sample guard downgrades it to WARN.
    const previous: KpiPayload = {
      ...buildPayload({ latency_ms_p95: 39 }),
      evaluated_count: 20
    };
    const current = buildPayload({ latency_ms_p95: 73 });
    const result = diffKpis(current, previous);
    const lat = result.deltas.find((d) => d.key === "latency_ms_p95");
    expect(lat?.verdict).toBe("warn");
    expect(result.worst_verdict).not.toBe("fail");
  });

  // @anchor sample-too-small-symmetric: current-undersampled case
  it("downgrades fail to warn when CURRENT run is below min sample size", () => {
    // Previous is a healthy 500-q baseline at R@5=80%; current is a
    // 5-q smoke that happens to land at R@5=0%. The 80pp drop would
    // cross FAIL, but the smoke is the unstable side, not the
    // baseline. The guard must downgrade FAIL here too.
    const previous: KpiPayload = {
      ...buildPayload({ r_at_5: 0.8 }),
      evaluated_count: 500
    };
    const current: KpiPayload = {
      ...buildPayload({ r_at_5: 0 }),
      evaluated_count: 5
    };
    const result = diffKpis(current, previous);
    const r5 = result.deltas.find((d) => d.key === "r_at_5");
    expect(r5?.verdict).toBe("warn");
    expect(result.worst_verdict).not.toBe("fail");
  });

  it("still reports fail when both baselines are at or above min sample size", () => {
    const previous: KpiPayload = {
      ...buildPayload({ r_at_5: 0.95 }),
      evaluated_count: 200
    };
    const current: KpiPayload = {
      ...buildPayload({ r_at_5: 0.7 }),
      evaluated_count: 500
    };
    const result = diffKpis(current, previous);
    expect(result.worst_verdict).toBe("fail");
  });

  it("does not fail public LongMemEval diffs on score-derived hot-share movement", () => {
    const previous: KpiPayload = {
      ...buildPayload({
        tier_distribution: { hot: 100, warm: 0, cold: 0 }
      }),
      bench_name: "public",
      split: "longmemeval-s",
      evaluated_count: 100,
      sample_size: 500
    };
    const current: KpiPayload = {
      ...buildPayload({
        r_at_5: 0.97,
        tier_distribution: { hot: 5, warm: 95, cold: 0 }
      }),
      bench_name: "public",
      split: "longmemeval-s",
      evaluated_count: 100,
      sample_size: 500
    };

    const result = diffKpis(current, previous);

    expect(result.deltas.some((delta) => delta.key === "tier_distribution.hot_share")).toBe(false);
    expect(result.worst_verdict).toBe("ok");
  });

  it("diffs the token_saved ratio drop as a regression signal", () => {
    const previous: KpiPayload = {
      ...buildPayload({ token_saved_ratio_vs_full_prompt: 0.98 }),
      sample_size: 500,
      evaluated_count: 500
    };
    const current: KpiPayload = {
      ...buildPayload({ token_saved_ratio_vs_full_prompt: 0.9 }),
      sample_size: 500,
      evaluated_count: 500
    };
    const result = diffKpis(current, previous);
    const tokenDelta = result.deltas.find(
      (d) => d.key === "token_saved_ratio_vs_full_prompt"
    );
    expect(tokenDelta).toBeDefined();
    expect(tokenDelta?.delta).toBeCloseTo(-0.08, 10);
    expect(tokenDelta?.verdict).toBe("fail");
  });

  it("emits a recalled_context_tokens_mean delta only when both sides carry token_economy", () => {
    const economy = (mean: number) => ({
      schema_version: "bench-token-economy.v1" as const,
      raw_history_tokens: 10_000,
      stored_memory_tokens: 1_000,
      recalled_context_tokens_total: mean * 10,
      recall_event_count: 10,
      recalled_context_tokens_mean: mean,
      seed_event_count: 40
    });
    const previous: KpiPayload = {
      ...buildPayload({ token_economy: economy(200) }),
      sample_size: 500,
      evaluated_count: 500
    };
    const current: KpiPayload = {
      ...buildPayload({ token_economy: economy(400) }),
      sample_size: 500,
      evaluated_count: 500
    };
    const result = diffKpis(current, previous);
    const meanDelta = result.deltas.find(
      (d) => d.key === "token_economy.recalled_context_tokens_mean"
    );
    expect(meanDelta).toBeDefined();
    expect(meanDelta?.delta).toBe(200);
    expect(meanDelta?.direction).toBe("growth_bad");
    // a 2x growth in the per-recall payload is well past the fail band.
    expect(meanDelta?.verdict).toBe("fail");
  });

  it("omits the token_economy delta when a pre-S6 baseline has no token_economy block", () => {
    const previous = buildPayload({});
    const current = buildPayload({
      token_economy: {
        schema_version: "bench-token-economy.v1",
        raw_history_tokens: 10_000,
        stored_memory_tokens: 1_000,
        recalled_context_tokens_total: 2_000,
        recall_event_count: 10,
        recalled_context_tokens_mean: 200,
        seed_event_count: 40
      }
    });
    const result = diffKpis(current, previous);
    expect(
      result.deltas.some(
        (d) => d.key === "token_economy.recalled_context_tokens_mean"
      )
    ).toBe(false);
  });
});

describe("buildDiffVsPrevious", () => {
  it("returns null when there is no previous baseline", () => {
    expect(buildDiffVsPrevious(buildPayload({}), null, "")).toBeNull();
  });

  it("records the R@5 delta in percentage points and a verdict per kpi", () => {
    const previous: KpiPayload = {
      ...buildPayload({ r_at_5: 0.9 }),
      run_at: "2026-05-20T10:00:00.000Z",
      sample_size: 500,
      evaluated_count: 500
    };
    const current: KpiPayload = {
      ...buildPayload({ r_at_5: 0.82 }),
      sample_size: 500,
      evaluated_count: 500
    };
    const block = buildDiffVsPrevious(current, previous, previous.run_at);
    expect(block).not.toBeNull();
    expect(block?.previous_run).toBe("2026-05-20T10:00:00.000Z");
    expect(block?.r_at_5_delta_pp).toBeCloseTo(-8, 10);
    expect(block?.verdict_per_kpi.r_at_5).toBe("fail");
  });

  it("produces a diff_vs_previous block that satisfies KpiPayloadSchema", () => {
    const previous = buildPayload({ r_at_5: 0.95 });
    const current: KpiPayload = {
      ...buildPayload({ r_at_5: 0.93 }),
      diff_vs_previous: buildDiffVsPrevious(
        buildPayload({ r_at_5: 0.93 }),
        previous,
        previous.run_at
      )
    };
    expect(() => KpiPayloadSchema.parse(current)).not.toThrow();
  });

  it("flags fixture_regressions in the verdict map when a golden hit flips", () => {
    const previous = buildPayload({});
    const current = buildPayload({
      per_scenario: [
        { id: "f1", version: 1, hit_at_5: false, tier: "warm" },
        { id: "f2", version: 1, hit_at_5: true, tier: "hot" }
      ]
    });
    const block = buildDiffVsPrevious(current, previous, previous.run_at);
    expect(block?.verdict_per_kpi.fixture_regressions).toBe("fail");
  });
});
