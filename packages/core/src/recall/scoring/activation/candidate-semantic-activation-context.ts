import type {
  RecallCandidate,
  RecallOriginPlane,
  RecallScoreFactors
} from "@do-soul/alaya-protocol";
import {
  buildRecallCandidateDedupeKey,
  isWorkspaceMemoryCandidate
} from "../../runtime/recall-service-helpers.js";
import type { RecallSupplementaryData } from
  "../../runtime/recall-service-types.js";
import {
  resolveCandidateSemanticActivation,
  resolveCandidateSemanticActivationScope,
  type CandidateActivationReceipt
} from "../candidate-semantic-activation.js";

export type RecallCandidateActivationInput = Readonly<{
  readonly entry: Readonly<{ readonly object_id: string }>;
  readonly originPlane?: RecallOriginPlane;
  readonly objectKind?: RecallCandidate["object_kind"];
  readonly effectiveFactors: Readonly<RecallScoreFactors>;
  readonly fusion?: Readonly<{ readonly candidate_key: string }>;
}>;

export type RecallCandidateActivationSupplementary = Readonly<Pick<
  RecallSupplementaryData,
  | "embeddingSimilarityScores"
  | "evidenceSemanticActivationsByCandidateKey"
>>;

export function resolveRecallCandidateSemanticActivation(
  candidate: RecallCandidateActivationInput,
  supplementaryData: RecallCandidateActivationSupplementary,
  candidateKeyOverride?: string
): CandidateActivationReceipt {
  const candidateKey = candidateKeyOverride ?? candidate.fusion?.candidate_key ??
    buildRecallCandidateDedupeKey(candidate);
  const evidenceActivation = supplementaryData
    .evidenceSemanticActivationsByCandidateKey.get(candidateKey);
  return resolveCandidateSemanticActivation({
    scope: resolveCandidateSemanticActivationScope({
      originPlane: candidate.originPlane,
      objectKind: candidate.objectKind,
      workspaceMemoryEligible: isWorkspaceMemoryCandidate(candidate)
    }),
    evidenceSemantic: evidenceActivation?.score,
    effectiveEmbedding: candidate.effectiveFactors.embedding_similarity,
    objectEmbedding: supplementaryData.embeddingSimilarityScores[
      candidate.entry.object_id
    ]
  });
}
