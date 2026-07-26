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
}>;

type SelectDelivered<T> = (candidates: readonly T[]) => readonly T[];
type BlocksEvidenceHead<T> = (candidate: T) => boolean;

export function selectBoundedDirectEvidenceHead<T extends DirectEvidenceHeadCandidate>(
  candidates: readonly T[],
  queryProbes: Readonly<RecallQueryProbes>,
  maxEntries: number,
  excludedCandidateKeys: ReadonlySet<string>,
  selectDelivered: SelectDelivered<T>,
  blocksEvidenceHead: BlocksEvidenceHead<T>
): DirectEvidenceHeadSelection<T> {
  const baseline = selectDelivered(candidates);
  if (baseline.some(blocksEvidenceHead)) return unchangedSelection(candidates);
  const headLimit = Math.min(DIRECT_EVIDENCE_HEAD_LIMIT, maxEntries, baseline.length);
  if (headLimit <= 0) return unchangedSelection(candidates);
  const scored = collectEligibleEvidence(candidates, queryProbes, excludedCandidateKeys);
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
  keyOf: (candidate: T) => string,
  queryProbes: Readonly<RecallQueryProbes>,
  sourceCandidates: readonly DirectEvidenceHeadCandidate[]
): readonly T[] {
  if (protectedCandidateKey === null) return candidates;
  const index = candidates.findIndex((candidate) => keyOf(candidate) === protectedCandidateKey);
  if (index < DIRECT_EVIDENCE_HEAD_LIMIT) return candidates;
  const protectedSource = findSourceCandidate(sourceCandidates, protectedCandidateKey);
  const victimSource = findSourceCandidate(
    sourceCandidates,
    keyOf(candidates[DIRECT_EVIDENCE_HEAD_LIMIT - 1]!)
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
  const reordered = [...candidates];
  const [candidate] = reordered.splice(index, 1);
  reordered.splice(DIRECT_EVIDENCE_HEAD_LIMIT - 1, 0, candidate!);
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

function collectEligibleEvidence<T extends DirectEvidenceHeadCandidate>(
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
    if (queryScore < DIRECT_EVIDENCE_SCORE_FLOOR) return;
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

function compareScoredEvidence<T>(
  left: ScoredDirectEvidence<T>,
  right: ScoredDirectEvidence<T>
): number {
  return right.queryScore - left.queryScore ||
    left.evidenceFtsRank - right.evidenceFtsRank ||
    left.candidateKey.localeCompare(right.candidateKey);
}

function unchangedSelection<T>(candidates: readonly T[]): DirectEvidenceHeadSelection<T> {
  return Object.freeze({ candidates, protectedCandidateKey: null });
}

function protectedSelection<T>(
  candidates: readonly T[],
  protectedEvidence: ScoredDirectEvidence<T>
): DirectEvidenceHeadSelection<T> {
  return Object.freeze({
    candidates,
    protectedCandidateKey: protectedEvidence.candidateKey
  });
}
