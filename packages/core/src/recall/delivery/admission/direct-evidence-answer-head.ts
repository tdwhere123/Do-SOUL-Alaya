import type { RecallQueryProbes } from "../../query/recall-query-probes.js";
import { scoreQueryEvidenceMatch } from "../../scoring/query-evidence-scoring.js";
import {
  buildRecallCandidateDedupeKey
} from "../../runtime/recall-service-helpers.js";
import type {
  CoarseRecallCandidate,
  RecallFusionBreakdown
} from "../../runtime/recall-service-types.js";

const DIRECT_EVIDENCE_HEAD_LIMIT = 5;
const DIRECT_EVIDENCE_FTS_RANK_LIMIT = 25;
const DIRECT_EVIDENCE_SCORE_FLOOR = 0.2;
const DIRECT_EVIDENCE_SCORE_MARGIN = 0.15;

type DirectEvidenceHeadCandidate = Readonly<CoarseRecallCandidate & {
  readonly effectiveFactors: Readonly<{ readonly embedding_similarity?: number }>;
  readonly fusion: RecallFusionBreakdown;
}>;

type ScoredDirectEvidence<T> = Readonly<{
  readonly candidate: T;
  readonly candidateKey: string;
  readonly evidenceFtsRank: number;
  readonly queryScore: number;
  readonly index: number;
}>;

export type DirectEvidenceHeadSelection<T> = Readonly<{
  readonly candidates: readonly T[];
  readonly protectedCandidateKey: string | null;
  readonly protectedRankLimit: number | null;
}>;

type SelectDelivered<T> = (candidates: readonly T[]) => readonly T[];
type BlocksEvidenceHead<T> = (candidate: T) => boolean;

export function selectBoundedDirectEvidenceHead<T extends DirectEvidenceHeadCandidate>(
  candidates: readonly T[],
  queryProbes: Readonly<RecallQueryProbes>,
  evidenceSemanticScoresByCandidateKey: ReadonlyMap<string, number>,
  maxEntries: number,
  excludedCandidateKeys: ReadonlySet<string>,
  selectDelivered: SelectDelivered<T>,
  blocksEvidenceHead: BlocksEvidenceHead<T>
): DirectEvidenceHeadSelection<T> {
  const baseline = selectDelivered(candidates);
  if (baseline.some(blocksEvidenceHead)) return unchangedSelection(candidates);
  const headLimit = Math.min(DIRECT_EVIDENCE_HEAD_LIMIT, maxEntries, baseline.length);
  if (headLimit <= 0) return unchangedSelection(candidates);
  const evidence = collectEvidenceCandidates(candidates, queryProbes, excludedCandidateKeys);
  const semanticLeader = selectUniqueSemanticLeader(
    candidates, evidence, evidenceSemanticScoresByCandidateKey
  );
  if (semanticLeader !== undefined) {
    return selectSemanticHead(candidates, baseline, semanticLeader, selectDelivered);
  }
  const scored = evidence.filter((row) => row.queryScore >= DIRECT_EVIDENCE_SCORE_FLOOR);
  const headKeys = candidateKeys(baseline.slice(0, headLimit));
  const baselineKeys = candidateKeys(baseline);
  const existingHead = bestEvidence(scored.filter((row) => headKeys.has(row.candidateKey)));
  if (existingHead !== undefined) return protectedSelection(candidates, existingHead);
  const existingTail = bestEvidence(scored.filter((row) => baselineKeys.has(row.candidateKey)));
  if (existingTail !== undefined) return protectedSelection(candidates, existingTail);
  return selectAdmissionPromotion(
    candidates, baseline, baseline[headLimit - 1]!,
    scored, queryProbes, selectDelivered
  );
}

export function retainBoundedDirectEvidenceHead<T>(
  candidates: readonly T[],
  protectedCandidateKey: string | null,
  protectedRankLimit: number | null,
  keyOf: (candidate: T) => string,
  queryProbes: Readonly<RecallQueryProbes>,
  sourceCandidates: readonly DirectEvidenceHeadCandidate[]
): readonly T[] {
  if (protectedCandidateKey === null || protectedRankLimit === null) return candidates;
  const index = candidates.findIndex((candidate) => keyOf(candidate) === protectedCandidateKey);
  if (index < protectedRankLimit) return candidates;
  if (protectedRankLimit === 1) {
    return moveToRank(candidates, index, protectedRankLimit);
  }
  const protectedSource = findSourceCandidate(sourceCandidates, protectedCandidateKey);
  const victimSource = findSourceCandidate(
    sourceCandidates,
    keyOf(candidates[protectedRankLimit - 1]!)
  );
  if (
    protectedSource === undefined ||
    victimSource === undefined ||
    !hasRequiredQueryMargin(
      scoreQueryEvidenceMatch(protectedSource.entry, queryProbes),
      victimSource.entry,
      queryProbes
    )
  ) return candidates;
  return moveToRank(candidates, index, protectedRankLimit);
}

function moveToRank<T>(
  candidates: readonly T[],
  index: number,
  rankLimit: number
): readonly T[] {
  const reordered = [...candidates];
  const [candidate] = reordered.splice(index, 1);
  reordered.splice(rankLimit - 1, 0, candidate!);
  return Object.freeze(reordered);
}

function findSourceCandidate(
  candidates: readonly DirectEvidenceHeadCandidate[],
  candidateKey: string
): DirectEvidenceHeadCandidate | undefined {
  return candidates.find((candidate) =>
    buildRecallCandidateDedupeKey(candidate) === candidateKey);
}

function selectAdmissionPromotion<T extends DirectEvidenceHeadCandidate>(
  candidates: readonly T[],
  baseline: readonly T[],
  insertionTarget: T,
  scored: readonly ScoredDirectEvidence<T>[],
  queryProbes: Readonly<RecallQueryProbes>,
  selectDelivered: SelectDelivered<T>
): DirectEvidenceHeadSelection<T> {
  const baselineKeys = candidateKeys(baseline);
  const candidatesToTry = scored.filter((row) => !baselineKeys.has(row.candidateKey))
    .sort(compareScoredEvidence);
  for (const promoted of candidatesToTry) {
    const trialOrder = moveBefore(candidates, promoted.candidate, insertionTarget);
    const replacement = resolveSingleReplacement(
      baseline, selectDelivered(trialOrder), promoted.candidateKey
    );
    if (
      replacement !== undefined &&
      hasRequiredQueryMargin(promoted.queryScore, replacement.entry, queryProbes)
    ) return protectedSelection(trialOrder, promoted);
  }
  return unchangedSelection(candidates);
}

function selectSemanticHead<T extends DirectEvidenceHeadCandidate>(
  candidates: readonly T[],
  baseline: readonly T[],
  leader: ScoredDirectEvidence<T>,
  selectDelivered: SelectDelivered<T>
): DirectEvidenceHeadSelection<T> {
  if (candidateKeys(baseline).has(leader.candidateKey)) {
    return protectedSelection(candidates, leader, 1);
  }
  const trialOrder = moveBefore(candidates, leader.candidate, baseline[0]!);
  const replacement = resolveSingleReplacement(
    baseline, selectDelivered(trialOrder), leader.candidateKey
  );
  return replacement === undefined
    ? unchangedSelection(candidates)
    : protectedSelection(trialOrder, leader, 1);
}

function resolveSingleReplacement<T extends DirectEvidenceHeadCandidate>(
  baseline: readonly T[],
  trial: readonly T[],
  promotedKey: string
): T | undefined {
  const baselineKeys = candidateKeys(baseline);
  const trialKeys = candidateKeys(trial);
  const added = trial.filter((candidate) => !baselineKeys.has(candidateKey(candidate)));
  const dropped = baseline.filter((candidate) => !trialKeys.has(candidateKey(candidate)));
  return added.length === 1 &&
    dropped.length === 1 &&
    candidateKey(added[0]!) === promotedKey
    ? dropped[0]
    : undefined;
}

function moveBefore<T extends DirectEvidenceHeadCandidate>(
  candidates: readonly T[],
  promoted: T,
  target: T
): readonly T[] {
  const promotedKey = candidateKey(promoted);
  const withoutPromoted = candidates.filter((candidate) =>
    candidateKey(candidate) !== promotedKey);
  const targetIndex = withoutPromoted.findIndex((candidate) =>
    candidateKey(candidate) === candidateKey(target));
  if (targetIndex < 0) return candidates;
  const reordered = [...withoutPromoted];
  reordered.splice(targetIndex, 0, promoted);
  return Object.freeze(reordered);
}

function candidateKeys<T extends DirectEvidenceHeadCandidate>(
  candidates: readonly T[]
): ReadonlySet<string> {
  return new Set(candidates.map(candidateKey));
}

function candidateKey(candidate: DirectEvidenceHeadCandidate): string {
  return buildRecallCandidateDedupeKey(candidate);
}

function bestEvidence<T>(
  candidates: readonly ScoredDirectEvidence<T>[]
): ScoredDirectEvidence<T> | undefined {
  return [...candidates].sort(compareScoredEvidence)[0];
}

function hasRequiredQueryMargin(
  candidateScore: number,
  victimEntry: DirectEvidenceHeadCandidate["entry"],
  queryProbes: Readonly<RecallQueryProbes>
): boolean {
  return candidateScore >= DIRECT_EVIDENCE_SCORE_FLOOR &&
    candidateScore - scoreQueryEvidenceMatch(victimEntry, queryProbes) >=
      DIRECT_EVIDENCE_SCORE_MARGIN;
}

function collectEvidenceCandidates<T extends DirectEvidenceHeadCandidate>(
  candidates: readonly T[],
  queryProbes: Readonly<RecallQueryProbes>,
  excludedCandidateKeys: ReadonlySet<string>
): readonly ScoredDirectEvidence<T>[] {
  const eligible: ScoredDirectEvidence<T>[] = [];
  candidates.forEach((candidate, index) => {
    const candidateKey = buildRecallCandidateDedupeKey(candidate);
    const evidenceFtsRank = candidate.fusion.per_stream_rank.evidence_fts;
    if (
      candidate.objectKind !== "evidence_capsule" ||
      excludedCandidateKeys.has(candidateKey) ||
      evidenceFtsRank === null ||
      !Number.isFinite(evidenceFtsRank) ||
      evidenceFtsRank <= 0 ||
      evidenceFtsRank > DIRECT_EVIDENCE_FTS_RANK_LIMIT
    ) return;
    const queryScore = scoreQueryEvidenceMatch(candidate.entry, queryProbes);
    eligible.push(Object.freeze({
      candidate,
      candidateKey,
      evidenceFtsRank,
      queryScore,
      index
    }));
  });
  return eligible;
}

function selectUniqueSemanticLeader<T extends DirectEvidenceHeadCandidate>(
  candidates: readonly T[],
  evidence: readonly ScoredDirectEvidence<T>[],
  evidenceScores: ReadonlyMap<string, number>
): ScoredDirectEvidence<T> | undefined {
  const ranked = candidates.flatMap((candidate) => {
    const candidateKey = buildRecallCandidateDedupeKey(candidate);
    const score = candidate.objectKind === "evidence_capsule"
      ? evidenceScores.get(candidateKey)
      : candidate.effectiveFactors.embedding_similarity;
    return score !== undefined && Number.isFinite(score) && score > 0
      ? [{ candidateKey, score }]
      : [];
  }).sort((left, right) => right.score - left.score);
  if (ranked.length === 0 || ranked[1]?.score === ranked[0]!.score) return undefined;
  return evidence.find((row) => row.candidateKey === ranked[0]!.candidateKey);
}

function compareScoredEvidence<T>(
  left: ScoredDirectEvidence<T>,
  right: ScoredDirectEvidence<T>
): number {
  return right.queryScore - left.queryScore ||
    left.evidenceFtsRank - right.evidenceFtsRank ||
    left.candidateKey.localeCompare(right.candidateKey);
}

function unchangedSelection<T>(candidates: readonly T[]): DirectEvidenceHeadSelection<T> {
  return Object.freeze({
    candidates,
    protectedCandidateKey: null,
    protectedRankLimit: null
  });
}

function protectedSelection<T>(
  candidates: readonly T[],
  protectedEvidence: ScoredDirectEvidence<T>,
  protectedRankLimit = DIRECT_EVIDENCE_HEAD_LIMIT
): DirectEvidenceHeadSelection<T> {
  return Object.freeze({
    candidates,
    protectedCandidateKey: protectedEvidence.candidateKey,
    protectedRankLimit
  });
}
