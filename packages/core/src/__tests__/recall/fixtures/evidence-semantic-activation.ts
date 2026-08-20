import type {
  RecallEvidenceSemanticActivationReceipt,
  RecallEvidenceSemanticWinnerReceipt
} from "../../../recall/runtime/recall-service-types.js";

export function evidenceSemanticActivation(
  score: number,
  winnerOverrides: Partial<RecallEvidenceSemanticWinnerReceipt> = {},
  additionalObservations: readonly Readonly<RecallEvidenceSemanticWinnerReceipt>[] = []
): Readonly<RecallEvidenceSemanticActivationReceipt> {
  const winner = Object.freeze({
    score,
    evidenceObjectId: "evidence-fixture",
    documentIdentity: "owner",
    projection: Object.freeze({
      projection_id: null,
      projection_kind: "owner" as const,
      matched_fact_key_forms: Object.freeze([])
    }),
    ...winnerOverrides
  });
  const observations = Object.freeze([winner, ...additionalObservations].sort(
    compareObservations
  ));
  return Object.freeze({
    schema_version: 1,
    operator_id: "evidence_document_max_v1",
    state: "observed",
    score,
    winner,
    observations,
    observation_completeness: "complete",
    missing_channel_policy: "no_op"
  });
}

function compareObservations(
  left: Readonly<RecallEvidenceSemanticWinnerReceipt>,
  right: Readonly<RecallEvidenceSemanticWinnerReceipt>
): number {
  if (left.score !== right.score) return right.score - left.score;
  const evidenceOrder = compareText(left.evidenceObjectId, right.evidenceObjectId);
  return evidenceOrder !== 0
    ? evidenceOrder
    : compareText(left.documentIdentity, right.documentIdentity);
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

export function evidenceSemanticActivationsFromScores(
  scores: ReadonlyMap<string, number>
): ReadonlyMap<string, Readonly<RecallEvidenceSemanticActivationReceipt>> {
  return new Map([...scores].map(([candidateKey, score]) => [
    candidateKey,
    evidenceSemanticActivation(score)
  ] as const));
}
