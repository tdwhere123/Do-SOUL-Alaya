import {
  RecallCandidateSchema,
  type FineAssessmentConfig,
  type MemoryDimension as MemoryDimensionType,
  type RecallBudgetState,
  type RecallCandidate,
  type RecallScoreFactors
} from "@do-soul/alaya-protocol";
import {
  assignManifestation,
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
    object_kind: "memory_entry" as const,
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

export function appendAdditiveCandidatesWithinRemainingBudgets(
  baseCandidates: readonly Readonly<RecallCandidate>[],
  additiveCandidates: readonly Readonly<RecallCandidate>[],
  config: Readonly<FineAssessmentConfig>
): readonly Readonly<RecallCandidate>[] {
  if (additiveCandidates.length === 0) {
    return baseCandidates;
  }

  const selected = [...baseCandidates];
  const perDimensionCounts = new Map<MemoryDimensionType, number>();
  let totalTokens = 0;

  for (const candidate of baseCandidates) {
    const dimensionCount = perDimensionCounts.get(candidate.dimension) ?? 0;
    perDimensionCounts.set(candidate.dimension, dimensionCount + 1);
    totalTokens += candidate.token_estimate;
  }

  for (const candidate of additiveCandidates) {
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
    perDimensionCounts.set(candidate.dimension, dimensionCount + 1);
    totalTokens = nextTokenCount;
  }

  return Object.freeze(selected);
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
  if (candidate.isAdvisory === true) {
    channels.add("advisory");
  }

  return Object.freeze([...channels]);
}
