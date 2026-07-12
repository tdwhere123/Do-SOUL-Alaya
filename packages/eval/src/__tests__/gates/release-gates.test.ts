import { expect, it } from "vitest";
import type { KpiPayload } from "../../schema/kpi-schema.js";
import {
  collectReleaseHardGates,
  releaseHardGateAllowsLatestPassing,
  releaseHardGateVerdict
} from "../../gates/release-gates.js";
import {
  buildLimitedTier1Payload,
  buildLocomoPayload,
  buildPayload,
  passingQualityMetrics
} from "./release-gates-fixture.js";

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

it("does not require measurement attribution for non-LongMemEval legacy payloads", () => {
  expect(releaseHardGateAllowsLatestPassing(buildPayload("abc1234"))).toBe(true);
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
      source: "var/checks/alaya-live/main-check.json#run-1"
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

it("gates LongMemEval budget drops by share while retaining count details", () => {
  const metrics = passingQualityMetrics(500);
  metrics.budget_drop_distribution.max_entries = {
    count: 9,
    share: 9 / 500,
    denominator: 500
  };
  const payload = buildBudgetGatePayload(metrics);
  const gate = collectReleaseHardGates(payload).find((item) =>
    item.id.includes("budget_dropped")
  );

  expect(gate).toMatchObject({
    id: "longmemeval_s_budget_dropped_rate",
    label: "budget_dropped_share (9/500 max_entries)",
    current: 9 / 500,
    target: 0.02,
    unit: "ratio",
    passed: true
  });
});

it("fails LongMemEval budget drops when the share exceeds the rate target", () => {
  const metrics = passingQualityMetrics(500);
  metrics.budget_drop_distribution.max_entries = {
    count: 11,
    share: 11 / 500,
    denominator: 500
  };
  const gate = collectReleaseHardGates(buildBudgetGatePayload(metrics)).find((item) =>
    item.id.includes("budget_dropped")
  );

  expect(gate).toMatchObject({
    id: "longmemeval_s_budget_dropped_rate",
    label: "budget_dropped_share (11/500 max_entries)",
    current: 11 / 500,
    target: 0.02,
    unit: "ratio",
    passed: false
  });
});

function buildBudgetGatePayload(
  metrics: NonNullable<KpiPayload["kpi"]["quality_metrics"]>
): KpiPayload {
  const base = buildPayload("abc1234");
  return {
    ...base,
    bench_name: "public",
    split: "longmemeval-s",
    sample_size: 500,
    evaluated_count: 500,
    kpi: {
      ...base.kpi,
      r_at_5: 0.95,
      latency_ms_p95: 110,
      quality_metrics: metrics
    }
  };
}
