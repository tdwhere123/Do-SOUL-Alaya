import type { BenchSplit } from "@do-soul/alaya-eval";
import type { LongMemEvalVariant } from "../ingestion/dataset.js";
import type { QuestionResult, RoundResult } from "../multiturn.js";

export function variantToSplit(variant: LongMemEvalVariant): BenchSplit {
  const map: Record<LongMemEvalVariant, BenchSplit> = {
    longmemeval_oracle: "longmemeval-oracle",
    longmemeval_s: "longmemeval-s",
    longmemeval_m: "longmemeval-m"
  };
  return map[variant];
}

export function rAt5ForRound(collected: readonly QuestionResult[], roundIndex: number): number {
  const rows = collected
    .map((result) => result.rounds[roundIndex - 1])
    .filter((round): round is RoundResult => round !== undefined);
  return ratio(rows.filter((round) => round.hitAt5).length, rows.length);
}

export function countTiers(rounds: readonly RoundResult[]): {
  readonly hot: number;
  readonly warm: number;
  readonly cold: number;
} {
  let hot = 0;
  let warm = 0;
  let cold = 0;
  for (const round of rounds) {
    if (round.firstTier === "hot") hot++;
    else if (round.firstTier === "warm") warm++;
    else cold++;
  }
  return { hot, warm, cold };
}

export function countDegradationReasons(rounds: readonly RoundResult[]): {
  readonly none: number;
  readonly warm_cascade_engaged: number;
  readonly cold_cascade_engaged: number;
  readonly recall_explainability_partial: number;
} {
  let none = 0;
  let warm = 0;
  let cold = 0;
  let partial = 0;
  for (const round of rounds) {
    if (round.degradationReason === "warm_cascade_engaged") warm++;
    else if (round.degradationReason === "cold_cascade_engaged") cold++;
    else if (round.degradationReason === "recall_explainability_partial") partial++;
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
