import { isDeepStrictEqual } from "node:util";
import {
  hasStructuralPlane,
  isDeliveryBudgetLoss
} from "../../diagnostics/schema/diagnostics-private.js";
import { classifyReplayGoldDeliveryMissTaxonomy } from
  "../../diagnostics/miss/diagnostics-delivery-bridge.js";
import { classifyQuestionMissTaxonomy } from "../../diagnostics/miss/diagnostics-miss-taxonomy.js";
import {
  verifyPromotionCandidatePoolClosure,
  type VerifiedPromotionCandidatePool
} from "./candidate-pool-verifier.js";
import type {
  LongMemEvalGoldDiagnostic,
  LongMemEvalQuestionDiagnostic,
  LongMemEvalReplayCandidate
} from "../../diagnostics/schema/diagnostics-types.js";
import {
  deriveQuestionEvaluationIssueReason,
  deriveQuestionExtractionMaterialization
} from "../../diagnostics/diagnostics-cohort.js";
import {
  buildGoldObjectIds,
  type LongMemEvalGoldObjectIdentity
} from "../../diagnostics/gold-object-identities.js";

export interface VerifiedPromotionHits {
  readonly hitAt1: boolean;
  readonly hitAt5: boolean;
  readonly hitAt10: boolean;
}

export function verifyPromotionGoldEvidence(input: {
  readonly question: LongMemEvalQuestionDiagnostic;
  readonly expectedGold?: readonly string[];
  readonly expectedGoldIdentities?: readonly LongMemEvalGoldObjectIdentity[];
  readonly scorable: boolean;
}): VerifiedPromotionHits {
  const expectedGold = resolveExpectedGoldIdentities(input);
  const question = input.question;
  const candidatePool = verifyPromotionCandidatePoolClosure(question);
  const candidateByIdentity = candidatePool.scoredByIdentity;
  assertDeliveredCandidateBinding(question, candidateByIdentity);
  const deliveredRank = indexDeliveredObjects(question);
  const activeRank = indexActiveConstraints(question);
  const expectedRows = expectedGold.map((gold) => {
    const key = identityKey(gold);
    const candidate = candidateByIdentity.get(key);
    return expectedGoldProjection(
      gold,
      candidate,
      candidate === undefined && candidatePool.finePrunedByIdentity.has(key),
      deliveredRank.get(key) ?? null,
      gold.objectKind === "memory_entry"
        ? activeRank.get(gold.objectId) ?? null
        : null
    );
  });
  assertGoldIdentity(question, expectedGold);
  assertGoldProjection(question.gold, expectedRows);
  assertGoldMissTaxonomy(question, candidatePool);
  assertStageRankProjection(question);
  const hits = computeHits(question, new Set(
    expectedGold.map(identityKey)
  ), input.scorable);
  assertPersistedHits(question, hits);
  assertQuestionMissTaxonomy(question, hits.hitAt5);
  assertMissClassification(question, hits.hitAt5);
  return hits;
}

function indexDeliveredObjects(
  question: LongMemEvalQuestionDiagnostic
): ReadonlyMap<string, number> {
  const result = new Map<string, number>();
  question.delivered_results.forEach((row, index) => {
    if (row.rank !== index + 1) {
      throw new Error(`recall-eval delivered rank differs at ${question.question_id}`);
    }
    const key = `${row.object_kind ?? "memory_entry"}:${row.object_id}`;
    if (question.delivered_results.some((other, otherIndex) =>
      otherIndex < index && `${other.object_kind ?? "memory_entry"}:${other.object_id}` === key
    )) throw new Error(`recall-eval repeats delivered object ${key}`);
    result.set(key, index + 1);
  });
  return result;
}

function assertDeliveredCandidateBinding(
  question: LongMemEvalQuestionDiagnostic,
  candidates: ReadonlyMap<string, LongMemEvalReplayCandidate>
): void {
  question.delivered_results.forEach((row, index) => {
    const key = `${row.object_kind ?? "memory_entry"}:${row.object_id}`;
    const candidate = candidates.get(key);
    if (candidate === undefined || candidate.final_rank !== index + 1) {
      throw new Error(`recall-eval delivered candidate binding differs at ${key}`);
    }
  });
  for (const [key, candidate] of candidates) {
    if (candidate.final_rank === null) continue;
    const delivered = question.delivered_results[candidate.final_rank - 1];
    const deliveredKey = delivered === undefined ? null :
      `${delivered.object_kind ?? "memory_entry"}:${delivered.object_id}`;
    if (!Number.isSafeInteger(candidate.final_rank) || candidate.final_rank < 1 ||
        deliveredKey !== key) {
      throw new Error(`recall-eval candidate delivery binding differs at ${key}`);
    }
  }
}

function indexActiveConstraints(
  question: LongMemEvalQuestionDiagnostic
): ReadonlyMap<string, number> {
  const result = new Map<string, number>();
  for (const row of question.active_constraint_results) {
    if (result.has(row.object_id)) {
      throw new Error(`recall-eval repeats active constraint ${row.object_id}`);
    }
    result.set(row.object_id, row.rank);
  }
  return result;
}

function expectedGoldProjection(
  gold: LongMemEvalGoldObjectIdentity,
  candidate: LongMemEvalReplayCandidate | undefined,
  fineAssessmentPruned: boolean,
  finalRank: number | null,
  activeRank: number | null
) {
  return {
    object_id: gold.objectId,
    object_kind: gold.objectKind,
    candidate_status: finalRank !== null ? "delivered"
      : activeRank !== null ? "active_constraint_delivered"
        : candidate === undefined && !fineAssessmentPruned
          ? "candidate_absent"
          : "candidate_not_delivered",
    ...expectedGoldRankingFields(candidate, finalRank, activeRank),
    ...expectedGoldDeliveryFields(candidate)
  };
}

function expectedGoldRankingFields(
  candidate: LongMemEvalReplayCandidate | undefined,
  finalRank: number | null,
  activeRank: number | null
) {
  return {
    dimension: candidate?.dimension ?? null,
    final_rank: finalRank,
    active_constraint_rank: activeRank,
    pre_budget_rank: candidate?.pre_budget_rank ?? null,
    selection_order: candidate?.selection_order ?? null,
    fused_rank: candidate?.fused_rank ?? null,
    fused_score: candidate?.fused_score ?? null,
    answer_relevance_score: candidate?.answer_relevance_score ?? null,
    answer_relevance_rank: candidate?.answer_relevance_rank ?? null,
    per_stream_rank: candidate?.per_stream_rank ?? null,
    fused_rank_contribution_per_stream:
      candidate?.fused_rank_contribution_per_stream ?? null,
    per_axis_rank: candidate?.per_axis_rank ?? null,
    per_axis_contribution: candidate?.per_axis_contribution ?? null,
    flood_potential: candidate?.flood_potential ?? null,
    flood_fuel_coverage: candidate?.flood_fuel_coverage ?? null
  };
}

function expectedGoldDeliveryFields(
  candidate: LongMemEvalReplayCandidate | undefined
) {
  return {
    plane_first_admitted: candidate?.plane_first_admitted ?? null,
    plane_winning_admission: candidate?.plane_winning_admission ?? null,
    source_planes: candidate?.source_planes ?? [],
    lexical_rank: candidate?.lexical_rank ?? null,
    structural_score: candidate?.structural_score ?? null,
    score_factors: candidate === undefined
      ? null
      : originalScoreFactors(candidate.score_factors),
    source_channels: candidate?.source_channels ?? [],
    budget_drop_reason: candidate?.budget_drop_reason ?? null,
    rank_after_fusion: candidate?.rank_after_fusion ?? null,
    rank_after_feature_rerank: candidate?.rank_after_feature_rerank ?? null,
    rank_after_lexical_priority: candidate?.rank_after_lexical_priority ?? null,
    rank_after_synthesis_reserve: candidate?.rank_after_synthesis_reserve ?? null,
    rank_after_structural_reserve: candidate?.rank_after_structural_reserve ?? null,
    rank_after_coverage_selector: candidate?.rank_after_coverage_selector ?? null,
    rank_after_session_coverage: candidate?.rank_after_session_coverage ?? null,
    coverage_selector_action: candidate?.coverage_selector_action ?? null,
    session_coverage_action: candidate?.session_coverage_action ?? null,
    session_key: candidate?.session_key ?? null,
    source_cohort_key: candidate?.source_cohort_key ?? null,
    reserved_by: candidate?.reserved_by ?? null
  };
}

function originalScoreFactors(
  factors: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> | null {
  const {
    facet_overlap: _facetOverlap,
    created_at: _createdAt,
    ...original
  } = factors;
  return Object.keys(original).length === 0 ? null : original;
}

function goldProjection(gold: LongMemEvalGoldDiagnostic) {
  const { miss_taxonomy: _missTaxonomy, ...projection } = gold;
  return projection;
}

function assertGoldIdentity(
  question: LongMemEvalQuestionDiagnostic,
  expectedGold: readonly LongMemEvalGoldObjectIdentity[]
): void {
  const ledger = question.cohort_ledger;
  assertPromotionEligibleEvaluationIdentity(question);
  const expectedMemoryIds = idsForKind(expectedGold, "memory_entry");
  const expectedEvidenceIds = idsForKind(expectedGold, "evidence_capsule");
  const expectedObjectIds = buildGoldObjectIds({
    goldMemoryIds: expectedMemoryIds,
    goldEvidenceIds: expectedEvidenceIds
  });
  const expectedStatus = expectedGold.length === 0 ? "absent" : "present";
  const expectedExtraction = deriveQuestionExtractionMaterialization({
    goldMemoryIds: expectedMemoryIds,
    goldEvidenceIds: expectedEvidenceIds,
    goldObjectIds: expectedObjectIds,
    seedDropReasons: question.seed_drop_reasons
  });
  const expectedIssue = deriveQuestionEvaluationIssueReason({
    isAbstention: question.is_abstention,
    premiseInvalid: false,
    goldMemoryIds: expectedMemoryIds,
    goldEvidenceIds: expectedEvidenceIds,
    goldObjectIds: expectedObjectIds,
    diagnosticsAvailable: question.recall_diagnostics_present,
    missTaxonomy: question.miss_taxonomy,
    seedDropReasons: question.seed_drop_reasons,
    ambiguousIdentity: false
  });
  if (ledger === undefined ||
      !isDeepStrictEqual(question.gold_memory_ids, expectedMemoryIds) ||
      !isDeepStrictEqual(question.gold_evidence_ids ?? [], expectedEvidenceIds) ||
      !isDeepStrictEqual(
        question.gold_object_ids ?? question.gold_memory_ids,
        expectedObjectIds
      ) ||
      !isDeepStrictEqual(ledger.evaluator_gold_identity.object_ids, expectedObjectIds) ||
      ledger.evaluator_gold_identity.status !== expectedStatus ||
      !isDeepStrictEqual(ledger.extraction_materialization, expectedExtraction) ||
      ledger.evaluation_issue_reason !== expectedIssue ||
      !isDeepStrictEqual(
        question.gold.map((row) => `${row.object_kind}:${row.object_id}`),
        expectedGold.map(identityKey)
      )) {
    throw new Error(`recall-eval gold identity differs from snapshot for ${question.question_id}`);
  }
}

function assertPromotionEligibleEvaluationIdentity(
  question: LongMemEvalQuestionDiagnostic
): void {
  if (question.premise_invalid) {
    throw new Error(`recall-eval premise-invalid row is not promotion eligible: ${question.question_id}`);
  }
  const ledger = question.cohort_ledger;
  if (ledger?.evaluator_gold_identity.status === "ambiguous" ||
      ledger?.evaluation_issue_reason === "identity_join_error") {
    throw new Error(`recall-eval identity ambiguity is not promotion eligible: ${question.question_id}`);
  }
}

function assertGoldProjection(
  actual: readonly LongMemEvalGoldDiagnostic[],
  expected: readonly ReturnType<typeof expectedGoldProjection>[]
): void {
  if (!isDeepStrictEqual(actual.map(goldProjection), expected)) {
    throw new Error("recall-eval gold diagnostics differ from candidate primitives");
  }
}

function assertGoldMissTaxonomy(
  question: LongMemEvalQuestionDiagnostic,
  candidatePool: VerifiedPromotionCandidatePool
): void {
  for (const gold of question.gold) {
    const identity = `${gold.object_kind}:${gold.object_id}`;
    const candidate = candidatePool.scoredByIdentity.get(identity);
    const anyObjectCandidate = findCandidateByObjectId(
      candidatePool.scoredByIdentity,
      gold.object_id
    );
    const expected = classifyReplayGoldDeliveryMissTaxonomy({
      deliveredRank: gold.final_rank,
      candidate,
      anyObjectCandidate,
      fineAssessmentPruned: candidate === undefined &&
        candidatePool.finePrunedByIdentity.has(identity),
      anyObjectFineAssessmentPruned:
        anyObjectCandidate === undefined &&
        candidatePool.finePrunedObjectIds.has(gold.object_id),
      diagnosticsAvailable: question.recall_diagnostics_present
    });
    if (gold.miss_taxonomy !== expected) {
      throw new Error(`recall-eval gold miss taxonomy differs for ${question.question_id}`);
    }
  }
}

function findCandidateByObjectId(
  candidates: ReadonlyMap<string, LongMemEvalReplayCandidate>,
  objectId: string
): LongMemEvalReplayCandidate | undefined {
  for (const candidate of candidates.values()) {
    if (candidate.object_id === objectId) return candidate;
  }
  return undefined;
}

function assertQuestionMissTaxonomy(
  question: LongMemEvalQuestionDiagnostic,
  hitAt5: boolean
): void {
  const expected = classifyQuestionMissTaxonomy({
    hitAt5,
    goldMemoryIds: question.gold_memory_ids,
    goldObjectIds: question.gold_object_ids ?? question.gold_memory_ids,
    gold: question.gold,
    diagnosticsAvailable: question.recall_diagnostics_present,
    isAbstention: question.is_abstention,
    seedDropReasons: question.seed_drop_reasons
  });
  if (question.miss_taxonomy !== expected) {
    throw new Error(`recall-eval question miss taxonomy differs for ${question.question_id}`);
  }
}

function assertStageRankProjection(question: LongMemEvalQuestionDiagnostic): void {
  const expected = question.gold.map((gold) => ({
    object_id: gold.object_id,
    object_kind: gold.object_kind,
    fused_rank: gold.fused_rank,
    rank_after_feature_rerank: gold.rank_after_feature_rerank,
    rank_after_lexical_priority: gold.rank_after_lexical_priority,
    rank_after_synthesis_reserve: gold.rank_after_synthesis_reserve,
    rank_after_structural_reserve: gold.rank_after_structural_reserve,
    rank_after_coverage_selector: gold.rank_after_coverage_selector,
    rank_after_session_coverage: gold.rank_after_session_coverage,
    selection_order: gold.selection_order,
    final_rank: gold.final_rank
  }));
  if (!isDeepStrictEqual(question.cohort_ledger?.stage_ranks, expected)) {
    throw new Error(`recall-eval stage ranks differ for ${question.question_id}`);
  }
}

function computeHits(
  question: LongMemEvalQuestionDiagnostic,
  gold: ReadonlySet<string>,
  scorable: boolean
): VerifiedPromotionHits {
  const eligible = question.delivered_results.map((row) =>
    gold.has(`${row.object_kind ?? "memory_entry"}:${row.object_id}`)
  );
  return {
    hitAt1: scorable && eligible.slice(0, 1).some(Boolean),
    hitAt5: scorable && eligible.slice(0, 5).some(Boolean),
    hitAt10: scorable && eligible.slice(0, 10).some(Boolean)
  };
}

function assertPersistedHits(
  question: LongMemEvalQuestionDiagnostic,
  hits: VerifiedPromotionHits
): void {
  if (question.hit_at_1 !== hits.hitAt1 || question.hit_at_5 !== hits.hitAt5 ||
      question.hit_at_10 !== hits.hitAt10) {
    throw new Error(`recall-eval hit@k differs from snapshot gold for ${question.question_id}`);
  }
}

function assertMissClassification(
  question: LongMemEvalQuestionDiagnostic,
  hitAt5: boolean
): void {
  const expected = classifyMiss(question, hitAt5);
  if (question.miss_classification !== expected) {
    throw new Error(`recall-eval miss classification differs for ${question.question_id}`);
  }
}

function classifyMiss(
  question: LongMemEvalQuestionDiagnostic,
  hitAt5: boolean
): LongMemEvalQuestionDiagnostic["miss_classification"] {
  if (question.is_abstention &&
      (question.gold_object_ids ?? question.gold_memory_ids).length > 0) {
    return "evaluator_identity_inconsistent";
  }
  if (question.is_abstention) return "abstention_uncalibrated";
  if (question.gold.length === 0) {
    return question.seed_drop_reasons !== undefined &&
      (question.seed_drop_reasons.candidate_absent > 0 ||
        question.seed_drop_reasons.materialization_drop > 0)
      ? "candidate_absent"
      : "no_gold";
  }
  if (hitAt5) return "hit_at_5";
  if (question.gold.some(isDeliveryBudgetLoss)) return "budget_dropped";
  if (question.gold.some((gold) => gold.final_rank !== null ||
      gold.pre_budget_rank !== null || gold.fused_rank !== null)) return "under_ranked";
  if (question.gold.some((gold) =>
    gold.candidate_status === "active_constraint_delivered")) return "active_constraint_only";
  const candidates = question.gold.filter((gold) =>
    gold.candidate_status === "candidate_not_delivered");
  if (candidates.some((gold) => !gold.source_planes.includes("lexical"))) {
    return "lexical_gap";
  }
  if (candidates.some((gold) => !hasStructuralPlane(gold.source_planes))) {
    return "structural_gap";
  }
  return "candidate_absent";
}

function identityKey(identity: LongMemEvalGoldObjectIdentity): string {
  return `${identity.objectKind}:${identity.objectId}`;
}

function idsForKind(
  identities: readonly LongMemEvalGoldObjectIdentity[],
  objectKind: LongMemEvalGoldObjectIdentity["objectKind"]
): readonly string[] {
  return identities
    .filter((identity) => identity.objectKind === objectKind)
    .map((identity) => identity.objectId);
}

function resolveExpectedGoldIdentities(input: Readonly<{
  readonly expectedGold?: readonly string[];
  readonly expectedGoldIdentities?: readonly LongMemEvalGoldObjectIdentity[];
}>): readonly LongMemEvalGoldObjectIdentity[] {
  if (input.expectedGoldIdentities !== undefined) {
    return input.expectedGoldIdentities;
  }
  return (input.expectedGold ?? []).map((objectId) => ({
    objectId,
    objectKind: "memory_entry"
  }));
}
