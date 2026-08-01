import type {
  RecallCandidate,
  RecallPolicy
} from "@do-soul/alaya-protocol";
import {
  buildRecallBudgetState,
  buildRecallCandidateSelectionKey
} from "../../runtime/recall-candidate-builder.js";
import type { RecallCandidateDiagnostic } from
  "../../runtime/recall-service-types.js";

export function materializeFinalPacket(
  candidates: readonly Readonly<RecallCandidate>[],
  diagnostics: readonly Readonly<RecallCandidateDiagnostic>[],
  budgets: Readonly<RecallPolicy>["fine_assessment"]["budgets"]
): Readonly<{
  readonly candidates: readonly Readonly<RecallCandidate>[];
  readonly diagnostics: readonly Readonly<RecallCandidateDiagnostic>[];
}> {
  let usedTokens = 0;
  const finalRankByKey = new Map<string, number>();
  const ranked = candidates.map((candidate, index) => {
    finalRankByKey.set(buildRecallCandidateSelectionKey(candidate), index + 1);
    const budgetState = buildRecallBudgetState({
      tokenEstimate: candidate.token_estimate,
      maxEntries: budgets.max_entries,
      maxTotalTokens: budgets.max_total_tokens,
      index,
      usedTokensBeforeCandidate: usedTokens
    });
    usedTokens += candidate.token_estimate;
    return Object.freeze({ ...candidate, budget_state: budgetState });
  });
  return Object.freeze({
    candidates: Object.freeze(ranked),
    diagnostics: updateFinalRanks(diagnostics, finalRankByKey)
  });
}

function updateFinalRanks(
  diagnostics: readonly Readonly<RecallCandidateDiagnostic>[],
  finalRankByKey: ReadonlyMap<string, number>
): readonly Readonly<RecallCandidateDiagnostic>[] {
  return Object.freeze(diagnostics.map((row) => {
    const finalRank = finalRankByKey.get(row.candidate_key) ?? null;
    return Object.freeze({ ...row, final_rank: finalRank, post_rank: finalRank });
  }));
}
