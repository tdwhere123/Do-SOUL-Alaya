import { describe, expect, it, vi } from "vitest";
import {
  EVIDENCE_CANDIDATE_EMBEDDING_TOP_N,
  selectLexicalEvidenceEmbeddingPrefix,
  scoreTransientEvidenceCandidates
} from "../../../embedding-recall/evidence/evidence-candidate-scoring.js";
import {
  auditEvidencePrefixEligibility,
  type EvidencePrefixEligibilityLimit,
  type EvidencePrefixEligibilityReceipt
} from "../../../embedding-recall/evidence/prefix-eligibility.js";
import type { EvidenceEmbeddingCandidate } from "../../../embedding-recall/types.js";
import { compareText } from "../../../shared/compare-text.js";
import { createProvider } from "../embedding-recall-test-helpers.js";
import { EvidenceDocumentEmbeddingEngine } from
  "../../../embedding-recall/evidence/evidence-document-embedding-engine.js";
import { QueryEmbeddingEngine } from "../../../embedding-recall/query-embedding-engine.js";

const QUERY_TEXT = "kubernetes staging pipeline checklist";
const POOL_SIZE = 40;

describe("evidence prefix eligibility audit", () => {
  it("marks ranks 17-32 eligible at 32 only and rank 33+ only at full", () => {
    const candidates = buildSameContentPool();
    const receipts = auditEvidencePrefixEligibility(candidates, QUERY_TEXT);

    for (const receipt of receipts) {
      expect(receipt.observation_completeness).toBe(
        receipt.eligible ? "complete" : "bounded_candidate_prefix"
      );
    }
    expect(eligibleKeySet(receipts, 16)).toEqual(new Set(prefixKeys(candidates, 16)));
    expect(eligibleKeySet(receipts, 32)).toEqual(new Set(prefixKeys(candidates, 32)));
    expect(eligibleKeySet(receipts, "full")).toEqual(
      new Set(candidates.map((candidate) => candidate.candidateKey))
    );

    expect(eligibility(receipts, "memory:15", 16)).toEqual({
      eligible: true, observation_completeness: "complete", lexical_rank: 16
    });
    expect(eligibility(receipts, "memory:16", 16)).toEqual({
      eligible: false, observation_completeness: "bounded_candidate_prefix", lexical_rank: 17
    });
    expect(eligibility(receipts, "memory:16", 32)).toEqual({
      eligible: true, observation_completeness: "complete", lexical_rank: 17
    });
    expect(eligibility(receipts, "memory:31", 32)).toEqual({
      eligible: true, observation_completeness: "complete", lexical_rank: 32
    });
    expect(eligibility(receipts, "memory:32", 16)).toEqual({
      eligible: false, observation_completeness: "bounded_candidate_prefix", lexical_rank: 33
    });
    expect(eligibility(receipts, "memory:32", 32)).toEqual({
      eligible: false, observation_completeness: "bounded_candidate_prefix", lexical_rank: 33
    });
    expect(eligibility(receipts, "memory:32", "full")).toEqual({
      eligible: true, observation_completeness: "complete", lexical_rank: 33
    });
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
    const receipts = auditEvidencePrefixEligibility(candidates, QUERY_TEXT);
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

  it("keeps the live scoring path prefixed at 32", async () => {
    expect(EVIDENCE_CANDIDATE_EMBEDDING_TOP_N).toBe(32);
    const candidates = buildSameContentPool();
    expect(selectLexicalEvidenceEmbeddingPrefix(candidates, QUERY_TEXT)).toHaveLength(32);

    const embedTexts = vi.fn(async (texts: readonly string[]) =>
      texts.map(() => new Float32Array([1, 0]))
    );
    const provider = createProvider({ embedTexts });
    const result = await scoreTransientEvidenceCandidates({
      workspaceId: "workspace-1",
      runId: null,
      queryText: QUERY_TEXT,
      preparedQuery: null,
      candidates
    }, {
      provider,
      documentEngine: new EvidenceDocumentEmbeddingEngine(
        provider,
        16,
        undefined,
        () => "2026-04-23T00:00:00.000Z",
        () => undefined
      ),
      queryEngine: new QueryEmbeddingEngine({
        provider,
        generateQueryId: () => "query-prefix-eligibility-1",
        queryTimeoutMs: 1000,
        queryEmbeddingCacheSize: 8
      }),
      queryTimeoutMs: 1000,
      warn: () => undefined
    });

    expect(result.scoredCount).toBe(32);
    expect(result.activationsByCandidateKey.size).toBe(32);
  });

  it("does not treat a prefix-ineligible cosine-0 gold as a semantic gap", () => {
    const candidates = buildSameContentPool();
    const receipts = auditEvidencePrefixEligibility(
      candidates,
      QUERY_TEXT,
      new Map([["memory:00", 0], ["memory:32", 0]])
    );
    const ineligibleGold = receiptAt(receipts, "memory:32", 32);
    const eligibleGold = receiptAt(receipts, "memory:00", 32);
    const fullIneligibleGold = receiptAt(receipts, "memory:32", "full");

    expect(ineligibleGold).toMatchObject({
      eligible: false,
      observation_completeness: "bounded_candidate_prefix",
      lexical_rank: 33
    });
    expect(ineligibleGold).not.toHaveProperty("degenerate_embedded_text");
    expect(eligibleGold).toMatchObject({
      eligible: true,
      observation_completeness: "complete",
      degenerate_embedded_text: true
    });
    expect(fullIneligibleGold).toMatchObject({
      eligible: true,
      observation_completeness: "complete",
      degenerate_embedded_text: true
    });
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
): Pick<
  EvidencePrefixEligibilityReceipt,
  "eligible" | "observation_completeness" | "lexical_rank"
> {
  const receipt = receiptAt(receipts, candidateKey, prefix);
  return {
    eligible: receipt.eligible,
    observation_completeness: receipt.observation_completeness,
    lexical_rank: receipt.lexical_rank
  };
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
