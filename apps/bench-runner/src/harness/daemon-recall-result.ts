import { randomUUID } from "node:crypto";
import { buildRecallPolicy as buildRecallPolicyCore } from "@do-soul/alaya-core";
import {
  type MemorySearchResult,
  type RecallBudgetState,
  type RecallCandidate,
  type RecallPolicy,
  type RecallScoreFactors,
  type SoulRecallStrategyMix
} from "@do-soul/alaya-protocol";

export function buildBenchDiagnosticRecallPolicy(
  taskSurfaceId: string,
  maxResultsInput: number,
  conflictAwareness = true
): RecallPolicy {
  const maxResults = Math.max(maxResultsInput, 1);
  // Diagnostic-only delivery token budget. Default 2000 = production口径; a wide
  // override lets a probe deliver the full ranked pool so gold-rank can tell
  // in-pool-ranked-low from absent-from-pool. No fusion-weight change.
  const maxTotalTokens = Math.max(
    2000,
    Math.floor(Number(process.env.ALAYA_BENCH_RECALL_MAX_TOKENS ?? "2000")) || 2000
  );
  // Embedding semantic-injection sweep knobs (embedding-on only). Unset => recall
  // service defaults.
  const rawInjectionCap = Number(
    process.env.ALAYA_BENCH_EMBEDDING_INJECTION_CAP ?? ""
  );
  const embeddingInjectionCap =
    Number.isInteger(rawInjectionCap) && rawInjectionCap >= 0
      ? rawInjectionCap
      : null;
  const rawInjectionFloor = Number(
    process.env.ALAYA_BENCH_EMBEDDING_INJECTION_FLOOR ?? ""
  );
  const embeddingInjectionFloor =
    Number.isFinite(rawInjectionFloor) &&
    rawInjectionFloor >= 0 &&
    rawInjectionFloor <= 1
      ? rawInjectionFloor
      : null;
  return buildRecallPolicyCore({
    runtimeId: randomUUID(),
    taskSurfaceId,
    maxResults,
    filters: {
      scopeFilter: null,
      dimensionFilter: null,
      domainTagFilter: null
    },
    conflictAwareness,
    maxTotalTokens,
    coarseFloor: Number(process.env.ALAYA_RECALL_COARSE_FLOOR) || 0,
    embeddingInjectionCap,
    embeddingInjectionSimilarityFloor: embeddingInjectionFloor
  });
}

export function buildBenchMemorySearchResult(
  candidate: Readonly<RecallCandidate>,
  policy: Readonly<RecallPolicy>,
  index: number,
  usedTokensBeforeCandidate: number
): MemorySearchResult {
  return {
    object_id: candidate.object_id,
    object_kind: candidate.object_kind,
    relevance_score: candidate.relevance_score,
    content_preview: candidate.content_preview,
    evidence_pointers: [candidate.object_id],
    selection_reason: candidate.selection_reason ?? buildBenchSelectionReason(candidate),
    source_channels: candidate.source_channels ?? buildBenchSourceChannels(candidate),
    score_factors: candidate.score_factors ?? buildBenchScoreFactors(candidate),
    budget_state:
      candidate.budget_state ??
      buildBenchBudgetState(candidate, policy, index, usedTokensBeforeCandidate)
  };
}

export function buildBenchRecallStrategyMix(
  policy: Readonly<RecallPolicy>,
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

function buildBenchSelectionReason(candidate: Readonly<RecallCandidate>): string {
  const origin =
    candidate.origin_plane === "global" ? "global recall" : "workspace recall";
  return `Selected by ${origin} with relevance ${candidate.relevance_score.toFixed(3)} and activation ${candidate.activation_score.toFixed(3)}.`;
}

function buildBenchSourceChannels(
  candidate: Readonly<RecallCandidate>
): readonly string[] {
  const channels = ["ranked_recall", candidate.origin_plane] as string[];
  if (candidate.is_advisory === true) {
    channels.push("advisory");
  }
  return channels;
}

function buildBenchScoreFactors(
  candidate: Readonly<RecallCandidate>
): RecallScoreFactors {
  return {
    activation: clampScore(candidate.activation_score),
    relevance: clampScore(candidate.relevance_score)
  };
}

function buildBenchBudgetState(
  candidate: Readonly<RecallCandidate>,
  policy: Readonly<RecallPolicy>,
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
    within_budget:
      index < maxEntries && usedTokensThroughCandidate <= maxTotalTokens
  };
}

function clampScore(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

// @anchor readMaterializedObjects: bridges signal_id -> durable object ids.
// The MCP surface intentionally does not expose materialization side-effects
// (the agent should only know it emitted a signal). The bench harness reads
// the event_log directly, which is the canonical audit-trail record of the
// materialization. Returns the durable memory_entry id (throwing when the
// signal materialized none — a routing fault the bench must surface) plus
// the evidence_capsule id when one was created (null otherwise: not every
// route mints an evidence row). initDatabase caches connections by path so
// this opens the same handle the daemon already uses. Do not close the
// connection here or the daemon will lose its DB.
