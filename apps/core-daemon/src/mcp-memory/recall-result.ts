import type {
  MemorySearchResult,
  RecallBudgetState,
  RecallCandidate,
  RecallPolicy,
  RecallScoreFactors,
  SoulRecallStrategyMix
} from "@do-soul/alaya-protocol";

export function buildMemorySearchResult(
  candidate: Readonly<RecallCandidate>,
  policy: RecallPolicy,
  index: number,
  usedTokensBeforeCandidate: number
): MemorySearchResult {
  const base: MemorySearchResult = {
    object_id: candidate.object_id,
    object_kind: candidate.object_kind,
    relevance_score: candidate.relevance_score,
    content_preview: candidate.content_preview,
    evidence_pointers: [candidate.object_id],
    selection_reason: candidate.selection_reason ?? buildSelectionReason(candidate),
    source_channels: candidate.source_channels ?? buildSourceChannels(candidate),
    score_factors: buildScoreFactors(candidate),
    budget_state: candidate.budget_state ?? buildBudgetState(candidate, policy, index, usedTokensBeforeCandidate),
    ...(candidate.pending_incomplete === undefined ? {} : { pending_incomplete: candidate.pending_incomplete }),
    ...(candidate.unfinishedness_bias === undefined ? {} : { unfinishedness_bias: candidate.unfinishedness_bias })
  };
  if (candidate.staged_warnings !== undefined && candidate.staged_warnings.length > 0) {
    return {
      ...base,
      staged_warnings: candidate.staged_warnings.map((warning) => ({
        target_object_id: candidate.object_id,
        ...warning
      }))
    };
  }
  return base;
}

export function buildRecallStrategyMix(
  policy: RecallPolicy,
  results: readonly Readonly<MemorySearchResult>[]
): SoulRecallStrategyMix {
  return {
    deterministic_match: true,
    precomputed_rank: policy.coarse_filter.precomputed_rank.max_candidates > 0,
    semantic_supplement: results.some(
      (result) =>
        result.source_channels.includes("semantic_supplement") ||
        result.score_factors.embedding_similarity !== undefined
    ),
    graph_support: results.some(
      (result) =>
        result.source_channels.includes("graph_support") ||
        (result.score_factors.graph_support ?? 0) > 0
    ),
    path_plasticity: results.some(
      (result) =>
        result.source_channels.includes("path_plasticity") ||
        (result.score_factors.path_plasticity ?? 0) > 0
    ),
    global_recall: results.some((result) => result.source_channels.includes("global"))
  };
}

function buildSelectionReason(candidate: Readonly<RecallCandidate>): string {
  const origin = candidate.origin_plane === "global" ? "global recall" : "workspace recall";
  return `Selected by ${origin}. Final fusion evidence score ` +
    `${candidate.relevance_score.toFixed(6)}; diagnostic supporting signal: ` +
    `activation ${candidate.activation_score.toFixed(3)}.`;
}

function buildSourceChannels(candidate: Readonly<RecallCandidate>): readonly string[] {
  const channels = ["ranked_recall", candidate.origin_plane] as string[];
  if (candidate.is_advisory === true) {
    channels.push("advisory");
  }
  return channels;
}

function buildScoreFactors(candidate: Readonly<RecallCandidate>): RecallScoreFactors {
  return {
    ...candidate.score_factors,
    activation: clampScore(candidate.activation_score),
    relevance: clampScore(candidate.relevance_score)
  };
}

function buildBudgetState(
  candidate: Readonly<RecallCandidate>,
  policy: RecallPolicy,
  index: number,
  usedTokensBeforeCandidate: number
): RecallBudgetState {
  const maxEntries = policy.fine_assessment.budgets.max_entries;
  const maxTotalTokens = policy.fine_assessment.budgets.max_total_tokens;
  const usedTokensThroughCandidate = usedTokensBeforeCandidate + candidate.token_estimate;

  return {
    token_estimate: candidate.token_estimate,
    max_entries: maxEntries,
    max_total_tokens: maxTotalTokens,
    remaining_entries: Math.max(maxEntries - index - 1, 0),
    remaining_tokens: Math.max(maxTotalTokens - usedTokensThroughCandidate, 0),
    within_budget: index < maxEntries && usedTokensThroughCandidate <= maxTotalTokens
  };
}

function clampScore(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}
