import type { MemoryDimension as MemoryDimensionType } from "@do-soul/alaya-protocol";
import { buildRecallCandidateDedupeKey, buildRecallLogicalObjectKey } from "../../runtime/recall-service-helpers.js";
import type {
  FineAssessmentAdmission,
  FineAssessmentAdmissionState,
  FineAssessmentCandidate,
  FineAssessmentSelectionContext
} from "./types.js";

export function createAdmissionState(): FineAssessmentAdmissionState {
  return {
    seenObjects: new Set<string>(),
    perDimensionCounts: new Map<MemoryDimensionType, number>(),
    selectedCount: 0,
    totalTokens: 0
  };
}

export function resolveAdmission(
  state: FineAssessmentAdmissionState,
  candidate: FineAssessmentCandidate,
  objectKey: string,
  context: FineAssessmentSelectionContext
): FineAssessmentAdmission {
  if (state.seenObjects.has(objectKey)) {
    return { droppedReason: "duplicate", tokenEstimate: null };
  }
  const dimensionCount = state.perDimensionCounts.get(candidate.entry.dimension) ?? 0;
  const dimensionLimit = context.config.budgets.per_dimension_limits?.[candidate.entry.dimension] ?? null;
  if (dimensionLimit !== null && dimensionCount >= dimensionLimit) {
    return { droppedReason: "dimension_limit", tokenEstimate: null };
  }
  if (state.selectedCount + 1 > context.config.budgets.max_entries) {
    return { droppedReason: "max_entries", tokenEstimate: null };
  }
  const tokenEstimate = estimateCandidateTokens(candidate, context);
  if (state.totalTokens + tokenEstimate > context.config.budgets.max_total_tokens) {
    return { droppedReason: "max_total_tokens", tokenEstimate };
  }
  return { droppedReason: null, tokenEstimate };
}

export function tryRecordAcceptedAdmission(
  state: FineAssessmentAdmissionState,
  candidate: FineAssessmentCandidate,
  context: FineAssessmentSelectionContext,
  evictions: ReadonlySet<string>
): boolean {
  if (evictions.has(candidate.fusion.candidate_key)) return false;
  const objectKey = buildRecallLogicalObjectKey(candidate);
  const admission = resolveAdmission(state, candidate, objectKey, context);
  if (admission.droppedReason !== null) return false;
  const tokenEstimate = admission.tokenEstimate ?? estimateCandidateTokens(candidate, context);
  recordAcceptedAdmission(state, candidate, objectKey, tokenEstimate);
  return true;
}

export function collectAdmittedCandidates(
  candidates: readonly FineAssessmentCandidate[],
  context: FineAssessmentSelectionContext,
  evictions: ReadonlySet<string>
): readonly FineAssessmentCandidate[] {
  const state = createAdmissionState();
  const delivered: FineAssessmentCandidate[] = [];
  for (const candidate of candidates) {
    if (!tryRecordAcceptedAdmission(state, candidate, context, evictions)) continue;
    delivered.push(candidate);
  }
  return delivered;
}

export function recordAcceptedAdmission(
  state: FineAssessmentAdmissionState,
  candidate: FineAssessmentCandidate,
  objectKey: string,
  tokenEstimate: number
): void {
  state.seenObjects.add(objectKey);
  state.perDimensionCounts.set(
    candidate.entry.dimension,
    (state.perDimensionCounts.get(candidate.entry.dimension) ?? 0) + 1
  );
  state.selectedCount += 1;
  state.totalTokens += tokenEstimate;
}

export function estimateCandidateTokens(
  candidate: FineAssessmentCandidate,
  context: FineAssessmentSelectionContext
): number {
  const candidateKey = buildRecallCandidateDedupeKey(candidate);
  const cached = context.tokenEstimateByCandidateKey.get(candidateKey);
  if (cached !== undefined) return cached;
  const estimated = context.tokenEstimator.estimate(candidate.entry.content);
  context.tokenEstimateByCandidateKey.set(candidateKey, estimated);
  return estimated;
}
