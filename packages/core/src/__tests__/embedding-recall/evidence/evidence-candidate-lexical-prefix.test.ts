import { describe, expect, it, vi } from "vitest";
import {
  EVIDENCE_CANDIDATE_EMBEDDING_TOP_N,
  selectLexicalEvidenceEmbeddingPrefix,
  scoreTransientEvidenceCandidates
} from "../../../embedding-recall/evidence/evidence-candidate-scoring.js";
import type { EvidenceEmbeddingCandidate } from "../../../embedding-recall/types.js";
import { createProvider } from "../embedding-recall-test-helpers.js";
import { EvidenceDocumentEmbeddingEngine } from
  "../../../embedding-recall/evidence/evidence-document-embedding-engine.js";
import { QueryEmbeddingEngine } from "../../../embedding-recall/query-embedding-engine.js";

const QUERY_TEXT = "kubernetes staging pipeline checklist";

describe("lexical prefix before evidence candidate embedding", () => {
  it("keeps embedding rank of the retained N identical to scoring those N first", async () => {
    const allCandidates = buildCandidates();
    const lexicalStart = EVIDENCE_CANDIDATE_EMBEDDING_TOP_N + 1;
    expect(allCandidates.slice(0, lexicalStart).every((candidate) =>
      candidate.content.includes("unrelated garden")
    )).toBe(true);
    const lexicalWinners = allCandidates.slice(
      lexicalStart,
      lexicalStart + EVIDENCE_CANDIDATE_EMBEDDING_TOP_N
    );
    expect(lexicalWinners).toHaveLength(EVIDENCE_CANDIDATE_EMBEDDING_TOP_N);

    const retained = selectLexicalEvidenceEmbeddingPrefix(
      allCandidates,
      QUERY_TEXT,
      EVIDENCE_CANDIDATE_EMBEDDING_TOP_N
    );
    expect(retained).toHaveLength(EVIDENCE_CANDIDATE_EMBEDDING_TOP_N);
    expect(retained.map((candidate) => candidate.candidateKey)).toEqual(
      lexicalWinners.map((candidate) => candidate.candidateKey)
    );
    expect(retained.every((candidate) => candidate.content.includes("kubernetes"))).toBe(true);

    const prefixed = await scoreWithDeterministicEmbeddings(allCandidates);
    const onlyRetained = await scoreWithDeterministicEmbeddings(retained);

    expect(rankKeys(prefixed)).toEqual(rankKeys(onlyRetained));
    expect(prefixed.scoredCount).toBe(EVIDENCE_CANDIDATE_EMBEDDING_TOP_N);
    expect(onlyRetained.scoredCount).toBe(EVIDENCE_CANDIDATE_EMBEDDING_TOP_N);
  });
});

function buildCandidates(): readonly EvidenceEmbeddingCandidate[] {
  const unrelatedCount = EVIDENCE_CANDIDATE_EMBEDDING_TOP_N + 1;
  const total = unrelatedCount + EVIDENCE_CANDIDATE_EMBEDDING_TOP_N;
  return Object.freeze(Array.from({ length: total }, (_, index) => {
    const hitsQuery = index >= unrelatedCount;
    return Object.freeze({
      candidateKey: `memory:${String(index).padStart(2, "0")}`,
      evidenceObjectId: `evidence-${String(index).padStart(2, "0")}`,
      documentIdentity: "owner",
      content: hitsQuery
        ? `kubernetes staging pipeline checklist note ${index}`
        : `unrelated garden note ${index}`
    });
  }));
}

function rankKeys(
  result: Awaited<ReturnType<typeof scoreTransientEvidenceCandidates>>
): readonly string[] {
  return [...result.activationsByCandidateKey.entries()]
    .sort((left, right) => {
      if (right[1].score !== left[1].score) return right[1].score - left[1].score;
      return left[0] < right[0] ? -1 : 1;
    })
    .map(([key]) => key);
}

async function scoreWithDeterministicEmbeddings(
  candidates: readonly EvidenceEmbeddingCandidate[]
) {
  const embedTexts = vi.fn(async (texts: readonly string[]) =>
    texts.map((text) => {
      if (text === QUERY_TEXT) return new Float32Array([1, 0]);
      const weight = text.includes("kubernetes") ? 0.9 : 0.1;
      return new Float32Array([weight, Math.sqrt(1 - weight * weight)]);
    })
  );
  const provider = createProvider({ embedTexts });
  const queryEngine = new QueryEmbeddingEngine({
    provider,
    generateQueryId: () => "query-evidence-1",
    queryTimeoutMs: 1000,
    queryEmbeddingCacheSize: 8
  });
  return scoreTransientEvidenceCandidates({
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
    queryEngine,
    queryTimeoutMs: 1000,
    warn: () => undefined
  });
}
