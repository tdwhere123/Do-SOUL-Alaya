import {
  FAMILY_GROUPED_COMPOSITION_OPERATOR_ID,
  counterfactualDeliveredCandidateKeys,
  type FamilyGroupedScores,
  type FineAssessmentMembershipOwner,
  type FineAssessmentOrderLedger,
  type SelectionCompositionReconstruction
} from "@do-soul/alaya-core";
import type { SelectionBoundaryArtifactRecord } from
  "./selection-boundary-artifact-reader.js";
import {
  anyGoldInHead,
  fullGoldInHead,
  goldObjectsInHead,
  sameMembership,
  sameOrder
} from "./selection-boundary-counterfactual-metrics.js";
import type { SelectionReplayGoldQuestion } from
  "./selection-boundary-gold-map.js";

const PROTECTION_OWNERS: readonly FineAssessmentMembershipOwner[] = [
  "fusion",
  "deep_head",
  "coverage",
  "direct_evidence_promotion",
  "semantic_memory_refinement",
  "behavior_authority_promotion",
  "verified_temporal_head",
  "consensus",
  "final_budget",
  "unavailable"
];

export type FeasibilityProtectionDelta = Readonly<{
  readonly gained: number;
  readonly lost: number;
}>;

export type FeasibilityProtectionDeltas = Readonly<
  Record<FineAssessmentMembershipOwner, FeasibilityProtectionDelta>
>;

export type SelectionOrderLedgerRecomputeQuestion = Readonly<{
  readonly ledger: FineAssessmentOrderLedger;
  readonly captured_delivered_keys: readonly string[];
  readonly live_delivered_keys: readonly string[];
  readonly family_scores: Readonly<Record<string, FamilyGroupedScores>>;
  readonly gold: Readonly<{
    readonly answerable: boolean;
    readonly gold_object_ids: readonly string[];
    readonly any_at_1: boolean;
    readonly any_at_5: boolean;
    readonly any_at_10: boolean;
    readonly full_gold_at_5: boolean;
    readonly gold_objects_total: number;
    readonly gold_objects_at_5: number;
  }>;
}>;

export type SelectionOrderLedgerRecomputeSummary = Readonly<{
  readonly formula_operator_id: typeof FAMILY_GROUPED_COMPOSITION_OPERATOR_ID;
  readonly answerable_count: number;
  readonly any_at_1: number;
  readonly any_at_5: number;
  readonly any_at_10: number;
  readonly full_gold_at_5: number;
  readonly gold_bearing_count: number;
  readonly gold_objects_total: number;
  readonly gold_objects_at_5: number;
  readonly coverage_at_5: number;
  readonly membership_churn_questions: number;
  readonly order_churn_questions: number;
  readonly feasibility_protection_deltas: FeasibilityProtectionDeltas;
}>;

type RecomputeAccumulator = {
  answerableCount: number;
  anyAt1: number;
  anyAt5: number;
  anyAt10: number;
  fullGoldAt5: number;
  goldBearingCount: number;
  goldObjectsTotal: number;
  goldObjectsAt5: number;
  membershipChurnQuestions: number;
  orderChurnQuestions: number;
  protection: Record<FineAssessmentMembershipOwner, {
    gained: number;
    lost: number;
  }>;
};

export function createRecomputeAccumulator(): RecomputeAccumulator {
  return {
    answerableCount: 0,
    anyAt1: 0,
    anyAt5: 0,
    anyAt10: 0,
    fullGoldAt5: 0,
    goldBearingCount: 0,
    goldObjectsTotal: 0,
    goldObjectsAt5: 0,
    membershipChurnQuestions: 0,
    orderChurnQuestions: 0,
    protection: Object.fromEntries(
      PROTECTION_OWNERS.map((owner) => [owner, { gained: 0, lost: 0 }])
    ) as RecomputeAccumulator["protection"]
  };
}

export function buildRecomputeQuestionPayload(
  record: SelectionBoundaryArtifactRecord,
  reconstruction: SelectionCompositionReconstruction,
  ledger: FineAssessmentOrderLedger,
  goldByQuestion: ReadonlyMap<string, SelectionReplayGoldQuestion>
): SelectionOrderLedgerRecomputeQuestion {
  const gold = goldByQuestion.get(record.question_id);
  if (gold === undefined) {
    throw new Error(
      `selection order ledger missing gold map entry for ${record.question_id}`
    );
  }
  const capturedKeys = record.boundary.expected.candidate_keys;
  const liveKeys = counterfactualDeliveredCandidateKeys(reconstruction.result);
  return Object.freeze({
    ledger,
    captured_delivered_keys: capturedKeys,
    live_delivered_keys: liveKeys,
    family_scores: familyScoresByCandidateKey(reconstruction),
    gold: goldReceipt(liveKeys, gold)
  });
}

export function accumulateRecomputeQuestion(
  acc: RecomputeAccumulator,
  question: SelectionOrderLedgerRecomputeQuestion
): void {
  accumulateMembershipDeltas(acc, question);
  if (!question.gold.answerable) return;
  acc.answerableCount += 1;
  if (question.gold.any_at_1) acc.anyAt1 += 1;
  if (question.gold.any_at_5) acc.anyAt5 += 1;
  if (question.gold.any_at_10) acc.anyAt10 += 1;
  if (question.gold.gold_objects_total === 0) return;
  acc.goldBearingCount += 1;
  acc.goldObjectsTotal += question.gold.gold_objects_total;
  acc.goldObjectsAt5 += question.gold.gold_objects_at_5;
  if (question.gold.full_gold_at_5) acc.fullGoldAt5 += 1;
}

export function rollupRecomputeSummary(
  acc: RecomputeAccumulator
): SelectionOrderLedgerRecomputeSummary {
  return Object.freeze({
    formula_operator_id: FAMILY_GROUPED_COMPOSITION_OPERATOR_ID,
    answerable_count: acc.answerableCount,
    any_at_1: acc.anyAt1,
    any_at_5: acc.anyAt5,
    any_at_10: acc.anyAt10,
    full_gold_at_5: acc.fullGoldAt5,
    gold_bearing_count: acc.goldBearingCount,
    gold_objects_total: acc.goldObjectsTotal,
    gold_objects_at_5: acc.goldObjectsAt5,
    coverage_at_5: acc.goldObjectsTotal === 0
      ? 0
      : acc.goldObjectsAt5 / acc.goldObjectsTotal,
    membership_churn_questions: acc.membershipChurnQuestions,
    order_churn_questions: acc.orderChurnQuestions,
    feasibility_protection_deltas: freezeProtectionDeltas(acc.protection)
  });
}

function familyScoresByCandidateKey(
  reconstruction: SelectionCompositionReconstruction
): Readonly<Record<string, FamilyGroupedScores>> {
  const traces = reconstruction.deepHead.traceByCandidateKey;
  if (traces.size === 0 && reconstruction.deepHead.scores.size > 0) {
    throw new Error("recompute_live missing family score receipts");
  }
  const receipts: Record<string, FamilyGroupedScores> = {};
  for (const [key, trace] of traces) {
    if (trace.family_scores === undefined) {
      throw new Error(`recompute_live missing family_scores for ${key}`);
    }
    receipts[key] = trace.family_scores;
  }
  return Object.freeze(receipts);
}

function goldReceipt(
  liveKeys: readonly string[],
  gold: SelectionReplayGoldQuestion
): SelectionOrderLedgerRecomputeQuestion["gold"] {
  return Object.freeze({
    answerable: gold.answerable,
    gold_object_ids: gold.goldObjectIds,
    any_at_1: anyGoldInHead(liveKeys, gold.goldObjectIds, 1),
    any_at_5: anyGoldInHead(liveKeys, gold.goldObjectIds, 5),
    any_at_10: anyGoldInHead(liveKeys, gold.goldObjectIds, 10),
    full_gold_at_5: fullGoldInHead(liveKeys, gold.goldObjectIds, 5),
    gold_objects_total: gold.goldObjectIds.length,
    gold_objects_at_5: goldObjectsInHead(liveKeys, gold.goldObjectIds, 5)
  });
}

function accumulateMembershipDeltas(
  acc: RecomputeAccumulator,
  question: SelectionOrderLedgerRecomputeQuestion
): void {
  const captured = question.captured_delivered_keys;
  const live = question.live_delivered_keys;
  if (!sameMembership(captured, live)) acc.membershipChurnQuestions += 1;
  if (!sameOrder(captured, live)) acc.orderChurnQuestions += 1;
  const capturedSet = new Set(captured);
  const liveSet = new Set(live);
  for (const candidate of question.ledger.candidates) {
    const owner = candidate.first_membership_changing_owner ?? "unavailable";
    const wasCaptured = capturedSet.has(candidate.candidate_key);
    const isLive = liveSet.has(candidate.candidate_key);
    if (isLive && !wasCaptured) acc.protection[owner].gained += 1;
    if (wasCaptured && !isLive) acc.protection[owner].lost += 1;
  }
}

function freezeProtectionDeltas(
  protection: RecomputeAccumulator["protection"]
): FeasibilityProtectionDeltas {
  return Object.freeze(Object.fromEntries(
    PROTECTION_OWNERS.map((owner) => [
      owner,
      Object.freeze({
        gained: protection[owner].gained,
        lost: protection[owner].lost
      })
    ])
  )) as FeasibilityProtectionDeltas;
}
