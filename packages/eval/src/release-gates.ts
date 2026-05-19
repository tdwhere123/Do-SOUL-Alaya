import type { KpiPayload, QualityMetrics, Verdict } from "./kpi-schema.js";
import { rollupWorstVerdict } from "./thresholds.js";

export interface BenchmarkHardGate {
  readonly id: string;
  readonly label: string;
  readonly current: number | null;
  readonly target: number;
  readonly direction: "min" | "max";
  readonly unit: "ratio" | "count" | "ms";
  readonly passed: boolean;
  readonly missing: boolean;
}

export function collectReleaseHardGates(
  current: KpiPayload
): readonly BenchmarkHardGate[] {
  const gates: BenchmarkHardGate[] = [];
  gates.push(...collectRecallQualityGates(current));
  gates.push(...collectPipelineIntegrityGates(current));
  return gates;
}

export function releaseHardGateVerdict(current: KpiPayload): Verdict {
  return collectReleaseHardGates(current).some((gate) => !gate.passed)
    ? "fail"
    : "ok";
}

export function combineVerdicts(...verdicts: readonly Verdict[]): Verdict {
  return rollupWorstVerdict(verdicts);
}

function collectRecallQualityGates(
  current: KpiPayload
): readonly BenchmarkHardGate[] {
  const embeddingEnabled = current.embedding_provider !== "none";
  if (current.bench_name === "public" && current.split === "longmemeval-s") {
    if (!embeddingEnabled && current.evaluated_count === 100) {
      return [
        minGate(
          "longmemeval_s_100_embedding_off_r_at_5",
          "LongMemEval-S 100 embedding-off R@5",
          current.kpi.r_at_5,
          0.7
        )
      ];
    }
    if (embeddingEnabled && current.evaluated_count === 100) {
      return [
        minGate(
          "longmemeval_s_100_embedding_on_r_at_5",
          "LongMemEval-S 100 embedding-on R@5",
          current.kpi.r_at_5,
          0.55
        )
      ];
    }
    if (
      !embeddingEnabled &&
      current.evaluated_count >= current.sample_size &&
      current.sample_size >= 500
    ) {
      return [
        minGate(
          "longmemeval_s_500_embedding_off_r_at_5",
          "LongMemEval-S 500 embedding-off R@5",
          current.kpi.r_at_5,
          0.65
        )
      ];
    }
    if (
      embeddingEnabled &&
      current.evaluated_count >= current.sample_size &&
      current.sample_size >= 500
    ) {
      return [
        minGate(
          "longmemeval_s_500_embedding_on_r_at_5",
          "LongMemEval-S 500 embedding-on R@5",
          current.kpi.r_at_5,
          0.55
        )
      ];
    }
  }

  if (
    current.bench_name === "public-locomo" &&
    current.split === "locomo10" &&
    current.evaluated_count >= current.sample_size &&
    current.sample_size >= 1982
  ) {
    return [
      minGate(
        embeddingEnabled
          ? "locomo_full_embedding_on_r_at_5"
          : "locomo_full_embedding_off_r_at_5",
        embeddingEnabled
          ? "LoCoMo full embedding-on R@5"
          : "LoCoMo full embedding-off R@5",
        current.kpi.r_at_5,
        embeddingEnabled ? 0.5 : 0.35
      )
    ];
  }

  return [];
}

function collectPipelineIntegrityGates(
  current: KpiPayload
): readonly BenchmarkHardGate[] {
  if (!isReleasePublicRecallArchive(current)) return [];

  const embeddingEnabled = current.embedding_provider !== "none";
  const metrics = current.kpi.quality_metrics;
  const gates: BenchmarkHardGate[] = [];
  if (current.bench_name === "public" && current.split === "longmemeval-s") {
    gates.push(
      maxGate(
        "longmemeval_s_non_monotonic_rate",
        "non_monotonic_rate",
        metrics?.non_monotonic_rate ?? null,
        0.1,
        "ratio"
      ),
      maxGate(
        "longmemeval_s_budget_dropped_max_entries",
        "budget_dropped_entries",
        readBudgetDroppedEntries(metrics),
        8,
        "count"
      ),
      maxGate(
        "longmemeval_s_candidate_absent",
        "candidate_absent",
        metrics?.candidate_absent_count ?? null,
        6,
        "count"
      ),
      minGate(
        "longmemeval_s_evidence_stream_gold_delivery",
        "evidence stream gold delivery",
        metrics?.evidence_stream_gold_delivery_rate ?? null,
        0.15,
        "ratio"
      )
    );
    if (current.simulate_report !== "none") {
      gates.push(
        minGate(
          "longmemeval_s_path_stream_top10_contribution",
          "path stream top-10 contribution",
          metrics?.path_stream_top10_rate ?? null,
          0.1,
          "ratio"
        )
      );
    }
  }
  gates.push(
    maxGate(
      embeddingEnabled ? "recall_p95_embedding_on" : "recall_p95_embedding_off",
      embeddingEnabled ? "recall p95 embedding-on" : "recall p95 embedding-off",
      current.kpi.latency_ms_p95,
      embeddingEnabled ? 1100 : 200,
      "ms"
    )
  );
  return gates;
}

function isReleasePublicRecallArchive(current: KpiPayload): boolean {
  if (current.evaluated_count < 100) return false;
  if (current.bench_name === "public" && current.split === "longmemeval-s") {
    return true;
  }
  return (
    current.bench_name === "public-locomo" &&
    current.split === "locomo10" &&
    current.evaluated_count >= current.sample_size &&
    current.sample_size >= 1982
  );
}

function readBudgetDroppedEntries(
  metrics: QualityMetrics | undefined
): number | null {
  if (metrics === undefined) return null;
  return metrics.budget_drop_distribution.max_entries?.count ?? 0;
}

function minGate(
  id: string,
  label: string,
  current: number | null,
  target: number,
  unit: BenchmarkHardGate["unit"] = "ratio"
): BenchmarkHardGate {
  return {
    id,
    label,
    current,
    target,
    direction: "min",
    unit,
    passed: current !== null && current >= target,
    missing: current === null
  };
}

function maxGate(
  id: string,
  label: string,
  current: number | null,
  target: number,
  unit: BenchmarkHardGate["unit"] = "ratio"
): BenchmarkHardGate {
  return {
    id,
    label,
    current,
    target,
    direction: "max",
    unit,
    passed: current !== null && current <= target,
    missing: current === null
  };
}
