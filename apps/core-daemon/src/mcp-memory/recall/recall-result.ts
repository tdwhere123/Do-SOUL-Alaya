import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  MILLIGRADE_TOP,
  type InformationIndex,
  type MemorySearchResult,
  type RecallBudgetState,
  type RecallCandidate,
  type RecallPolicy,
  type RecallScoreFactors,
  type SoulMemorySearchDegradationReason,
  type SoulRecallStrategyMix
} from "@do-soul/alaya-protocol";
import { mapEmbeddingProviderDiagnosticToMcpReason } from "@do-soul/alaya-core";

/** Diagnostics slice needed for honest MCP strategy_mix / degradation_reason. */
export type RecallMcpHonestyDiagnostics = Readonly<{
  readonly embedding_supplement_status?: string;
  readonly embedding_provider_status?: string;
  readonly provider_degradation_reason?: string | null;
}>;

export function unavailableIndex(): InformationIndex {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    query_id: "unavailable",
    snapshot_id: `sha256:${"0".repeat(64)}`,
    result_version: "v1",
    entries: [],
    completeness: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      logical_index: "unavailable",
      observed_coverage: "unavailable",
      transport: "unavailable",
      payload: "unavailable",
      representation: "unavailable"
    },
    continuation: null,
    representation: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      policy: "construct_index_then_page_then_payload",
      page_budget: 0,
      identity_tie_break: "serialization"
    }
  };
}

export function encodeIndexResults(
  index: InformationIndex,
  previews: ReadonlyMap<string, string> = new Map()
): readonly MemorySearchResult[] {
  return index.entries.map((entry, offset) => {
    const score = entry.association_milligrades / MILLIGRADE_TOP;
    return {
      object_id: entry.object_id,
      object_kind: "memory_entry",
      relevance_score: score,
      content_preview: previews.get(entry.object_id) ?? "[payload omitted]",
      evidence_pointers: entry.explanation_ids.length > 0 ? entry.explanation_ids : [entry.object_id],
      selection_reason: `Associated at ${entry.association_milligrades} milligrades; claim ${entry.claim}.`,
      source_channels: ["conditional_field"],
      score_factors: { activation: score, relevance: score },
      budget_state: {
        token_estimate: 1,
        max_entries: index.representation.page_budget,
        max_total_tokens: 2_000,
        remaining_entries: Math.max(0, index.representation.page_budget - offset - 1),
        remaining_tokens: 2_000,
        within_budget: true
      }
    };
  });
}

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

export function selectRecallMcpHonestyDiagnostics(
  diagnostics: RecallMcpHonestyDiagnostics | null | undefined
): RecallMcpHonestyDiagnostics | null {
  if (diagnostics === undefined || diagnostics === null) {
    return null;
  }
  return {
    ...(diagnostics.embedding_supplement_status === undefined
      ? {}
      : { embedding_supplement_status: diagnostics.embedding_supplement_status }),
    ...(diagnostics.embedding_provider_status === undefined
      ? {}
      : { embedding_provider_status: diagnostics.embedding_provider_status }),
    ...(diagnostics.provider_degradation_reason === undefined
      ? {}
      : { provider_degradation_reason: diagnostics.provider_degradation_reason })
  };
}

export function buildRecallStrategyMix(
  policy: RecallPolicy,
  results: readonly Readonly<MemorySearchResult>[],
  diagnostics?: RecallMcpHonestyDiagnostics | null
): SoulRecallStrategyMix {
  return {
    deterministic_match: true,
    precomputed_rank: policy.coarse_filter.precomputed_rank.max_candidates > 0,
    // Only when the embedding supplement path was actually requested.
    semantic_supplement: diagnostics?.embedding_supplement_status === "requested",
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

export function resolveMcpDegradationReason(
  recallResult: Readonly<{
    readonly degradation_reason?: SoulMemorySearchDegradationReason | null;
    readonly diagnostics?: RecallMcpHonestyDiagnostics | null;
  }>,
  explainabilityPartial: boolean
): SoulMemorySearchDegradationReason | null {
  if (recallResult.degradation_reason !== undefined && recallResult.degradation_reason !== null) {
    return recallResult.degradation_reason;
  }
  const embeddingReason = mapEmbeddingDegradationReason(recallResult.diagnostics);
  if (embeddingReason !== null) {
    return embeddingReason;
  }
  return explainabilityPartial ? "recall_explainability_partial" : null;
}

function mapEmbeddingDegradationReason(
  diagnostics: RecallMcpHonestyDiagnostics | null | undefined
): SoulMemorySearchDegradationReason | null {
  if (diagnostics === undefined || diagnostics === null) {
    return null;
  }
  if (diagnostics.embedding_supplement_status === "provider_missing") {
    return "provider_missing";
  }
  const mappedProviderReason = mapProviderDegradationReason(
    diagnostics.provider_degradation_reason
  );
  // Intentional embedding-off: do not invent unavailable from warmup/pending.
  if (diagnostics.embedding_supplement_status === "disabled") {
    return isHardEmbeddingFailureReason(mappedProviderReason) ? mappedProviderReason : null;
  }
  if (mappedProviderReason !== null) {
    return mappedProviderReason;
  }
  if (
    diagnostics.embedding_provider_status === "provider_failed" ||
    diagnostics.embedding_provider_status === "query_embedding_unusable"
  ) {
    return "provider_failed";
  }
  if (diagnostics.embedding_provider_status === "provider_pending") {
    return "provider_unavailable";
  }
  return null;
}

function mapProviderDegradationReason(
  reason: string | null | undefined
): SoulMemorySearchDegradationReason | null {
  return mapEmbeddingProviderDiagnosticToMcpReason(reason);
}

function isHardEmbeddingFailureReason(
  reason: SoulMemorySearchDegradationReason | null
): reason is SoulMemorySearchDegradationReason {
  return (
    reason === "provider_failed" ||
    reason === "provider_missing" ||
    reason === "no_stored_vectors"
  );
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
