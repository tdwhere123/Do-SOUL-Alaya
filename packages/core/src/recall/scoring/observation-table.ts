import type {
  RecallEvidenceSemanticActivationReceipt,
  RecallEvidenceSemanticProjectionReceipt,
  RecallEvidenceSemanticWinnerReceipt
} from "../runtime/recall-service-types.js";

export type ScoredObservationRow = Readonly<{
  readonly objectKey: string;
  readonly evidenceObjectId: string;
  readonly documentIdentity: string;
  readonly contentHash: string | null;
  readonly projection: Readonly<RecallEvidenceSemanticProjectionReceipt> | null;
  readonly score: number;
  readonly completeness: RecallEvidenceSemanticActivationReceipt["observation_completeness"];
}>;

export function scoredObservationTable(
  objectKey: string,
  receipt: Readonly<RecallEvidenceSemanticActivationReceipt>
): readonly ScoredObservationRow[] {
  if (receipt.observations.length === 0) {
    throw new Error("observation table requires sibling rows");
  }
  return Object.freeze(receipt.observations.map((observation) =>
    freezeObservationRow(objectKey, receipt.observation_completeness, observation)
  ));
}

// Composition must not read the sealed scalar alone; later stages need every row.
export function evidenceSemanticScoreFromObservations(
  receipt: Readonly<RecallEvidenceSemanticActivationReceipt> | null | undefined
): number | undefined {
  if (receipt === null || receipt === undefined) return undefined;
  if (receipt.observations.length === 0) {
    throw new Error("observation table requires sibling rows");
  }
  return maxObservationScore(receipt.observations);
}

function maxObservationScore(
  observations: readonly Readonly<Pick<RecallEvidenceSemanticWinnerReceipt, "score">>[]
): number | undefined {
  let best: number | undefined;
  for (const observation of observations) {
    if (!Number.isFinite(observation.score)) continue;
    if (best === undefined || observation.score > best) best = observation.score;
  }
  return best;
}

function freezeObservationRow(
  objectKey: string,
  completeness: ScoredObservationRow["completeness"],
  observation: Readonly<RecallEvidenceSemanticWinnerReceipt>
): ScoredObservationRow {
  return Object.freeze({
    objectKey,
    evidenceObjectId: observation.evidenceObjectId,
    documentIdentity: observation.documentIdentity,
    contentHash: observation.contentHash ?? null,
    projection: observation.projection,
    score: observation.score,
    completeness
  });
}
