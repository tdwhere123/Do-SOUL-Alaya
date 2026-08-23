import { sortLexicalEvidenceEmbeddingCandidates } from "./evidence-candidate-scoring.js";
import type {
  EvidenceCandidateScoringReceipt,
  EvidenceEmbeddingCandidate
} from "../types.js";

export const EVIDENCE_LEXICAL_PREFIX_ELIGIBILITY_OPERATOR_ID =
  "evidence_lexical_prefix_eligibility_v1" as const;

const EVIDENCE_PREFIX_ELIGIBILITY_PREFIXES = Object.freeze([16, 32, "full"] as const);

export type EvidencePrefixEligibilityLimit = typeof EVIDENCE_PREFIX_ELIGIBILITY_PREFIXES[number];

export type EvidencePrefixEligibilityStatus = "not_applicable" | "returned";

export type EvidencePrefixLiveObservationCompleteness =
  | "complete"
  | "bounded_candidate_prefix"
  | "not_observed";

export type EvidencePrefixScoredWitnesses = ReadonlyMap<
  EvidencePrefixEligibilityLimit,
  ReadonlyMap<string, Readonly<EvidenceCandidateScoringReceipt>>
>;

export interface EvidencePrefixEligibilityEnvelope {
  readonly schema_version: 1;
  readonly operator_id: typeof EVIDENCE_LEXICAL_PREFIX_ELIGIBILITY_OPERATOR_ID;
  readonly status: EvidencePrefixEligibilityStatus;
  readonly pool_size: number;
  readonly receipts: readonly Readonly<EvidencePrefixEligibilityReceipt>[];
}

export interface EvidencePrefixEligibilityReceipt {
  readonly schema_version: 1;
  readonly operator_id: typeof EVIDENCE_LEXICAL_PREFIX_ELIGIBILITY_OPERATOR_ID;
  readonly candidateKey: string;
  readonly evidenceObjectId: string;
  readonly documentIdentity: string;
  readonly prefix: EvidencePrefixEligibilityLimit;
  readonly eligible: boolean;
  readonly lexical_rank: number;
  readonly live_observation_completeness: EvidencePrefixLiveObservationCompleteness;
}

export function auditEvidencePrefixEligibility(
  candidates: readonly Readonly<EvidenceEmbeddingCandidate>[],
  queryText: string,
  liveReceiptsByPrefix?: EvidencePrefixScoredWitnesses
): Readonly<EvidencePrefixEligibilityEnvelope> {
  if (candidates.length === 0) return freezeEnvelope("not_applicable", 0, []);
  const rankByCandidate = new Map(
    sortLexicalEvidenceEmbeddingCandidates(candidates, queryText)
      .map((candidate, index) => [candidate, index + 1] as const)
  );
  return freezeEnvelope("returned", candidates.length, candidates.flatMap((candidate) => {
    const lexicalRank = requireLexicalRank(rankByCandidate, candidate);
    return EVIDENCE_PREFIX_ELIGIBILITY_PREFIXES.map((prefix) => {
      const eligible = prefix === "full" || lexicalRank <= prefix;
      return toPrefixEligibilityReceipt(
        candidate,
        prefix,
        eligible,
        lexicalRank,
        liveWitnessAtPrefix(candidate, prefix, liveReceiptsByPrefix)
      );
    });
  }));
}

function requireLexicalRank(
  rankByCandidate: ReadonlyMap<Readonly<EvidenceEmbeddingCandidate>, number>,
  candidate: Readonly<EvidenceEmbeddingCandidate>
): number {
  const lexicalRank = rankByCandidate.get(candidate);
  if (lexicalRank === undefined) throw new Error("lexical evidence prefix rank missing");
  return lexicalRank;
}

function liveWitnessAtPrefix(
  candidate: Readonly<EvidenceEmbeddingCandidate>,
  prefix: EvidencePrefixEligibilityLimit,
  liveReceiptsByPrefix: EvidencePrefixScoredWitnesses | undefined
): Readonly<EvidenceCandidateScoringReceipt> | undefined {
  const receipt = liveReceiptsByPrefix?.get(prefix)?.get(candidate.candidateKey);
  if (receipt === undefined) return undefined;
  return receipt.observations.some((observation) =>
    observation.evidenceObjectId === candidate.evidenceObjectId &&
    observation.documentIdentity === candidate.documentIdentity
  )
    ? receipt
    : undefined;
}

function reconcileLiveObservationCompleteness(
  eligible: boolean,
  liveReceipt: Readonly<EvidenceCandidateScoringReceipt> | undefined
): EvidencePrefixLiveObservationCompleteness {
  if (!eligible) return "bounded_candidate_prefix";
  if (liveReceipt === undefined) return "not_observed";
  return liveReceipt.observation_completeness;
}

function toPrefixEligibilityReceipt(
  candidate: Readonly<EvidenceEmbeddingCandidate>,
  prefix: EvidencePrefixEligibilityLimit,
  eligible: boolean,
  lexicalRank: number,
  liveReceipt: Readonly<EvidenceCandidateScoringReceipt> | undefined
): Readonly<EvidencePrefixEligibilityReceipt> {
  return Object.freeze({
    schema_version: 1,
    operator_id: EVIDENCE_LEXICAL_PREFIX_ELIGIBILITY_OPERATOR_ID,
    candidateKey: candidate.candidateKey,
    evidenceObjectId: candidate.evidenceObjectId,
    documentIdentity: candidate.documentIdentity,
    prefix,
    eligible,
    lexical_rank: lexicalRank,
    live_observation_completeness: reconcileLiveObservationCompleteness(eligible, liveReceipt)
  });
}

function freezeEnvelope(
  status: EvidencePrefixEligibilityStatus,
  poolSize: number,
  receipts: readonly Readonly<EvidencePrefixEligibilityReceipt>[]
): Readonly<EvidencePrefixEligibilityEnvelope> {
  return Object.freeze({
    schema_version: 1,
    operator_id: EVIDENCE_LEXICAL_PREFIX_ELIGIBILITY_OPERATOR_ID,
    status,
    pool_size: poolSize,
    receipts: Object.freeze(receipts)
  });
}
