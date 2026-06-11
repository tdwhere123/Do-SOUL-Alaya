import {
  RecallCandidateSchema,
  type ManifestationState,
  type MemoryDimension as MemoryDimensionType,
  type MemoryEntry,
  type FineAssessmentConfig,
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
import { clampManifestationByGovernance } from "./path-graph/path-manifestation-policy.js";
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
  // invariant: governance ceiling on manifestation derived from the memory's
  // inbound recall-eligible PathRelations. Absent => unrestricted
  // (full_eligible). The ceiling only LOWERS the strength tier, never elevates.
  // see also: path-manifestation-policy.ts memoryGovernanceCeiling.
  readonly governanceCeiling?: ManifestationState;
}

export function buildRecallCandidate(input: BuildRecallCandidateInput): Readonly<RecallCandidate> {
  const entry = input.candidate.entry;
  const activationScore = normalizeActivationScore(entry.activation_score);
  const strengthTier = assignManifestation(activationScore);
  const manifestation = clampManifestationByGovernance(
    strengthTier,
    input.governanceCeiling ?? "full_eligible"
  );
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

export interface SynthesisCoarseRecallCandidateInput {
  readonly synthesis: Readonly<SynthesisCapsule>;
  readonly normalizedRank: number;
}

/**
 * Delivered-content cap for a synthesis_capsule recall candidate. A
 * synthesis summary is an L2 aggregate that can run long; recall delivers a
 * bounded preview, not the whole digest, so a reserved synthesis slot costs
 * a memory-entry-comparable share of the delivery token budget. FTS still
 * indexes the full summary (migration 079) — only the delivered excerpt is
 * clipped.
 */
const SYNTHESIS_RECALL_PREVIEW_CHARS = 600;

function clipSynthesisSummary(summary: string): string {
  const trimmed = summary.trim();
  return trimmed.length > SYNTHESIS_RECALL_PREVIEW_CHARS
    ? `${trimmed.slice(0, SYNTHESIS_RECALL_PREVIEW_CHARS).trimEnd()}…`
    : trimmed;
}

export function buildSynthesisCoarseRecallCandidate(
  input: SynthesisCoarseRecallCandidateInput
): Readonly<CoarseRecallCandidate> {
  const relevance = clamp01(input.normalizedRank);
  // invariant: a synthesis_capsule is shaped into a MemoryEntry only so it can
  // ride the shared coarse->fusion candidate pipeline. dimension/source_kind/
  // formation_kind/scope_class are NOT true synthesis ontology — they are the
  // schema-valid placeholders that let RecallCandidateSchema parse. Callers
  // MUST branch on objectKind === "synthesis_capsule", never trust these
  // fields. scoreRecallFusionStream enforces this (synthesis scores only on
  // synthesis_fts); any new consumer of CoarseRecallCandidate.entry must do
  // the same. see also: packages/core/src/recall/fusion-delivery.ts:scoreRecallFusionStream
  const entry: MemoryEntry = {
    object_id: input.synthesis.object_id,
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: input.synthesis.lifecycle_state,
    created_at: input.synthesis.created_at,
    updated_at: input.synthesis.updated_at,
    created_by: input.synthesis.created_by,
    dimension: "episode" as const,
    source_kind: "compiler" as const,
    formation_kind: "derived" as const,
    scope_class: "project" as const,
    content: clipSynthesisSummary(input.synthesis.summary),
    domain_tags: Object.freeze(["synthesis", input.synthesis.topic_key]),
    evidence_refs: Object.freeze([...input.synthesis.evidence_refs]),
    workspace_id: input.synthesis.workspace_id,
    run_id: input.synthesis.run_id,
    surface_id: null,
    storage_tier: "hot" as const,
    activation_score: relevance,
    retention_score: null,
    manifestation_state: null,
    retention_state: null,
    decay_profile: null,
    confidence: null,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: null,
    contradiction_count: null,
    superseded_by: null
  };

  return Object.freeze({
    entry,
    objectKind: "synthesis_capsule" as const,
    originPlane: "workspace_local" as const,
    sourceChannel: "synthesis_fts",
    sourceChannels: Object.freeze(["synthesis_fts"]),
    admissionPlanes: Object.freeze(["lexical" as const]),
    firstAdmissionPlane: "lexical" as const,
    structuralScore: 0
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
  return `${candidate.origin_plane ?? "workspace_local"}:${candidate.object_kind}:${candidate.object_id}`;
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
