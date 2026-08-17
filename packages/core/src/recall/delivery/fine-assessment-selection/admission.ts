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
