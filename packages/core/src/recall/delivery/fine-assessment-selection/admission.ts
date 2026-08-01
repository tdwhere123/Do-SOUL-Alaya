import type { MemoryDimension as MemoryDimensionType } from "@do-soul/alaya-protocol";
import { buildRecallCandidateDedupeKey, buildRecallLogicalObjectKey } from "../../runtime/recall-service-helpers.js";
import type {
  FineAssessmentAdmission,
  FineAssessmentAdmissionState,
  FineAssessmentCandidate,
  FineAssessmentSelectionContext
} from "./types.js";

export function createAdmissionState(
  captureReceipts = false
): FineAssessmentAdmissionState {
  return {
    seenObjects: new Set<string>(),
    ...(captureReceipts ? {
      retainedCandidateKeyByObjectKey: new Map<string, string>()
    } : {}),
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
  const duplicate = resolveDuplicateAdmission(state, objectKey);
  if (duplicate !== null) return duplicate;
  const dimension = resolveDimensionAdmission(state, candidate, context);
  if (dimension !== null) return dimension;
  const entries = resolveEntryAdmission(state, context);
  if (entries !== null) return entries;
  return resolveTokenAdmission(state, candidate, context);
}

function resolveDuplicateAdmission(
  state: FineAssessmentAdmissionState,
  objectKey: string
): FineAssessmentAdmission | null {
  if (!state.seenObjects.has(objectKey)) return null;
  const retainedCandidateKey =
    state.retainedCandidateKeyByObjectKey?.get(objectKey);
  if (
    state.retainedCandidateKeyByObjectKey !== undefined &&
    retainedCandidateKey === undefined
  ) {
    throw new Error("duplicate admission receipt is missing");
  }
  return {
    droppedReason: "duplicate",
    tokenEstimate: null,
    ...(retainedCandidateKey === undefined ? {} : { receipt: {
      kind: "duplicate",
      retained_candidate_key: retainedCandidateKey
    } })
  };
}

function resolveDimensionAdmission(
  state: FineAssessmentAdmissionState,
  candidate: FineAssessmentCandidate,
  context: FineAssessmentSelectionContext
): FineAssessmentAdmission | null {
  const dimensionCount = state.perDimensionCounts.get(candidate.entry.dimension) ?? 0;
  const dimensionLimit = context.config.budgets.per_dimension_limits?.[candidate.entry.dimension] ?? null;
  if (dimensionLimit === null || dimensionCount < dimensionLimit) return null;
  return {
    droppedReason: "dimension_limit",
    tokenEstimate: null,
    ...(state.retainedCandidateKeyByObjectKey === undefined ? {} : { receipt: {
      kind: "dimension_limit",
      dimension: candidate.entry.dimension,
      accepted_before: dimensionCount,
      limit: dimensionLimit
    } })
  };
}

function resolveEntryAdmission(
  state: FineAssessmentAdmissionState,
  context: FineAssessmentSelectionContext
): FineAssessmentAdmission | null {
  if (state.selectedCount + 1 <= context.config.budgets.max_entries) return null;
  return {
    droppedReason: "max_entries",
    tokenEstimate: null,
    ...(state.retainedCandidateKeyByObjectKey === undefined ? {} : { receipt: {
      kind: "max_entries",
      accepted_before: state.selectedCount,
      limit: context.config.budgets.max_entries
    } })
  };
}

function resolveTokenAdmission(
  state: FineAssessmentAdmissionState,
  candidate: FineAssessmentCandidate,
  context: FineAssessmentSelectionContext
): FineAssessmentAdmission {
  const tokenEstimate = estimateCandidateTokens(candidate, context);
  if (state.totalTokens + tokenEstimate > context.config.budgets.max_total_tokens) {
    return {
      droppedReason: "max_total_tokens",
      tokenEstimate,
      ...(state.retainedCandidateKeyByObjectKey === undefined ? {} : { receipt: {
        kind: "max_total_tokens",
        token_total_before: state.totalTokens,
        token_estimate: tokenEstimate,
        limit: context.config.budgets.max_total_tokens
      } })
    };
  }
  return {
    droppedReason: null,
    tokenEstimate,
    ...(state.retainedCandidateKeyByObjectKey === undefined ? {} : { receipt: {
      kind: "retained",
      selected_count_before: state.selectedCount,
      token_total_before: state.totalTokens,
      token_estimate: tokenEstimate
    } })
  };
}

export function tryRecordAcceptedAdmission(
  state: FineAssessmentAdmissionState,
  candidate: FineAssessmentCandidate,
  context: FineAssessmentSelectionContext
): boolean {
  const objectKey = buildRecallLogicalObjectKey(candidate);
  const admission = resolveAdmission(state, candidate, objectKey, context);
  if (admission.droppedReason !== null) return false;
  const tokenEstimate = admission.tokenEstimate ?? estimateCandidateTokens(candidate, context);
  recordAcceptedAdmission(state, candidate, objectKey, tokenEstimate);
  return true;
}

export function collectAdmittedCandidates(
  candidates: readonly FineAssessmentCandidate[],
  context: FineAssessmentSelectionContext
): readonly FineAssessmentCandidate[] {
  const state = createAdmissionState();
  const delivered: FineAssessmentCandidate[] = [];
  for (const candidate of candidates) {
    if (!tryRecordAcceptedAdmission(state, candidate, context)) continue;
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
  state.retainedCandidateKeyByObjectKey?.set(
    objectKey,
    buildRecallCandidateDedupeKey(candidate)
  );
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
