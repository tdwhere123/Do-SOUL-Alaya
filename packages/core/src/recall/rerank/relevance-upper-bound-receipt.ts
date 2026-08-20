import {
  digestRecallFieldIdentity,
  type RecallFieldDigest
} from "../field/field-identity.js";

export const RECALL_RELEVANCE_UPPER_BOUND_OPERATOR_ID =
  "recall_relevance_upper_bound_v1";

export type RecallRelevanceUpperBoundReceipt = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: typeof RECALL_RELEVANCE_UPPER_BOUND_OPERATOR_ID;
  readonly score_operator_id: string;
  readonly lower_bound: 0;
  readonly upper_bound: 1;
  readonly receipt_digest: RecallFieldDigest;
}>;

export function createRecallRelevanceUpperBoundReceipt(
  scoreOperatorId: string,
  scores: ReadonlyMap<string, number>
): RecallRelevanceUpperBoundReceipt {
  assertIdentity(scoreOperatorId);
  for (const score of scores.values()) assertUnit(score);
  const body = Object.freeze({
    schema_version: 1 as const,
    operator_id: RECALL_RELEVANCE_UPPER_BOUND_OPERATOR_ID,
    score_operator_id: scoreOperatorId,
    lower_bound: 0 as const,
    upper_bound: 1 as const
  });
  return Object.freeze({
    ...body,
    receipt_digest: digestRecallFieldIdentity(body)
  });
}

export function verifyRecallRelevanceUpperBoundReceipt(
  receipt: Readonly<RecallRelevanceUpperBoundReceipt>
): void {
  if (receipt.schema_version !== 1 ||
      receipt.operator_id !== RECALL_RELEVANCE_UPPER_BOUND_OPERATOR_ID ||
      receipt.lower_bound !== 0 || receipt.upper_bound !== 1) {
    throw new Error("relevance upper-bound receipt shape mismatch");
  }
  assertIdentity(receipt.score_operator_id);
  const { receipt_digest: _digest, ...body } = receipt;
  if (receipt.receipt_digest !== digestRecallFieldIdentity(body)) {
    throw new Error("relevance upper-bound receipt digest mismatch");
  }
}

function assertIdentity(value: string): void {
  if (value.length === 0 || value.trim() !== value) {
    throw new Error("relevance score operator id must be canonical");
  }
}

function assertUnit(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("relevance score is outside its declared unit envelope");
  }
}
