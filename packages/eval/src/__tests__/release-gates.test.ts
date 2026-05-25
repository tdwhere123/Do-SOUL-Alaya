import { describe, expect, it } from "vitest";
import type { KpiPayload } from "../kpi-schema.js";
import {
  collectReleaseHardGates,
  releaseHardGateAllowsLatestPassing,
  releaseHardGateVerdict
} from "../release-gates.js";

function buildPayload(commit: string): KpiPayload {
  return {
    bench_name: "self",
    split: "synthetic",
    run_at: "2026-05-14T10:00:00.000Z",
    alaya_commit: commit,
    alaya_version: "0.3.11",
    embedding_provider: "none",
    chat_provider: "n/a",
    policy_shape: "stress",
    simulate_report: "none",
    dataset: { name: "synthetic", size: 12, source: "internal" },
    sample_size: 10,
    evaluated_count: 10,
    harness_mode: "mcp_propose_review",
    kpi: {
      r_at_1: 0.6,
      r_at_5: 0.85,
      r_at_10: 0.9,
      latency_ms_p50: 60,
      latency_ms_p95: 110,
      token_saved_ratio_vs_full_prompt: 0.88,
      tier_distribution: { hot: 50, warm: 30, cold: 20 },
      degradation_reasons: {
        none: 80,
        warm_cascade_engaged: 12,
        cold_cascade_engaged: 8
      },
      per_scenario: []
    }
  };
}

function buildLimitedTier1Payload(
  benchName: "public" | "public-multiturn" | "public-crossquestion",
  datasetName: string
): KpiPayload {
  return {
    ...buildPayload("abc1234"),
    bench_name: benchName,
    split: "longmemeval-s",
    dataset: {
      name: datasetName,
      size: 500,
      source: "fixture"
    },
    sample_size: 500,
    evaluated_count: 20
  };
}

function buildLocomoPayload(
  sampleSize: number,
  evaluatedCount: number,
  rAt5: number
): KpiPayload {
  return {
    ...buildPayload("abc1234"),
    bench_name: "public-locomo",
    split: "locomo10",
    embedding_provider: "none",
    dataset: {
      name: "locomo10",
      size: 10,
      source: "fixture"
    },
    sample_size: sampleSize,
    evaluated_count: evaluatedCount,
    kpi: {
      ...buildPayload("abc1234").kpi,
      r_at_5: rAt5,
      latency_ms_p95: 110
    }
  };
}

function passingQualityMetrics(): NonNullable<KpiPayload["kpi"]["quality_metrics"]> {
  return {
    schema_version: "bench-quality-metrics.v1",
    non_monotonic_rate: 0,
    non_monotonic_count: 0,
    non_monotonic_denominator: 100,
    budget_drop_distribution: {
      max_entries: {
        count: 0,
        share: 0,
        denominator: 100
      }
    },
    high_lexical_demoted_rate: 0,
    high_lexical_demoted_count: 0,
    high_lexical_demoted_denominator: 0,
    candidate_absent_count: 0,
    candidate_absent_denominator: 100,
    no_gold_count: 0,
    no_gold_denominator: 100,
    evidence_stream_gold_delivery_rate: 0.2,
    evidence_stream_gold_delivery_count: 20,
    evidence_stream_gold_delivery_denominator: 100,
    path_stream_top10_rate: 0.12,
    path_stream_top10_count: 12,
    path_stream_top10_denominator: 100,
    miss_distribution: {}
  };
}

describe("release hard gates", () => {
  it.each([
    ["public" as const, "longmemeval_s"],
    ["public-multiturn" as const, "longmemeval_s:multiturn"],
    ["public-crossquestion" as const, "longmemeval_s:crossquestion"]
  ])("keeps non-full %s Tier 1 archives out of latest-passing", (benchName, datasetName) => {
    const payload = buildLimitedTier1Payload(benchName, datasetName);

    expect(collectReleaseHardGates(payload)).toEqual([]);
    expect(releaseHardGateVerdict(payload)).toBe("ok");
    expect(releaseHardGateAllowsLatestPassing(payload)).toBe(false);
  });

  it("keeps staged LoCoMo Tier 1 archives out of latest-passing", () => {
    const payload = buildLocomoPayload(100, 100, 0.99);

    expect(collectReleaseHardGates(payload)).toEqual([]);
    expect(releaseHardGateVerdict(payload)).toBe("ok");
    expect(releaseHardGateAllowsLatestPassing(payload)).toBe(false);
  });

  it("keeps staged public Tier 1 archives out of latest-passing even when report gates pass", () => {
    const payload: KpiPayload = {
      ...buildPayload("abc1234"),
      bench_name: "public",
      split: "longmemeval-s",
      embedding_provider: "none",
      dataset: {
        name: "longmemeval_s",
        size: 500,
        source: "fixture"
      },
      sample_size: 500,
      evaluated_count: 100,
      kpi: {
        ...buildPayload("abc1234").kpi,
        r_at_5: 0.72,
        latency_ms_p95: 110,
        quality_metrics: passingQualityMetrics()
      }
    };

    expect(collectReleaseHardGates(payload).length).toBeGreaterThan(0);
    expect(collectReleaseHardGates(payload).every((gate) => gate.passed)).toBe(true);
    expect(releaseHardGateVerdict(payload)).toBe("ok");
    expect(releaseHardGateAllowsLatestPassing(payload)).toBe(false);
  });

  it.each([
    ["public" as const, "longmemeval_s"],
    ["public-multiturn" as const, "longmemeval_s:multiturn"],
    ["public-crossquestion" as const, "longmemeval_s:crossquestion"]
  ])("requires release-size coverage before %s can be latest-passing", (benchName, datasetName) => {
    const payload: KpiPayload = {
      ...buildPayload("abc1234"),
      bench_name: benchName,
      split: "longmemeval-s",
      embedding_provider: "none",
      dataset: {
        name: datasetName,
        size: 500,
        source: "fixture"
      },
      sample_size: 100,
      evaluated_count: 100,
      kpi: {
        ...buildPayload("abc1234").kpi,
        r_at_5: 0.95,
        latency_ms_p95: 110,
        quality_metrics: passingQualityMetrics()
      }
    };

    expect(releaseHardGateVerdict(payload)).toBe("ok");
    expect(releaseHardGateAllowsLatestPassing(payload)).toBe(false);
  });

  it.each([
    ["public" as const, "longmemeval_s"],
    ["public-multiturn" as const, "longmemeval_s:multiturn"],
    ["public-crossquestion" as const, "longmemeval_s:crossquestion"]
  ])("allows release-grade %s coverage to be latest-passing", (benchName, datasetName) => {
    const payload: KpiPayload = {
      ...buildPayload("abc1234"),
      bench_name: benchName,
      split: "longmemeval-s",
      embedding_provider: "none",
      dataset: {
        name: datasetName,
        size: 500,
        source: "fixture"
      },
      sample_size: 500,
      evaluated_count: 500,
      kpi: {
        ...buildPayload("abc1234").kpi,
        r_at_5: 0.95,
        latency_ms_p95: 110,
        quality_metrics: passingQualityMetrics()
      }
    };

    expect(releaseHardGateAllowsLatestPassing(payload)).toBe(true);
  });

  it("allows release-grade LoCoMo coverage to be latest-passing", () => {
    const payload = buildLocomoPayload(1982, 1982, 0.56);

    expect(collectReleaseHardGates(payload).length).toBeGreaterThan(0);
    expect(collectReleaseHardGates(payload).every((gate) => gate.passed)).toBe(true);
    expect(releaseHardGateAllowsLatestPassing(payload)).toBe(true);
  });

  it("does not treat a live strict-real payload alone as latest-passing proof", () => {
    const payload: KpiPayload = {
      ...buildPayload("abc1234"),
      bench_name: "live",
      split: "strict-real",
      dataset: {
        name: "alaya-live-strict-real",
        size: 500,
        source: ".do-it/checks/alaya-live/main-check.json#run-1"
      },
      sample_size: 500,
      evaluated_count: 500,
      harness_mode: "live_strict_real"
    };

    expect(collectReleaseHardGates(payload)).toEqual([]);
    expect(releaseHardGateVerdict(payload)).toBe("ok");
    expect(releaseHardGateAllowsLatestPassing(payload)).toBe(false);
  });

  it("does not require release hard gates for self archives", () => {
    const payload = buildPayload("def5678");

    expect(collectReleaseHardGates(payload)).toEqual([]);
    expect(releaseHardGateVerdict(payload)).toBe("ok");
    expect(releaseHardGateAllowsLatestPassing(payload)).toBe(true);
  });
});
