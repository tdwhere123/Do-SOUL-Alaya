import {
  RecallCandidateSchema,
  type FineAssessmentConfig,
  type MemoryDimension as MemoryDimensionType,
  type RecallBudgetState,
  type RecallCandidate,
  type RecallScoreFactors,
  type SynthesisCapsule
} from "@do-soul/alaya-protocol";
import {
  assignManifestation,
  clamp01,
  createContentPreview,
  estimateTokens,
  normalizeActivationScore
} from "./recall-service-helpers.js";
import type { CoarseRecallCandidate, TokenEstimator } from "./recall-service-types.js";

export interface BuildRecallCandidateInput {
  readonly candidate: Readonly<CoarseRecallCandidate>;
  readonly relevanceScore: number;
  readonly scoreFactors: Readonly<RecallScoreFactors>;
  readonly tokenEstimator: TokenEstimator;
  readonly tokenEstimate?: number;
  readonly budgets: Readonly<FineAssessmentConfig["budgets"]>;
  readonly index: number;
  readonly usedTokensBeforeCandidate: number;
  readonly extraSourceChannel?: string;
}

export function buildRecallCandidate(input: BuildRecallCandidateInput): Readonly<RecallCandidate> {
  const entry = input.candidate.entry;
  const activationScore = normalizeActivationScore(entry.activation_score);
  const manifestation = assignManifestation(activationScore);
  const tokenEstimate = input.tokenEstimate ?? estimateTokens(entry.content, input.tokenEstimator);

  return RecallCandidateSchema.parse({
    object_id: entry.object_id,
    // A synthesis-derived candidate carries object_kind synthesis_capsule;
    // its CoarseRecallCandidate.entry is a synthesis-shaped pseudo memory.
    object_kind: input.candidate.objectKind ?? ("memory_entry" as const),
    activation_score: activationScore,
    relevance_score: input.relevanceScore,
    content_preview: createContentPreview(entry.content, manifestation, input.candidate.originPlane),
    token_estimate: tokenEstimate,
    manifestation,
    dimension: entry.dimension,
    scope_class: entry.scope_class,
    selection_reason: buildSelectionReason(input.scoreFactors, input.candidate.originPlane),
    source_channels: buildSourceChannels(input.candidate, input.scoreFactors, input.extraSourceChannel),
    score_factors: input.scoreFactors,
    budget_state: buildRecallBudgetState({
      tokenEstimate,
      maxEntries: input.budgets.max_entries,
      maxTotalTokens: input.budgets.max_total_tokens,
      index: input.index,
      usedTokensBeforeCandidate: input.usedTokensBeforeCandidate
    }),
    ...(input.candidate.originPlane === undefined ? {} : { origin_plane: input.candidate.originPlane }),
    ...(input.candidate.isAdvisory === undefined ? {} : { is_advisory: input.candidate.isAdvisory })
  });
}

/**
 * Merge additive (synthesis) candidates into the fused memory delivery
 * list by `relevance_score`, then re-apply the delivery budget.
 *
 * Each additive candidate is spliced in before the first base candidate
 * whose `relevance_score` is lower — the base candidates keep their
 * relative fusion+rerank order, while an additive candidate lands at a
 * relevance-appropriate position. `selectCandidatesWithinBudgets` then
 * re-cuts to `max_entries` / `max_total_tokens` / per-dimension limits, so
 * a high-relevance additive candidate displaces a weak tail base candidate
 * out of the delivery window and a weak one is cut itself. A no-op
 * (returns the base list unchanged) when there are no additive candidates.
 */
export function mergeAdditiveCandidatesByRelevanceScore(
  baseCandidates: readonly Readonly<RecallCandidate>[],
  additiveCandidates: readonly Readonly<RecallCandidate>[],
  config: Readonly<FineAssessmentConfig>
): readonly Readonly<RecallCandidate>[] {
  if (additiveCandidates.length === 0) {
    return baseCandidates;
  }

  const merged: Readonly<RecallCandidate>[] = [...baseCandidates];
  for (const additive of additiveCandidates) {
    let insertAt = merged.length;
    for (let i = 0; i < merged.length; i += 1) {
      const base = merged[i];
      if (base !== undefined && base.relevance_score < additive.relevance_score) {
        insertAt = i;
        break;
      }
    }
    merged.splice(insertAt, 0, additive);
  }

  return selectCandidatesWithinBudgets(merged, config);
}

export interface SynthesisRecallCandidateInput {
  readonly synthesis: Readonly<SynthesisCapsule>;
  readonly normalizedRank: number;
  readonly tokenEstimator: TokenEstimator;
  readonly budgets: Readonly<FineAssessmentConfig["budgets"]>;
}

/**
 * Damping applied to a synthesis candidate's FTS relevance before it
 * competes for a delivery slot. The synthesis FTS normalized rank and the
 * memory fusion+rerank `relevance_score` are different scales; damping
 * places a synthesis candidate in the memory mid-range so a strong one
 * competes for a slot without automatically out-ranking memory, and a weak
 * one is cut. Single tunable constant — the bench loop sweeps it.
 */
const SYNTHESIS_RELEVANCE_DAMPING = 0.86;

/**
 * Build a delivered RecallCandidate from an L2 synthesis_capsule FTS hit.
 *
 * A synthesis candidate is an additional recall source — it joins the fused
 * memory_entry result through mergeAdditiveCandidatesByRelevanceScore,
 * never a new fusion stream. Its content is the synthesis `summary`; its
 * `relevance_score` is the damped synthesis FTS normalized rank; it is
 * delivered with object_kind `synthesis_capsule`. Dimension `episode`
 * matches the L2 aggregate-observation shape (synthesis_capsule has no
 * MemoryDimension of its own); scope `project` matches the bench /
 * consolidation seed scope.
 */
export function buildSynthesisRecallCandidate(
  input: SynthesisRecallCandidateInput
): Readonly<RecallCandidate> {
  const ftsRelevance = clamp01(input.normalizedRank);
  const relevance = ftsRelevance * SYNTHESIS_RELEVANCE_DAMPING;
  const summary = input.synthesis.summary;
  const tokenEstimate = estimateTokens(summary, input.tokenEstimator);
  // Manifestation tracks the undamped FTS relevance so a strong-keyword
  // synthesis is delivered at full content rather than gated to a hint.
  const manifestation = assignManifestation(ftsRelevance);
  return RecallCandidateSchema.parse({
    object_id: input.synthesis.object_id,
    object_kind: "synthesis_capsule" as const,
    activation_score: ftsRelevance,
    relevance_score: relevance,
    content_preview: createContentPreview(summary, manifestation),
    token_estimate: tokenEstimate,
    manifestation,
    dimension: "episode" as const,
    scope_class: "project" as const,
    selection_reason: `Selected by synthesis recall; FTS relevance ${ftsRelevance.toFixed(3)}.`,
    source_channels: Object.freeze(["ranked_recall", "workspace_local", "synthesis_fts"]),
    budget_state: buildRecallBudgetState({
      tokenEstimate,
      maxEntries: input.budgets.max_entries,
      maxTotalTokens: input.budgets.max_total_tokens,
      index: input.budgets.max_entries,
      usedTokensBeforeCandidate: 0
    })
  });
}

export function selectCandidatesWithinBudgets(
  candidates: readonly Readonly<RecallCandidate>[],
  config: Readonly<FineAssessmentConfig>
): readonly Readonly<RecallCandidate>[] {
  const selected: Readonly<RecallCandidate>[] = [];
  const seen = new Set<string>();
  const perDimensionCounts = new Map<MemoryDimensionType, number>();
  let totalTokens = 0;

  for (const candidate of candidates) {
    const candidateKey = buildRecallCandidateSelectionKey(candidate);
    if (seen.has(candidateKey)) {
      continue;
    }

    const dimensionCount = perDimensionCounts.get(candidate.dimension) ?? 0;
    const dimensionLimit = config.budgets.per_dimension_limits?.[candidate.dimension] ?? null;
    const nextEntryCount = selected.length + 1;
    const nextTokenCount = totalTokens + candidate.token_estimate;

    if (dimensionLimit !== null && dimensionCount >= dimensionLimit) {
      continue;
    }

    if (
      nextEntryCount > config.budgets.max_entries ||
      nextTokenCount > config.budgets.max_total_tokens
    ) {
      continue;
    }

    selected.push(candidate);
    seen.add(candidateKey);
    perDimensionCounts.set(candidate.dimension, dimensionCount + 1);
    totalTokens = nextTokenCount;
  }

  return Object.freeze(selected);
}

function buildRecallCandidateSelectionKey(candidate: Readonly<RecallCandidate>): string {
  return `${candidate.origin_plane ?? "workspace_local"}:${candidate.object_id}`;
}

export function rebuildRecallBudgetStateForDelivery(
  candidates: readonly Readonly<RecallCandidate>[],
  config: Readonly<FineAssessmentConfig>
): readonly Readonly<RecallCandidate>[] {
  let usedTokensBeforeCandidate = 0;

  return Object.freeze(
    candidates.map((candidate, index) => {
      const tokenEstimate = candidate.token_estimate;
      const rebuilt = RecallCandidateSchema.parse({
        ...candidate,
        budget_state: buildRecallBudgetState({
          tokenEstimate,
          maxEntries: config.budgets.max_entries,
          maxTotalTokens: config.budgets.max_total_tokens,
          index,
          usedTokensBeforeCandidate
        })
      });

      usedTokensBeforeCandidate += tokenEstimate;
      return rebuilt;
    })
  );
}

export function buildRecallBudgetState(params: Readonly<{
  readonly tokenEstimate: number;
  readonly maxEntries: number;
  readonly maxTotalTokens: number;
  readonly index: number;
  readonly usedTokensBeforeCandidate: number;
}>): Readonly<RecallBudgetState> {
  const usedTokensThroughCandidate = params.usedTokensBeforeCandidate + params.tokenEstimate;

  return Object.freeze({
    token_estimate: params.tokenEstimate,
    max_entries: params.maxEntries,
    max_total_tokens: params.maxTotalTokens,
    remaining_entries: Math.max(params.maxEntries - params.index - 1, 0),
    remaining_tokens: Math.max(params.maxTotalTokens - usedTokensThroughCandidate, 0),
    within_budget: params.index < params.maxEntries && usedTokensThroughCandidate <= params.maxTotalTokens
  });
}

function buildSelectionReason(
  factors: Readonly<RecallScoreFactors>,
  originPlane: CoarseRecallCandidate["originPlane"]
): string {
  const origin = originPlane === "global" ? "global recall" : "workspace recall";
  const supports: string[] = [`activation ${factors.activation.toFixed(3)}`];
  if ((factors.graph_support ?? 0) > 0) {
    supports.push(`graph support ${factors.graph_support?.toFixed(3)}`);
  }
  if ((factors.path_plasticity ?? 0) > 0) {
    supports.push(`path plasticity ${factors.path_plasticity?.toFixed(3)}`);
  }
  if ((factors.embedding_similarity ?? 0) > 0) {
    supports.push(`embedding similarity ${factors.embedding_similarity?.toFixed(3)}`);
  }
  if ((factors.budget_penalty ?? 0) > 0) {
    supports.push(`budget penalty ${factors.budget_penalty?.toFixed(3)}`);
  }

  return `Selected by ${origin}; score ${factors.relevance.toFixed(3)} from ${supports.join(", ")}.`;
}

function buildSourceChannels(
  candidate: Readonly<CoarseRecallCandidate>,
  factors: Readonly<RecallScoreFactors>,
  extraChannel?: string
): readonly string[] {
  const channels = new Set<string>(["ranked_recall", candidate.originPlane ?? "workspace_local"]);
  if ((factors.graph_support ?? 0) > 0) {
    channels.add("graph_support");
  }
  if ((factors.path_plasticity ?? 0) > 0) {
    channels.add("path_plasticity");
  }
  if ((factors.embedding_similarity ?? 0) > 0 || extraChannel !== undefined) {
    channels.add(extraChannel ?? "semantic_supplement");
  }
  if (candidate.sourceChannel !== undefined) {
    channels.add(candidate.sourceChannel);
  }
  for (const channel of candidate.sourceChannels ?? []) {
    channels.add(channel);
  }
  for (const plane of candidate.admissionPlanes ?? []) {
    channels.add(`plane:${plane}`);
  }
  if (candidate.isAdvisory === true) {
    channels.add("advisory");
  }

  return Object.freeze([...channels]);
}
