import type { RecallQueryProbes } from "../../query/recall-query-probes.js";
import { scoreQueryEvidenceMatch } from "../../scoring/query-evidence-scoring.js";
import {
  buildRecallCandidateDedupeKey,
  compareMemorySemanticIdentity
} from "../../runtime/recall-service-helpers.js";
import type { RecallEvidenceSemanticActivationReceipt } from
  "../../runtime/recall-service-types.js";
import {
  addAnswerHeadProtection,
  selectSemanticMemoryRefinement,
  type AnswerHeadSelection,
  type SemanticHeadCandidate
} from "./semantic-memory-refinement.js";
import {
  DIRECT_EVIDENCE_SCORE_FLOOR,
  findAnswerHeadSourceCandidate,
  hasRequiredQueryMargin,
  retainBoundedAnswerHeads,
  type AnswerHeadSourceCandidate
} from "./answer-head/answer-head-retention.js";
import { retainBehaviorAuthorityAnswerHead } from
  "./answer-head/behavior-authority-answer-head.js";
import {
  constrainSourceSemanticActivationsToAnswerShape,
  selectUniqueMemorySemanticLeader,
  selectUniqueSourceSemanticLeader
} from "./answer-head/source-semantic-answer-head.js";

const DIRECT_EVIDENCE_HEAD_LIMIT = 5;
const DIRECT_EVIDENCE_FTS_RANK_LIMIT = 25;

type DirectEvidenceHeadCandidate = AnswerHeadSourceCandidate;

type ScoredDirectEvidence<T> = Readonly<SemanticHeadCandidate<T> & {
  readonly evidenceFtsRank: number;
  readonly queryScore: number;
}>;

type DirectEvidenceAdmission<T> = Readonly<{
  readonly candidateOrder: readonly T[];
  readonly delivered: readonly T[];
}>;

type SemanticMemoryRefinementPlan<T> = Readonly<{
  readonly leader: SemanticHeadCandidate<T>;
  readonly replacementProtectedCandidateKeys?: readonly string[];
}>;

export type DirectEvidenceHeadOrderOwner =
  | "direct_evidence_promotion"
  | "semantic_memory_refinement"
  | "behavior_authority_promotion";

export type DirectEvidenceHeadSelection<T> = AnswerHeadSelection<T> & Readonly<{
  readonly orderTransitions: readonly Readonly<{
    readonly owner: DirectEvidenceHeadOrderOwner;
    readonly candidates: readonly T[];
  }>[];
}>;
export { retainBoundedAnswerHeads };

type SelectDelivered<T> = (candidates: readonly T[]) => readonly T[];
type IsBehaviorEligible<T> = (candidate: T) => boolean;

export function selectBoundedDirectEvidenceHead<T extends DirectEvidenceHeadCandidate>(
  candidates: readonly T[],
  queryProbes: Readonly<RecallQueryProbes>,
  evidenceSemanticActivationsByCandidateKey: ReadonlyMap<
    string,
    Readonly<RecallEvidenceSemanticActivationReceipt>
  >,
  publicRelevanceByCandidateKey: ReadonlyMap<string, number>,
  maxEntries: number,
  excludedCandidateKeys: ReadonlySet<string>,
  selectDelivered: SelectDelivered<T>,
  isBehaviorEligible: IsBehaviorEligible<T>,
  supportsSingleSemanticLeader = true
): DirectEvidenceHeadSelection<T> {
  const baseline = selectDelivered(candidates);
  const headLimit = Math.min(DIRECT_EVIDENCE_HEAD_LIMIT, maxEntries, baseline.length);
  if (headLimit <= 0) {
    const unchanged = unchangedSelection(candidates);
    return withOrderTransitions(unchanged, unchanged, unchanged);
  }
  const evidence = collectEvidenceCandidates(candidates, queryProbes, excludedCandidateKeys);
  const semanticActivations = constrainSourceSemanticActivationsToAnswerShape(
    supportsSingleSemanticLeader, evidenceSemanticActivationsByCandidateKey
  );
  const semanticLeader = selectUniqueSourceSemanticLeader({
    candidates,
    evidence,
    activations: semanticActivations,
    keyOf: candidateKey,
    compareCandidate: compareStableCandidateIdentity
  });
  const evidenceSelection = selectEvidenceHead(
    candidates, baseline, evidence, semanticLeader, headLimit,
    publicRelevanceByCandidateKey, queryProbes, selectDelivered, isBehaviorEligible
  );
  const refinement = resolveSemanticMemoryRefinementPlan(
    candidates, baseline, evidenceSelection, semanticLeader, headLimit, selectDelivered
  );
  const semanticSelection = applySemanticRefinement({
    evidenceSelection, refinement, headLimit, publicRelevanceByCandidateKey,
    queryProbes, selectDelivered, isBehaviorEligible
  });
  const behaviorSelection = retainBehaviorAuthorityAnswerHead({
    selection: semanticSelection,
    rankLimit: headLimit,
    selectDelivered,
    keyOf: candidateKey,
    isBehaviorEligible
  });
  return withOrderTransitions(
    behaviorSelection,
    evidenceSelection,
    semanticSelection
  );
}

function withOrderTransitions<T>(
  behavior: AnswerHeadSelection<T>,
  evidence: AnswerHeadSelection<T>,
  semantic: AnswerHeadSelection<T>
): DirectEvidenceHeadSelection<T> {
  return Object.freeze({
    ...behavior,
    orderTransitions: Object.freeze([
      Object.freeze({
        owner: "direct_evidence_promotion" as const,
        candidates: evidence.candidates
      }),
      Object.freeze({
        owner: "semantic_memory_refinement" as const,
        candidates: semantic.candidates
      }),
      Object.freeze({
        owner: "behavior_authority_promotion" as const,
        candidates: behavior.candidates
      })
    ])
  });
}

function applySemanticRefinement<T extends DirectEvidenceHeadCandidate>(params: Readonly<{
  readonly evidenceSelection: AnswerHeadSelection<T>;
  readonly refinement: SemanticMemoryRefinementPlan<T> | undefined;
  readonly headLimit: number;
  readonly publicRelevanceByCandidateKey: ReadonlyMap<string, number>;
  readonly queryProbes: Readonly<RecallQueryProbes>;
  readonly selectDelivered: SelectDelivered<T>;
  readonly isBehaviorEligible: IsBehaviorEligible<T>;
}>): AnswerHeadSelection<T> {
  if (params.refinement === undefined) return params.evidenceSelection;
  return selectSemanticMemoryRefinement({
    evidenceSelection: params.evidenceSelection,
    leader: params.refinement.leader,
    headLimit: params.headLimit,
    replacementProtectedCandidateKeys:
      params.refinement.replacementProtectedCandidateKeys,
    comparePublicRelevance: (left, right) =>
      comparePublicRelevance(left, right, params.publicRelevanceByCandidateKey),
    selectDelivered: params.selectDelivered,
    keyOf: candidateKey,
    evidencePermitsVictim: (selection, victim) =>
      protectedEvidencePermitsVictim(selection, victim, params.queryProbes),
    protectionsAreFeasible: (trial, protections, sourceCandidates) =>
      protectionsAreFeasible(
        trial, protections, params.publicRelevanceByCandidateKey,
        params.queryProbes, sourceCandidates, params.isBehaviorEligible
      ),
    resolveSingleReplacement
  });
}

function resolveSemanticMemoryRefinementPlan<T extends DirectEvidenceHeadCandidate>(
  candidates: readonly T[],
  baseline: readonly T[],
  evidenceSelection: AnswerHeadSelection<T>,
  semanticLeader: SemanticHeadCandidate<T> | undefined,
  headLimit: number,
  selectDelivered: SelectDelivered<T>
): SemanticMemoryRefinementPlan<T> | undefined {
  if (semanticLeader === undefined) return undefined;
  if (semanticLeader.candidate.objectKind !== "evidence_capsule") {
    return Object.freeze({ leader: semanticLeader });
  }
  if (headLimit <= 1) return undefined;
  const delivered = evidenceSelection.candidates === candidates
    ? baseline
    : selectDelivered(evidenceSelection.candidates);
  const memoryLeader = selectUniqueMemorySemanticLeader({
    candidates,
    keyOf: candidateKey,
    compareCandidate: compareStableCandidateIdentity
  });
  if (memoryLeader === undefined) return undefined;
  return candidateKeys(delivered).has(semanticLeader.candidateKey)
    ? Object.freeze({
        leader: memoryLeader,
        replacementProtectedCandidateKeys: Object.freeze([
          semanticLeader.candidateKey
        ])
      })
    : Object.freeze({ leader: memoryLeader });
}

function selectEvidenceHead<T extends DirectEvidenceHeadCandidate>(
  candidates: readonly T[],
  baseline: readonly T[],
  evidence: readonly ScoredDirectEvidence<T>[],
  semanticLeader: SemanticHeadCandidate<T> | undefined,
  headLimit: number,
  publicRelevanceByCandidateKey: ReadonlyMap<string, number>,
  queryProbes: Readonly<RecallQueryProbes>,
  selectDelivered: SelectDelivered<T>,
  isBehaviorEligible: IsBehaviorEligible<T>
): AnswerHeadSelection<T> {
  const scored = evidence
    .filter((row) => row.queryScore >= DIRECT_EVIDENCE_SCORE_FLOOR)
    .sort(compareScoredEvidence);
  const baselineKeys = candidateKeys(baseline);
  for (const contender of scored) {
    if (baselineKeys.has(contender.candidateKey)) {
      const rankLimit = resolveEvidenceProtectionRank(
        contender, semanticLeader, baseline, headLimit,
        publicRelevanceByCandidateKey, queryProbes
      );
      if (rankLimit === undefined) continue;
      return protectedSelection(candidates, contender, rankLimit);
    }
    const admission = tryAdmissionPromotion(
      candidates, baseline, baseline[headLimit - 1]!,
      contender, queryProbes, selectDelivered, isBehaviorEligible
    );
    if (admission === undefined) continue;
    const rankLimit = resolveEvidenceProtectionRank(
      contender, semanticLeader, admission.delivered, headLimit,
      publicRelevanceByCandidateKey, queryProbes
    );
    if (rankLimit === undefined) continue;
    return protectedSelection(admission.candidateOrder, contender, rankLimit);
  }
  return unchangedSelection(candidates);
}

function tryAdmissionPromotion<T extends DirectEvidenceHeadCandidate>(
  candidates: readonly T[],
  baseline: readonly T[],
  insertionTarget: T,
  promoted: ScoredDirectEvidence<T>,
  queryProbes: Readonly<RecallQueryProbes>,
  selectDelivered: SelectDelivered<T>,
  isBehaviorEligible: IsBehaviorEligible<T>
): DirectEvidenceAdmission<T> | undefined {
  const trialOrder = moveBefore(candidates, promoted.candidate, insertionTarget);
  const delivered = selectDelivered(trialOrder);
  const replacement = resolveSingleReplacement(
    baseline, delivered, promoted.candidateKey
  );
  return replacement !== undefined &&
    !isBehaviorEligible(replacement) &&
    hasRequiredQueryMargin(promoted.queryScore, replacement.entry, queryProbes)
    ? Object.freeze({ candidateOrder: trialOrder, delivered })
    : undefined;
}

function resolveEvidenceProtectionRank<T extends DirectEvidenceHeadCandidate>(
  contender: ScoredDirectEvidence<T>,
  semanticLeader: SemanticHeadCandidate<T> | undefined,
  delivered: readonly T[],
  headLimit: number,
  publicRelevanceByCandidateKey: ReadonlyMap<string, number>,
  queryProbes: Readonly<RecallQueryProbes>
): number | undefined {
  const publicOrder = [...delivered].sort((left, right) =>
    comparePublicRelevance(left, right, publicRelevanceByCandidateKey)
  );
  if (
    contender.candidateKey === semanticLeader?.candidateKey &&
    protectionPermitsPublicVictim(contender, publicOrder, 1, queryProbes)
  ) return 1;
  return protectionPermitsPublicVictim(
    contender, publicOrder, headLimit, queryProbes
  ) ? headLimit : undefined;
}

function protectionPermitsPublicVictim<T extends DirectEvidenceHeadCandidate>(
  contender: ScoredDirectEvidence<T>,
  publicOrder: readonly T[],
  rankLimit: number,
  queryProbes: Readonly<RecallQueryProbes>
): boolean {
  const contenderIndex = publicOrder.findIndex((candidate) =>
    candidateKey(candidate) === contender.candidateKey);
  if (contenderIndex >= 0 && contenderIndex < rankLimit) return true;
  const victim = publicOrder[rankLimit - 1];
  return victim !== undefined &&
    hasRequiredQueryMargin(contender.queryScore, victim.entry, queryProbes);
}

function protectedEvidencePermitsVictim<T extends DirectEvidenceHeadCandidate>(
  selection: AnswerHeadSelection<T>,
  victim: T,
  queryProbes: Readonly<RecallQueryProbes>
): boolean {
  return selection.protections.every((protection) => {
    if (protection.rankLimit === 1) return true;
    const protectedCandidate = findAnswerHeadSourceCandidate(
      selection.candidates, protection.candidateKey
    );
    return protectedCandidate !== undefined &&
      hasRequiredQueryMargin(
        scoreQueryEvidenceMatch(protectedCandidate.entry, queryProbes),
        victim.entry,
        queryProbes
      );
  });
}

function protectionsAreFeasible<T extends DirectEvidenceHeadCandidate>(
  trial: readonly T[],
  protections: DirectEvidenceHeadSelection<T>["protections"],
  publicRelevanceByCandidateKey: ReadonlyMap<string, number>,
  queryProbes: Readonly<RecallQueryProbes>,
  sourceCandidates: readonly T[],
  isBehaviorEligible: IsBehaviorEligible<T>
): boolean {
  const publicOrder = [...trial].sort((left, right) =>
    comparePublicRelevance(left, right, publicRelevanceByCandidateKey)
  );
  const protectedOrder = retainBoundedAnswerHeads(
    publicOrder, protections, candidateKey, queryProbes, sourceCandidates,
    (key) => {
      const candidate = findAnswerHeadSourceCandidate(sourceCandidates, key);
      return candidate !== undefined && isBehaviorEligible(candidate);
    }
  );
  return protections.every((protection) => {
    const index = protectedOrder.findIndex((candidate) =>
      candidateKey(candidate) === protection.candidateKey
    );
    return index >= 0 && index < protection.rankLimit;
  });
}

function comparePublicRelevance(
  left: DirectEvidenceHeadCandidate,
  right: DirectEvidenceHeadCandidate,
  relevanceByCandidateKey: ReadonlyMap<string, number>
): number {
  const leftKey = candidateKey(left);
  const rightKey = candidateKey(right);
  const leftScore = relevanceByCandidateKey.get(leftKey) ?? left.fusion.fused_score;
  const rightScore = relevanceByCandidateKey.get(rightKey) ?? right.fusion.fused_score;
  return rightScore - leftScore || compareStableCandidateIdentity(left, right);
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

function compareScoredEvidence<T extends DirectEvidenceHeadCandidate>(
  left: ScoredDirectEvidence<T>,
  right: ScoredDirectEvidence<T>
): number {
  return right.queryScore - left.queryScore ||
    left.evidenceFtsRank - right.evidenceFtsRank ||
    compareStableCandidateIdentity(left.candidate, right.candidate);
}

function compareStableCandidateIdentity(
  left: DirectEvidenceHeadCandidate,
  right: DirectEvidenceHeadCandidate
): number {
  return compareMemorySemanticIdentity(left.entry, right.entry) ||
    compareEvidenceSourceIdentity(left, right) ||
    candidateKey(left).localeCompare(candidateKey(right));
}

function compareEvidenceSourceIdentity(
  left: DirectEvidenceHeadCandidate,
  right: DirectEvidenceHeadCandidate
): number {
  return (left.evidenceSourceIdentity ?? "").localeCompare(right.evidenceSourceIdentity ?? "");
}

function unchangedSelection<T>(candidates: readonly T[]): AnswerHeadSelection<T> {
  return Object.freeze({
    candidates,
    protections: Object.freeze([]),
    rejectedCandidateKeys: Object.freeze([])
  });
}

function protectedSelection<T>(
  candidates: readonly T[],
  protectedEvidence: Readonly<{ readonly candidateKey: string }>,
  protectedRankLimit = DIRECT_EVIDENCE_HEAD_LIMIT,
  protections: AnswerHeadSelection<T>["protections"] = []
): AnswerHeadSelection<T> {
  const selection = Object.freeze({
    candidates,
    protections,
    rejectedCandidateKeys: Object.freeze([])
  });
  return addAnswerHeadProtection(selection, protectedEvidence, protectedRankLimit);
}
