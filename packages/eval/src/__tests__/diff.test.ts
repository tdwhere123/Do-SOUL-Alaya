import { describe, expect, it } from "vitest";
import { diffKpis } from "../diff.js";
import type { KpiPayload } from "../kpi-schema.js";

function buildPayload(overrides: Partial<KpiPayload["kpi"]>): KpiPayload {
  return {
    bench_name: "self",
    split: "golden",
    run_at: "2026-05-14T10:00:00.000Z",
    alaya_commit: "ec44a05",
    alaya_version: "0.3.6",
    embedding_provider: "yunwu:text-embedding-3-small",
    chat_provider: "yunwu:gpt-5.4-mini",
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
      token_saved_ratio_vs_full_prompt: 0.9,
      tier_distribution: { hot: 60, warm: 30, cold: 10 },
      degradation_reasons: {
        none: 90,
        warm_cascade_engaged: 8,
        cold_cascade_engaged: 2
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

  it("emits warn when R@5 drops just past the warn threshold", () => {
    const previous = buildPayload({});
    const current = buildPayload({ r_at_5: 0.92 });
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

  // @anchor min-sample-test — see thresholds.min_sample_for_ratio_diff
  it("downgrades fail to warn when the previous baseline is below min sample size", () => {
    // Previous baseline was a tiny n=5 smoke that happened to hit 100%.
    // Without the sample-size guard a 20pp "drop" would flag FAIL even
    // though variance at n=5 is enormous. With the guard it reports WARN.
    const previous: KpiPayload = {
      ...buildPayload({ r_at_5: 1.0, r_at_10: 1.0 }),
      evaluated_count: 5
    };
    const current = buildPayload({ r_at_5: 0.798, r_at_10: 0.892 });
    const result = diffKpis(current, previous);
    expect(result.worst_verdict).toBe("warn");
    const r5 = result.deltas.find((d) => d.key === "r_at_5");
    expect(r5?.verdict).toBe("warn");
  });

  it("downgrades latency FAIL to WARN when previous baseline is undersampled", () => {
    // Latency growth crossing the +50% FAIL band against an undersampled
    // baseline. The smoke vs full case is structural (concurrency mode
    // changes across runs at small N), so a hard FAIL would be a false
    // alarm. The min-sample guard downgrades it to WARN.
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

  it("still reports fail when both baselines are at or above min sample size", () => {
    const previous: KpiPayload = {
      ...buildPayload({ r_at_5: 0.95 }),
      evaluated_count: 200
    };
    const current = buildPayload({ r_at_5: 0.7 });
    const result = diffKpis(current, previous);
    expect(result.worst_verdict).toBe("fail");
  });
});
