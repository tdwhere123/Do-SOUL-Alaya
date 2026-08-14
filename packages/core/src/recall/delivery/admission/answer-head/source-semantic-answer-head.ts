import { OWNER_GIST_SEMANTIC_DOCUMENT_IDENTITY } from
  "@do-soul/alaya-protocol";
import {
  isWorkspaceMemoryCandidate,
  normalizeDriftSensitiveRankingScore
} from "../../../runtime/recall-service-helpers.js";
import {
  type RecallEvidenceSemanticActivationReceipt
} from "../../../runtime/recall-service-results.js";
import type { CoarseRecallCandidate, RecallFusionBreakdown } from
  "../../../runtime/recall-service-types.js";

export type SemanticHeadCandidate<T> = Readonly<{
  readonly candidate: T;
  readonly candidateKey: string;
  readonly index: number;
}>;

export type AnswerHeadSourceCandidate = Readonly<CoarseRecallCandidate & {
  readonly effectiveFactors: Readonly<{ readonly embedding_similarity?: number }>;
  readonly fusion: RecallFusionBreakdown;
}>;

type KeyOf<T> = (candidate: T) => string;
type CompareCandidate<T> = (left: T, right: T) => number;

export function sourceSemanticConsensusIsActive(
  supportsSingleSemanticLeader: boolean,
  activations: ReadonlyMap<string, Readonly<RecallEvidenceSemanticActivationReceipt>>
): boolean {
  if (!supportsSingleSemanticLeader) return false;
  return [...activations.values()].some((activation) =>
    activation.observation_completeness === "complete" &&
    activation.observations.some(isOwnerGistObservation));
}

export function constrainSourceSemanticActivationsToAnswerShape(
  supportsSingleSemanticLeader: boolean,
  activations: ReadonlyMap<string, Readonly<RecallEvidenceSemanticActivationReceipt>>
): ReadonlyMap<string, Readonly<RecallEvidenceSemanticActivationReceipt>> {
  if (supportsSingleSemanticLeader) return activations;
  return new Map([...activations].flatMap(([candidateKey, activation]) => {
    const observations = activation.observations.filter(
      (observation) => !isOwnerGistChannel(observation)
    );
    if (observations.length === activation.observations.length) {
      return [[candidateKey, activation] as const];
    }
    const winner = observations[0];
    return winner === undefined ? [] : [[candidateKey, Object.freeze({
      ...activation,
      score: winner.score,
      winner,
      observations: Object.freeze(observations)
    })] as const];
  }));
}

export function selectUniqueSourceSemanticLeader<
  T extends AnswerHeadSourceCandidate,
  E extends SemanticHeadCandidate<T>
>(params: Readonly<{
  readonly candidates: readonly T[];
  readonly evidence: readonly E[];
  readonly activations: ReadonlyMap<
    string,
    Readonly<RecallEvidenceSemanticActivationReceipt>
  >;
  readonly keyOf: KeyOf<T>;
  readonly compareCandidate: CompareCandidate<T>;
}>): E | SemanticHeadCandidate<T> | undefined {
  const evidenceByKey = new Map(params.evidence.map((row) => [row.candidateKey, row]));
  const ranked = params.candidates.flatMap((candidate, index) => {
    const candidateKey = params.keyOf(candidate);
    const score = semanticActivation(candidate, candidateKey, params.activations);
    return score === undefined ? [] : [{
      candidate, candidateKey, index,
      score: normalizeDriftSensitiveRankingScore(score),
      evidenceCandidate: evidenceByKey.get(candidateKey)
    }];
  }).sort((left, right) => right.score - left.score ||
    params.compareCandidate(left.candidate, right.candidate));
  if (ranked.length === 0 || ranked[1]?.score === ranked[0]!.score) return undefined;
  const leader = ranked[0]!;
  if (leader.candidate.objectKind === "evidence_capsule") {
    return leader.evidenceCandidate;
  }
  return isWorkspaceMemoryCandidate(leader.candidate)
    ? Object.freeze({ candidate: leader.candidate, candidateKey: leader.candidateKey,
        index: leader.index })
    : undefined;
}

export function selectUniqueMemorySemanticLeader<
  T extends AnswerHeadSourceCandidate
>(params: Readonly<{
  readonly candidates: readonly T[];
  readonly keyOf: KeyOf<T>;
  readonly compareCandidate: CompareCandidate<T>;
}>): SemanticHeadCandidate<T> | undefined {
  const ranked = params.candidates.flatMap((candidate, index) => {
    const score = validScore(candidate.effectiveFactors.embedding_similarity);
    return isWorkspaceMemoryCandidate(candidate) && score !== undefined
      ? [{ candidate, candidateKey: params.keyOf(candidate), index,
          score: normalizeDriftSensitiveRankingScore(score) }]
      : [];
  }).sort((left, right) => right.score - left.score ||
    params.compareCandidate(left.candidate, right.candidate));
  return ranked.length > 0 && ranked[1]?.score !== ranked[0]!.score
    ? ranked[0] : undefined;
}

export function resolveSourceSemanticRanks<T extends AnswerHeadSourceCandidate>(
  candidates: readonly T[],
  activations: ReadonlyMap<string, Readonly<RecallEvidenceSemanticActivationReceipt>>,
  keyOf: KeyOf<T>
): ReadonlyMap<string, number> {
  const entryRanks = rankScores(new Map(candidates.flatMap((candidate) => {
    const score = validScore(candidate.effectiveFactors.embedding_similarity);
    return score === undefined ? [] : [[keyOf(candidate), score] as const];
  })));
  const gistRanks = rankScores(new Map(candidates.flatMap((candidate) => {
    const score = ownerGistScore(activations.get(keyOf(candidate)));
    return score === undefined ? [] : [[keyOf(candidate), score] as const];
  })));
  return rankScores(new Map(candidates.map((candidate) => {
    const key = keyOf(candidate);
    return [key, reciprocalRank(entryRanks.get(key)) + reciprocalRank(gistRanks.get(key))];
  })));
}

function rankScores(scores: ReadonlyMap<string, number>): ReadonlyMap<string, number> {
  return new Map([...scores]
    .filter(([, score]) => Number.isFinite(score) && score > 0)
    .sort(([leftKey, left], [rightKey, right]) =>
      right - left || leftKey.localeCompare(rightKey))
    .map(([key], index) => [key, index + 1]));
}

function semanticActivation<T extends AnswerHeadSourceCandidate>(
  candidate: T,
  candidateKey: string,
  activations: ReadonlyMap<string, Readonly<RecallEvidenceSemanticActivationReceipt>>
): number | undefined {
  const linked = validScore(activations.get(candidateKey)?.score);
  if (candidate.objectKind === "evidence_capsule") return linked;
  const entry = validScore(candidate.effectiveFactors.embedding_similarity);
  return entry === undefined ? linked : linked === undefined ? entry : Math.max(entry, linked);
}

function ownerGistScore(
  activation: Readonly<RecallEvidenceSemanticActivationReceipt> | undefined
): number | undefined {
  if (activation?.observation_completeness !== "complete") return undefined;
  return activation.observations
    .filter(isOwnerGistObservation)
    .reduce<number | undefined>((best, observation) =>
      best === undefined ? observation.score : Math.max(best, observation.score), undefined);
}

function isOwnerGistObservation(
  observation: Readonly<RecallEvidenceSemanticActivationReceipt>["observations"][number]
): boolean {
  return isOwnerGistChannel(observation) &&
    validScore(observation.score) !== undefined;
}

function isOwnerGistChannel(
  observation: Readonly<RecallEvidenceSemanticActivationReceipt>["observations"][number]
): boolean {
  return observation.documentIdentity === OWNER_GIST_SEMANTIC_DOCUMENT_IDENTITY &&
    observation.projection?.projection_kind === "owner";
}

function reciprocalRank(rank: number | undefined): number {
  return rank === undefined ? 0 : 1 / (60 + rank);
}

function validScore(score: number | undefined): number | undefined {
  return score !== undefined && Number.isFinite(score) && score > 0 ? score : undefined;
}
