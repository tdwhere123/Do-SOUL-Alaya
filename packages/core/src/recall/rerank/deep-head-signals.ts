import { clamp01 } from "../../shared/clamp.js";
import type { DeliverySelectionCandidate } from "../delivery/delivery-selection.js";
import { isWorkspaceMemoryCandidate } from "../runtime/recall-service-helpers.js";
import { hasTemporalQuerySignal } from "../query/recall-query-plan.js";
import { resolveRecallCandidateSemanticActivation } from
  "../scoring/activation/candidate-semantic-activation-context.js";
import type { CandidateActivationReceipt } from
  "../scoring/candidate-semantic-activation.js";
import type {
  DeepHeadSupplementary,
  LightweightComponents
} from "./deep-head-types.js";

const FIELD_BASELINE_EXCLUDED_STREAMS = new Set([
  "existing_score",
  "workspace_activation",
  "temporal_recency"
]);

export function buildLightweightComponents(
  candidate: DeliverySelectionCandidate,
  supplementaryData: DeepHeadSupplementary
): LightweightComponents {
  const lexicalAgreement = lexicalAgreementSignal(candidate, supplementaryData);
  const evidenceAgreement = evidenceAgreementSignal(candidate, supplementaryData);
  // Fusion is the request-scoped field baseline. Eligibility comes from an
  // explicit source contribution, never from object identity, lexical labels
  // or intent classification. Temporal evidence also needs typed demand.
  const fusionBaselineEligible = hasFieldBaseline(
    candidate,
    supplementaryData.queryProbes
  );
  const activation = resolveEmbeddingActivation(candidate, supplementaryData);
  const evidenceSemanticActivation = supplementaryData
    .evidenceSemanticActivationsByCandidateKey.get(candidate.fusion.candidate_key) ?? null;
  return Object.freeze({
    lexicalAgreement,
    evidenceAgreement,
    resolvedEvidence: familyMaxEvidence(evidenceAgreement, lexicalAgreement),
    embedding: activation.score,
    activation,
    evidenceSemanticActivation,
    fusionBaselineEligible,
    fusionBaselineScore: fusionBaselineEligible
      ? clamp01(candidate.fusion.fused_score)
      : null
  });
}

function hasFieldBaseline(
  candidate: DeliverySelectionCandidate,
  queryProbes: DeepHeadSupplementary["queryProbes"]
): boolean {
  if (clamp01(candidate.fusion.fused_score) <= 0) return false;
  return Object.entries(candidate.fusion.fused_rank_contribution_per_stream)
    .some(([stream, contribution]) =>
      (!FIELD_BASELINE_EXCLUDED_STREAMS.has(stream) ||
        (stream === "temporal_recency" && hasTemporalQuerySignal(queryProbes))) &&
      Number.isFinite(contribution) && contribution > 0
    );
}

const INDEPENDENT_EMBEDDING_CHANNELS = new Set([
  "effective_factor",
  "object_embedding"
]);

export function embeddingSignal(
  candidate: DeliverySelectionCandidate,
  supplementaryData: DeepHeadSupplementary
): number | null {
  return resolveEmbeddingActivation(candidate, supplementaryData).score;
}

export function independentEmbeddingScore(
  activation: CandidateActivationReceipt,
  allowEvidenceSemantic = false
): number | null {
  const channels = allowEvidenceSemantic
    ? new Set([...INDEPENDENT_EMBEDDING_CHANNELS, "evidence_semantic"])
    : INDEPENDENT_EMBEDDING_CHANNELS;
  let best: number | null = null;
  for (const observation of activation.observations) {
    if (!channels.has(observation.channel)) continue;
    if (observation.state !== "observed" || observation.score === null) continue;
    if (best === null || observation.score > best) best = observation.score;
  }
  return best;
}

export function embeddingActivation(
  candidate: DeliverySelectionCandidate,
  supplementaryData: DeepHeadSupplementary
): CandidateActivationReceipt {
  return resolveEmbeddingActivation(candidate, supplementaryData);
}

function resolveEmbeddingActivation(
  candidate: DeliverySelectionCandidate,
  supplementaryData: DeepHeadSupplementary
): CandidateActivationReceipt {
  return resolveRecallCandidateSemanticActivation(candidate, supplementaryData);
}

// Lexical FTS, trigram, and evidence-FTS views are correlated projections of
// the same query-facing family; one family casts one ballot at max strength.
function familyMaxEvidence(left: number, right: number): number {
  return Math.max(left, right);
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
