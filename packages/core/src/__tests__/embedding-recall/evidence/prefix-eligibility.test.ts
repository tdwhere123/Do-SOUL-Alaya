import { describe, expect, it } from "vitest";
import { selectLexicalEvidenceEmbeddingPrefix } from
  "../../../embedding-recall/evidence/evidence-candidate-scoring.js";
import {
  EVIDENCE_LEXICAL_PREFIX_ELIGIBILITY_OPERATOR_ID,
  auditEvidencePrefixEligibility,
  type EvidencePrefixEligibilityLimit,
  type EvidencePrefixEligibilityReceipt
} from "../../../embedding-recall/evidence/prefix-eligibility.js";
import { EVIDENCE_DOCUMENT_MAX_OPERATOR_ID } from "../../../embedding-recall/constants.js";
import type {
  EvidenceCandidateScoringReceipt,
  EvidenceEmbeddingCandidate
} from "../../../embedding-recall/types.js";
import { compareText } from "../../../shared/compare-text.js";

const QUERY_TEXT = "kubernetes staging pipeline checklist";
const POOL_SIZE = 40;

describe("evidence prefix eligibility audit", () => {
  it("marks ranks 17-32 eligible at 32 only and rank 33+ only at full", () => {
    const candidates = buildSameContentPool();
    const audit = auditEvidencePrefixEligibility(candidates, QUERY_TEXT);
    const receipts = audit.receipts;

    expect(audit).toMatchObject({
      schema_version: 1,
      operator_id: EVIDENCE_LEXICAL_PREFIX_ELIGIBILITY_OPERATOR_ID,
      status: "returned",
      pool_size: POOL_SIZE
    });
    expect(eligibleKeySet(receipts, 16)).toEqual(new Set(prefixKeys(candidates, 16)));
    expect(eligibleKeySet(receipts, 32)).toEqual(new Set(prefixKeys(candidates, 32)));
    expect(eligibleKeySet(receipts, "full")).toEqual(
      new Set(candidates.map((candidate) => candidate.candidateKey))
    );
    expect(eligibility(receipts, "memory:15", 16)).toEqual({ eligible: true, lexical_rank: 16 });
    expect(eligibility(receipts, "memory:16", 16)).toEqual({ eligible: false, lexical_rank: 17 });
    expect(eligibility(receipts, "memory:16", 32)).toEqual({ eligible: true, lexical_rank: 17 });
    expect(eligibility(receipts, "memory:31", 32)).toEqual({ eligible: true, lexical_rank: 32 });
    expect(eligibility(receipts, "memory:32", 16)).toEqual({ eligible: false, lexical_rank: 33 });
    expect(eligibility(receipts, "memory:32", 32)).toEqual({ eligible: false, lexical_rank: 33 });
    expect(eligibility(receipts, "memory:32", "full")).toEqual({ eligible: true, lexical_rank: 33 });
    expect(receiptAt(receipts, "memory:16", 16).live_observation_completeness)
      .toBe("bounded_candidate_prefix");
    expect(receiptAt(receipts, "memory:16", 32).live_observation_completeness).toBe("not_observed");
    expect(receiptAt(receipts, "memory:32", "full").live_observation_completeness)
      .toBe("not_observed");
  });

  it("assigns lexical_rank with the selectLexicalEvidenceEmbeddingPrefix compareText chain", () => {
    const candidates = Object.freeze([
      freezeCandidate("k-b", "e-a", "d-a"),
      freezeCandidate("k-a", "e-b", "d-a"),
      freezeCandidate("k-a", "e-a", "d-b")
    ]);
    const expectedOrder = [...candidates].sort((left, right) =>
      compareText(left.candidateKey, right.candidateKey) ||
      compareText(left.evidenceObjectId, right.evidenceObjectId) ||
      compareText(left.documentIdentity, right.documentIdentity)
    );
    const receipts = auditEvidencePrefixEligibility(candidates, QUERY_TEXT).receipts;
    const rankedKeys = uniqueByRank(receipts).map((receipt) => [
      receipt.candidateKey, receipt.evidenceObjectId, receipt.documentIdentity, receipt.lexical_rank
    ]);

    expect(rankedKeys).toEqual(expectedOrder.map((candidate, index) => [
      candidate.candidateKey, candidate.evidenceObjectId, candidate.documentIdentity, index + 1
    ]));
    expect(selectLexicalEvidenceEmbeddingPrefix(candidates, QUERY_TEXT, 2).map((candidate) =>
      candidate.candidateKey + candidate.evidenceObjectId + candidate.documentIdentity
    )).toEqual(expectedOrder.slice(0, 2).map((candidate) =>
      candidate.candidateKey + candidate.evidenceObjectId + candidate.documentIdentity
    ));
  });

  it("returns not_applicable for an empty pool", () => {
    expect(auditEvidencePrefixEligibility(Object.freeze([]), QUERY_TEXT)).toEqual({
      schema_version: 1,
      operator_id: EVIDENCE_LEXICAL_PREFIX_ELIGIBILITY_OPERATOR_ID,
      status: "not_applicable",
      pool_size: 0,
      receipts: []
    });
  });

  it("copies live completeness only from a prefix-scoped scored witness", () => {
    const candidates = buildSameContentPool();
    const gistBounded = candidates.find((candidate) => candidate.candidateKey === "memory:00")!;
    const scoredComplete = candidates.find((candidate) => candidate.candidateKey === "memory:15")!;
    const ineligibleGold = candidates.find((candidate) => candidate.candidateKey === "memory:32")!;
    const audit = auditEvidencePrefixEligibility(
      candidates,
      QUERY_TEXT,
      new Map([[32, new Map([
        [gistBounded.candidateKey, scoredReceipt(gistBounded, "bounded_candidate_prefix")],
        [scoredComplete.candidateKey, scoredReceipt(scoredComplete, "complete")]
      ])]])
    );
    const receipts = audit.receipts;
    const boundedAt32 = receiptAt(receipts, gistBounded.candidateKey, 32);
    const completeAt32 = receiptAt(receipts, scoredComplete.candidateKey, 32);
    const eligibleUnscoredAt16 = receiptAt(receipts, gistBounded.candidateKey, 16);
    const rank33AtFull = receiptAt(receipts, ineligibleGold.candidateKey, "full");
    const rank33At32 = receiptAt(receipts, ineligibleGold.candidateKey, 32);

    expect(boundedAt32).toMatchObject({
      schema_version: 1,
      operator_id: EVIDENCE_LEXICAL_PREFIX_ELIGIBILITY_OPERATOR_ID,
      eligible: true,
      lexical_rank: 1,
      live_observation_completeness: "bounded_candidate_prefix"
    });
    expect(completeAt32.live_observation_completeness).toBe("complete");
    expect(eligibleUnscoredAt16).toMatchObject({
      eligible: true,
      live_observation_completeness: "not_observed"
    });
    expect(rank33AtFull).toMatchObject({
      eligible: true,
      lexical_rank: 33,
      live_observation_completeness: "not_observed"
    });
    expect(rank33At32).toMatchObject({
      eligible: false,
      live_observation_completeness: "bounded_candidate_prefix"
    });
    expect(boundedAt32).not.toHaveProperty("observation_completeness");
    expect(rank33AtFull).not.toHaveProperty("degenerate_embedded_text");
    expect(rank33At32).not.toHaveProperty("degenerate_embedded_text");
  });
});

function buildSameContentPool(): readonly EvidenceEmbeddingCandidate[] {
  return Object.freeze(Array.from({ length: POOL_SIZE }, (_, index) =>
    freezeCandidate(
      `memory:${String(POOL_SIZE - 1 - index).padStart(2, "0")}`,
      `evidence-${String(POOL_SIZE - 1 - index).padStart(2, "0")}`,
      "owner"
    )
  ));
}

function freezeCandidate(
  candidateKey: string,
  evidenceObjectId: string,
  documentIdentity: string
): EvidenceEmbeddingCandidate {
  return Object.freeze({
    candidateKey,
    evidenceObjectId,
    documentIdentity,
    content: "unrelated garden note"
  });
}

function scoredReceipt(
  candidate: Readonly<EvidenceEmbeddingCandidate>,
  observationCompleteness: EvidenceCandidateScoringReceipt["observation_completeness"]
): Readonly<EvidenceCandidateScoringReceipt> {
  const winner = Object.freeze({
    score: 0.4,
    evidenceObjectId: candidate.evidenceObjectId,
    documentIdentity: candidate.documentIdentity
  });
  return Object.freeze({
    schema_version: 1,
    operator_id: EVIDENCE_DOCUMENT_MAX_OPERATOR_ID,
    state: "observed",
    score: winner.score,
    winner,
    observations: Object.freeze([winner]),
    observation_completeness: observationCompleteness,
    missing_channel_policy: "no_op"
  });
}

function prefixKeys(
  candidates: readonly EvidenceEmbeddingCandidate[],
  limit: number
): readonly string[] {
  return selectLexicalEvidenceEmbeddingPrefix(candidates, QUERY_TEXT, limit)
    .map((candidate) => candidate.candidateKey);
}

function eligibleKeySet(
  receipts: readonly Readonly<EvidencePrefixEligibilityReceipt>[],
  prefix: EvidencePrefixEligibilityLimit
): ReadonlySet<string> {
  return new Set(
    receipts.filter((receipt) => receipt.prefix === prefix && receipt.eligible)
      .map((receipt) => receipt.candidateKey)
  );
}

function eligibility(
  receipts: readonly Readonly<EvidencePrefixEligibilityReceipt>[],
  candidateKey: string,
  prefix: EvidencePrefixEligibilityLimit
): Pick<EvidencePrefixEligibilityReceipt, "eligible" | "lexical_rank"> {
  const receipt = receiptAt(receipts, candidateKey, prefix);
  return { eligible: receipt.eligible, lexical_rank: receipt.lexical_rank };
}

function uniqueByRank(
  receipts: readonly Readonly<EvidencePrefixEligibilityReceipt>[]
): readonly Readonly<EvidencePrefixEligibilityReceipt>[] {
  return [...receipts]
    .filter((receipt) => receipt.prefix === "full")
    .sort((left, right) => left.lexical_rank - right.lexical_rank);
}

function receiptAt(
  receipts: readonly Readonly<EvidencePrefixEligibilityReceipt>[],
  candidateKey: string,
  prefix: EvidencePrefixEligibilityLimit
): Readonly<EvidencePrefixEligibilityReceipt> {
  const receipt = receipts.find((row) =>
    row.candidateKey === candidateKey && row.prefix === prefix
  );
  expect(receipt).toBeDefined();
  return receipt!;
}
