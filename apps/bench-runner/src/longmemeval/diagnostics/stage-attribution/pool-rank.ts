import type { LongMemEvalGoldDiagnostic } from "../schema/diagnostics-types.js";

/** Mirrors quality `classifyBestGoldRank` pool rank: pre_budget_rank ?? fused_rank. */
export function goldPoolRank(gold: LongMemEvalGoldDiagnostic): number | null {
  return gold.pre_budget_rank ?? gold.fused_rank;
}

export function bestGoldPoolRank(
  golds: readonly LongMemEvalGoldDiagnostic[]
): number | null {
  let best: number | null = null;
  for (const gold of golds) {
    const rank = goldPoolRank(gold);
    if (rank !== null && (best === null || rank < best)) best = rank;
  }
  return best;
}

/**
 * KPI bucket `pre_budget_6_10`: answerable miss whose best pool rank is ≤10
 * (includes ranks 1–5 that failed delivery top-5).
 */
export function isKpiPreBudget610Opportunity(input: {
  readonly hitAt5: boolean;
  readonly golds: readonly LongMemEvalGoldDiagnostic[];
}): boolean {
  if (input.hitAt5) return false;
  if (input.golds.length === 0) return false;
  const best = bestGoldPoolRank(input.golds);
  return best !== null && best <= 10;
}

export function isRankBucketCandidateAbsent(
  golds: readonly LongMemEvalGoldDiagnostic[]
): boolean {
  return golds.length > 0 && bestGoldPoolRank(golds) === null;
}
