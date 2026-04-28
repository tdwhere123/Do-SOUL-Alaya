import {
  buildExclusion,
  buildStructuredContribution,
  clampUnit,
  createCandidate,
  evaluateRecordEligibility,
  recordMap,
  roundScore
} from "./shared.js";
import type {
  ApplyEmbeddingSupplementInput,
  EmbeddingProviderState,
  RecallCandidate,
  RecallDegradation,
  RecallExclusion,
  RecallMergeResult,
  RecallRouteContribution
} from "./types.js";

export function applyEmbeddingSupplement(input: ApplyEmbeddingSupplementInput): RecallMergeResult {
  const baseline = Object.freeze([...input.baseline]);
  const fallbackCandidateCount = baseline.length;
  const gateDegradation = embeddingGateDegradation(input.embedding.provider_state, input.embedding.enabled, fallbackCandidateCount);
  if (gateDegradation !== null) {
    return {
      candidates: baseline,
      exclusions: Object.freeze([]),
      degradations: Object.freeze([gateDegradation])
    };
  }

  if (input.embedding.max_supplement <= 0) {
    return {
      candidates: baseline,
      exclusions: Object.freeze([]),
      degradations: Object.freeze([{
        route: "embedding",
        reason: "embedding_budget_exhausted",
        provider_state: input.embedding.provider_state,
        fallback_candidate_count: fallbackCandidateCount,
        retryable: true
      }])
    };
  }

  const recordsById = recordMap(input.records);
  const seen = new Set(baseline.map((candidate) => candidate.object_id));
  const additions: RecallCandidate[] = [];
  const exclusions: RecallExclusion[] = [];
  const supplement = [...(input.supplement ?? [])].sort((left, right) => {
    const scoreDelta = right.similarity_score - left.similarity_score;
    if (scoreDelta !== 0) {
      return scoreDelta;
    }
    return left.object_id.localeCompare(right.object_id);
  });

  for (const entry of supplement) {
    if (seen.has(entry.object_id)) {
      const record = recordsById.get(entry.object_id);
      if (record !== undefined) {
        exclusions.push(buildExclusion(record, "embedding", "duplicate_candidate", false));
      }
      continue;
    }

    if (additions.length >= input.embedding.max_supplement) {
      const record = recordsById.get(entry.object_id);
      if (record !== undefined) {
        exclusions.push(buildExclusion(record, "embedding", "embedding_budget_exhausted", true));
      }
      continue;
    }

    const record = recordsById.get(entry.object_id);
    if (record === undefined) {
      continue;
    }

    const eligibility = evaluateRecordEligibility(record, input.query ?? null, "embedding");
    if (!eligibility.eligible) {
      exclusions.push(eligibility.exclusion);
      continue;
    }

    const embeddingContribution: RecallRouteContribution = stripUndefinedContributionFields({
      route: "embedding",
      source_plane: "runtime_projection",
      score: roundScore(clampUnit(entry.similarity_score) * 0.5),
      reason: entry.reason ?? "embedding_similarity_supplement",
      similarity_score: roundScore(clampUnit(entry.similarity_score))
    });
    additions.push(createCandidate({
      memory: record.memory,
      inclusionReason: "structured_filters_passed_and_embedding_supplemented",
      contributions: [buildStructuredContribution(record.memory), embeddingContribution]
    }));
    seen.add(entry.object_id);
  }

  return {
    candidates: Object.freeze([...baseline, ...additions]),
    exclusions: Object.freeze(exclusions.sort((left, right) => left.object_id.localeCompare(right.object_id))),
    degradations: Object.freeze([])
  };
}

function embeddingGateDegradation(
  providerState: EmbeddingProviderState,
  enabled: boolean,
  fallbackCandidateCount: number
): RecallDegradation | null {
  if (!enabled || providerState === "disabled") {
    return {
      route: "embedding",
      reason: "embedding_disabled",
      provider_state: providerState,
      fallback_candidate_count: fallbackCandidateCount,
      retryable: false
    };
  }

  if (providerState === "ready") {
    return null;
  }

  return {
    route: "embedding",
    reason: providerStateReason(providerState),
    provider_state: providerState,
    fallback_candidate_count: fallbackCandidateCount,
    retryable: true
  };
}

function providerStateReason(providerState: EmbeddingProviderState): string {
  switch (providerState) {
    case "unconfigured":
      return "embedding_unconfigured";
    case "unavailable":
      return "provider_unavailable";
    case "pending":
      return "query_embedding_pending";
    case "error":
      return "provider_error";
    case "disabled":
      return "embedding_disabled";
    case "ready":
      return "ready";
  }
}

function stripUndefinedContributionFields(contribution: RecallRouteContribution): RecallRouteContribution {
  const result: {
    route: "embedding";
    source_plane: "runtime_projection";
    score: number;
    reason: string;
    similarity_score?: number;
  } = {
    route: "embedding",
    source_plane: "runtime_projection",
    score: contribution.score,
    reason: contribution.reason
  };
  if (contribution.similarity_score !== undefined) {
    result.similarity_score = contribution.similarity_score;
  }
  return result;
}
