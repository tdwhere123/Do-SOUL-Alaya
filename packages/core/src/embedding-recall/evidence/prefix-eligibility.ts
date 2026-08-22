import {
  selectLexicalEvidenceEmbeddingPrefix,
  sortLexicalEvidenceEmbeddingCandidates
} from "./evidence-candidate-scoring.js";
import type {
  EvidenceCandidateScoringReceipt,
  EvidenceEmbeddingCandidate
} from "../types.js";

const EVIDENCE_PREFIX_ELIGIBILITY_PREFIXES = Object.freeze([16, 32, "full"] as const);

export type EvidencePrefixEligibilityLimit = typeof EVIDENCE_PREFIX_ELIGIBILITY_PREFIXES[number];

export interface EvidencePrefixEligibilityReceipt {
  readonly candidateKey: string;
  readonly evidenceObjectId: string;
  readonly documentIdentity: string;
  readonly prefix: EvidencePrefixEligibilityLimit;
  readonly eligible: boolean;
  readonly observation_completeness: EvidenceCandidateScoringReceipt["observation_completeness"];
  readonly lexical_rank: number;
  // Unscored prefix members cannot support a representation conclusion.
  readonly degenerate_embedded_text?: boolean;
}

export function auditEvidencePrefixEligibility(
  candidates: readonly Readonly<EvidenceEmbeddingCandidate>[],
  queryText: string,
  cosineByCandidateKey?: ReadonlyMap<string, number>
): readonly Readonly<EvidencePrefixEligibilityReceipt>[] {
  const rankByCandidate = new Map(
    sortLexicalEvidenceEmbeddingCandidates(candidates, queryText)
      .map((candidate, index) => [candidate, index + 1] as const)
  );
  const selectedAt16 = new Set(selectLexicalEvidenceEmbeddingPrefix(candidates, queryText, 16));
  const selectedAt32 = new Set(selectLexicalEvidenceEmbeddingPrefix(candidates, queryText, 32));
  return Object.freeze(candidates.flatMap((candidate) => {
    const lexicalRank = rankByCandidate.get(candidate)!;
    const cosine = cosineByCandidateKey?.get(candidate.candidateKey);
    return EVIDENCE_PREFIX_ELIGIBILITY_PREFIXES.map((prefix) => toPrefixEligibilityReceipt(
      candidate,
      prefix,
      isEligibleAtPrefix(prefix, candidate, selectedAt16, selectedAt32),
      lexicalRank,
      cosine
    ));
  }));
}

function isEligibleAtPrefix(
  prefix: EvidencePrefixEligibilityLimit,
  candidate: Readonly<EvidenceEmbeddingCandidate>,
  selectedAt16: ReadonlySet<Readonly<EvidenceEmbeddingCandidate>>,
  selectedAt32: ReadonlySet<Readonly<EvidenceEmbeddingCandidate>>
): boolean {
  if (prefix === "full") return true;
  return prefix === 16 ? selectedAt16.has(candidate) : selectedAt32.has(candidate);
}

function toPrefixEligibilityReceipt(
  candidate: Readonly<EvidenceEmbeddingCandidate>,
  prefix: EvidencePrefixEligibilityLimit,
  eligible: boolean,
  lexicalRank: number,
  cosine: number | undefined
): Readonly<EvidencePrefixEligibilityReceipt> {
  return Object.freeze({
    candidateKey: candidate.candidateKey,
    evidenceObjectId: candidate.evidenceObjectId,
    documentIdentity: candidate.documentIdentity,
    prefix,
    eligible,
    observation_completeness: eligible ? "complete" : "bounded_candidate_prefix",
    lexical_rank: lexicalRank,
    ...(eligible && cosine !== undefined ? { degenerate_embedded_text: cosine === 0 } : {})
  });
}
