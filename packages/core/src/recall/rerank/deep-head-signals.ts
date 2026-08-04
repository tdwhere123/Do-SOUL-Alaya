import { clamp01 } from "../../shared/clamp.js";
import type { DeliverySelectionCandidate } from "../delivery/delivery-selection.js";
import { isWorkspaceMemoryCandidate } from "../runtime/recall-service-helpers.js";
import { hasQueryEvidenceContribution } from "../scoring/query-evidence-support.js";
import {
  resolveCandidateSemanticActivation,
  resolveCandidateSemanticActivationScope
} from
  "../scoring/candidate-semantic-activation.js";
import type {
  DeepHeadSupplementary,
  LightweightComponents
} from "./deep-head-types.js";

export function buildLightweightComponents(
  candidate: DeliverySelectionCandidate,
  supplementaryData: DeepHeadSupplementary
): LightweightComponents {
  const lexicalAgreement = lexicalAgreementSignal(candidate, supplementaryData);
  const evidenceAgreement = evidenceAgreementSignal(candidate, supplementaryData);
  return Object.freeze({
    lexicalAgreement,
    evidenceAgreement,
    resolvedEvidence: probabilisticOr(evidenceAgreement, lexicalAgreement),
    embedding: embeddingSignal(candidate, supplementaryData),
    fusionBaselineEligible: hasQueryEvidenceContribution(
      candidate.fusion.fused_rank_contribution_per_stream,
      supplementaryData.queryProbes
    )
  });
}

export function embeddingSignal(
  candidate: DeliverySelectionCandidate,
  supplementaryData: DeepHeadSupplementary
): number | null {
  const objectId = candidate.entry.object_id;
  return resolveCandidateSemanticActivation({
    scope: resolveCandidateSemanticActivationScope({
      originPlane: candidate.originPlane,
      objectKind: candidate.objectKind,
      workspaceMemoryEligible: isWorkspaceMemoryCandidate(candidate)
    }),
    evidenceSemantic: supplementaryData.evidenceSemanticScoresByCandidateKey?.get(
      candidate.fusion.candidate_key
    ),
    effectiveEmbedding: candidate.effectiveFactors.embedding_similarity,
    objectEmbedding: supplementaryData.embeddingSimilarityScores[objectId]
  }).score;
}

export function answerEvidenceSignal(
  candidate: DeliverySelectionCandidate,
  supplementaryData: DeepHeadSupplementary
): number {
  return probabilisticOr(
    evidenceAgreementSignal(candidate, supplementaryData),
    lexicalAgreementSignal(candidate, supplementaryData)
  );
}

function evidenceAgreementSignal(
  candidate: DeliverySelectionCandidate,
  supplementaryData: DeepHeadSupplementary
): number {
  const canUseMemorySignals = isWorkspaceMemoryCandidate(candidate);
  const objectId = candidate.entry.object_id;
  const evidence = clamp01(
    canUseMemorySignals ? supplementaryData.evidenceFtsRanks[objectId] ?? 0 : 0
  );
  const structural = clamp01(
    candidate.structuralScore ?? (
      canUseMemorySignals ? supplementaryData.structuralScores[objectId] ?? 0 : 0
    )
  );
  const source = clamp01(
    canUseMemorySignals ? supplementaryData.sourceProximityScores[objectId] ?? 0 : 0
  );
  return Math.max(
    geometricAgreement(evidence, structural),
    geometricAgreement(evidence, source)
  );
}

function lexicalAgreementSignal(
  candidate: DeliverySelectionCandidate,
  supplementaryData: DeepHeadSupplementary
): number {
  if (!isWorkspaceMemoryCandidate(candidate)) return 0;
  const objectId = candidate.entry.object_id;
  return geometricAgreement(
    clamp01(supplementaryData.ftsRanks[objectId] ?? 0),
    clamp01(supplementaryData.trigramFtsRanks[objectId] ?? 0)
  );
}

function geometricAgreement(left: number, right: number): number {
  if (left <= 0 || right <= 0) {
    return 0;
  }
  return clamp01(Math.sqrt(left * right));
}

export function probabilisticOr(left: number, right: number): number {
  return clamp01(left + right - left * right);
}
