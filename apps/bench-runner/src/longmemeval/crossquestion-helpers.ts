import type { BenchSplit } from "@do-soul/alaya-eval";
import type { LongMemEvalVariant } from "./dataset.js";
import type { QuestionResult } from "./crossquestion.js";

export function variantToSplit(variant: LongMemEvalVariant): BenchSplit {
  const map: Record<LongMemEvalVariant, BenchSplit> = {
    longmemeval_oracle: "longmemeval-oracle",
    longmemeval_s: "longmemeval-s",
    longmemeval_m: "longmemeval-m"
  };
  return map[variant];
}

export function countTiers(rows: readonly QuestionResult[]): {
  readonly hot: number;
  readonly warm: number;
  readonly cold: number;
} {
  let hot = 0;
  let warm = 0;
  let cold = 0;
  for (const row of rows) {
    if (row.firstTier === "hot") hot++;
    else if (row.firstTier === "warm") warm++;
    else cold++;
  }
  return { hot, warm, cold };
}

export function countDegradationReasons(rows: readonly QuestionResult[]): {
  readonly none: number;
  readonly warm_cascade_engaged: number;
  readonly cold_cascade_engaged: number;
  readonly recall_explainability_partial: number;
} {
  let none = 0;
  let warm = 0;
  let cold = 0;
  let partial = 0;
  for (const row of rows) {
    if (row.degradationReason === "warm_cascade_engaged") warm++;
    else if (row.degradationReason === "cold_cascade_engaged") cold++;
    else if (row.degradationReason === "recall_explainability_partial") partial++;
    else none++;
  }
  return {
    none,
    warm_cascade_engaged: warm,
    cold_cascade_engaged: cold,
    recall_explainability_partial: partial
  };
}

export function inferTier(relevanceScore: number): "hot" | "warm" | "cold" {
  if (relevanceScore >= 0.7) return "hot";
  if (relevanceScore >= 0.4) return "warm";
  return "cold";
}

export function computePercentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

export function ratio(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}

export function truncateExcerpt(value: string): string {
  return value.length <= 500 ? value : `${value.slice(0, 497)}...`;
}

export function isLongMemEvalGoldEligibleResult(result: Readonly<{
  readonly object_kind?: string | null;
}>): boolean {
  return (result.object_kind ?? "memory_entry") === "memory_entry";
}
