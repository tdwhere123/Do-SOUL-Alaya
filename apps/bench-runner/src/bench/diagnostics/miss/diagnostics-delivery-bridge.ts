import {
  classifyDeliveryMissTaxonomy,
  isDeliveryMissDropReason,
  type DeliveryMissCandidateInput
} from "../miss/delivery-miss-taxonomy.js";
import { analyzeFullGoldDeliveryContribution } from "./full-gold-delivery-analysis.js";
import type { FullGoldDeliveryContribution } from "@do-soul/alaya-eval";
import type {
  CandidateDiagnostic,
  LongMemEvalGoldDiagnostic,
  LongMemEvalMissTaxonomy,
  LongMemEvalQuestionDiagnostic,
  LongMemEvalReplayCandidate
} from "../schema/diagnostics-types.js";
import { isAbstentionQuestionId } from "../abstention.js";

export function toDeliveryMissCandidateInput(
  candidate: CandidateDiagnostic
): DeliveryMissCandidateInput {
  return {
    objectKind: candidate.objectKind,
    preBudgetRank: candidate.preBudgetRank,
    fusedRank: candidate.fusedRank,
    finalRank: candidate.finalRank,
    droppedReason: parseDropReason(candidate.budgetDropReason),
    rankAfterFusion: candidate.rankAfterFusion,
    rankAfterFeatureRerank: candidate.rankAfterFeatureRerank,
    rankAfterCoverageSelector: candidate.rankAfterCoverageSelector,
    coverageSelectorAction: candidate.coverageSelectorAction
  };
}

export function classifyGoldDeliveryMissTaxonomy(input: {
  readonly deliveredRank: number | null;
  readonly candidate: CandidateDiagnostic | undefined;
  readonly anyObjectCandidate: CandidateDiagnostic | undefined;
  readonly fineAssessmentPruned?: boolean;
  readonly anyObjectFineAssessmentPruned?: boolean;
  readonly diagnosticsAvailable: boolean;
}): Exclude<LongMemEvalMissTaxonomy, "evaluation_or_gold_issue"> | null {
  return classifyDeliveryMissTaxonomy({
    deliveredRank: input.deliveredRank,
    candidate:
      input.candidate === undefined
        ? undefined
        : toDeliveryMissCandidateInput(input.candidate),
    anyObjectCandidate:
      input.anyObjectCandidate === undefined
        ? undefined
        : toDeliveryMissCandidateInput(input.anyObjectCandidate),
    fineAssessmentPruned: input.fineAssessmentPruned,
    anyObjectFineAssessmentPruned: input.anyObjectFineAssessmentPruned,
    diagnosticsAvailable: input.diagnosticsAvailable
  });
}

export function classifyReplayGoldDeliveryMissTaxonomy(input: {
  readonly deliveredRank: number | null;
  readonly candidate: LongMemEvalReplayCandidate | undefined;
  readonly anyObjectCandidate: LongMemEvalReplayCandidate | undefined;
  readonly fineAssessmentPruned?: boolean;
  readonly anyObjectFineAssessmentPruned?: boolean;
  readonly diagnosticsAvailable: boolean;
}): Exclude<LongMemEvalMissTaxonomy, "evaluation_or_gold_issue"> | null {
  return classifyDeliveryMissTaxonomy({
    deliveredRank: input.deliveredRank,
    candidate: toReplayDeliveryMissCandidateInput(input.candidate),
    anyObjectCandidate: toReplayDeliveryMissCandidateInput(input.anyObjectCandidate),
    fineAssessmentPruned: input.fineAssessmentPruned,
    anyObjectFineAssessmentPruned: input.anyObjectFineAssessmentPruned,
    diagnosticsAvailable: input.diagnosticsAvailable
  });
}

function toReplayDeliveryMissCandidateInput(
  candidate: LongMemEvalReplayCandidate | undefined
): DeliveryMissCandidateInput | undefined {
  if (candidate === undefined) return undefined;
  return {
    objectKind: candidate.object_kind ?? "memory_entry",
    preBudgetRank: candidate.pre_budget_rank,
    fusedRank: candidate.fused_rank,
    finalRank: candidate.final_rank,
    droppedReason: parseDropReason(candidate.budget_drop_reason),
    rankAfterFusion: candidate.rank_after_fusion,
    rankAfterFeatureRerank: candidate.rank_after_feature_rerank,
    rankAfterCoverageSelector: candidate.rank_after_coverage_selector,
    coverageSelectorAction: candidate.coverage_selector_action
  };
}

export function resolveCoreDeliveryRank(
  gold: LongMemEvalGoldDiagnostic
): number | null {
  return gold.rank_after_fusion ?? gold.fused_rank ?? null;
}

export function buildLongMemEvalDeliveryContribution(
  diagnostics: readonly LongMemEvalQuestionDiagnostic[]
): FullGoldDeliveryContribution {
  return analyzeFullGoldDeliveryContribution(
    diagnostics
      .filter(
        (question) =>
          !isAbstentionQuestionId(question.question_id) &&
          question.gold.length > 0
      )
      .map((question) => ({
        questionId: question.question_id,
        gold: question.gold.map((row) => ({
          objectId: row.object_id,
          deliveredRank: row.final_rank,
          coreRank: resolveCoreDeliveryRank(row)
        }))
      }))
  );
}

function parseDropReason(
  value: string | null
): DeliveryMissCandidateInput["droppedReason"] {
  return value !== null && isDeliveryMissDropReason(value) ? value : null;
}
