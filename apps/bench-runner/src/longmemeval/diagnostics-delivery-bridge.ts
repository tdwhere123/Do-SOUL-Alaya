import {
  analyzeFullGoldDeliveryContribution,
  classifyDeliveryMissTaxonomy,
  type DeliveryMissCandidateInput
} from "@do-soul/alaya-core";
import type { FullGoldDeliveryContribution } from "@do-soul/alaya-eval";
import type {
  CandidateDiagnostic,
  LongMemEvalGoldDiagnostic,
  LongMemEvalMissTaxonomy,
  LongMemEvalQuestionDiagnostic
} from "./diagnostics-types.js";
import { isAbstentionQuestionId } from "./abstention.js";

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
    rankAfterCoverageSelector: candidate.rankAfterCoverageSelector,
    coverageSelectorAction: candidate.coverageSelectorAction
  };
}

export function classifyGoldDeliveryMissTaxonomy(input: {
  readonly deliveredRank: number | null;
  readonly candidate: CandidateDiagnostic | undefined;
  readonly anyObjectCandidate: CandidateDiagnostic | undefined;
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
    diagnosticsAvailable: input.diagnosticsAvailable
  });
}

export function resolveCoreDeliveryRank(
  gold: LongMemEvalGoldDiagnostic
): number | null {
  return (
    gold.rank_after_session_coverage ??
    gold.rank_after_coverage_selector ??
    gold.rank_after_fusion ??
    gold.fused_rank ??
    gold.pre_budget_rank ??
    null
  );
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
  if (
    value === "duplicate" ||
    value === "dimension_limit" ||
    value === "max_entries" ||
    value === "max_total_tokens"
  ) {
    return value;
  }
  return null;
}
