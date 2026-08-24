import {
  RECALL_FUSION_FAMILY_IDS,
  aggregateFamilyContributions,
  familyMaxContributionsById,
  type RecallFusionFamilyId
} from "@do-soul/alaya-core";
import type {
  DiagnosticStreamContributions,
  LongMemEvalGoldDiagnostic,
  LongMemEvalQuestionDiagnostic
} from "../schema/diagnostics-types.js";
import { hasCoverageOrBudgetSignal } from "./pool-rank.js";

export type NearTopClass = "honest_higher_r_obj" | null;

export interface HonestHigherRObjVerdict {
  readonly classification: NearTopClass;
  /** Legal family-max R_obj of the gold (sum of per-family max votes). */
  readonly gold_family_max: number | null;
  /** Minimum family-max R_obj among delivered top-5 occupiers. */
  readonly rank5_family_max: number | null;
  readonly gold_winning_family: RecallFusionFamilyId | null;
  /** E0 arm control: gold has zero/absent embedding vote and no deep-head trace. */
  readonly e0_control: boolean;
}

/**
 * A near-top miss is honest when every delivered top-5 occupier carries a
 * strictly higher legal family-max R_obj than the gold: fused order already
 * reflects the legal ranking, so neither Gamma residual reorder nor waist
 * composition owns the loss. Gamma aliases (selection_order diverging from
 * fused_rank) are irrelevant here — only family-max R_obj decides.
 */
export function classifyHonestHigherRObj(input: {
  readonly question: LongMemEvalQuestionDiagnostic;
  readonly gold: LongMemEvalGoldDiagnostic;
}): HonestHigherRObjVerdict {
  const { question, gold } = input;
  const goldFamilyMax = familyMaxRObj(gold.fused_rank_contribution_per_stream);
  const rank5FamilyMax = minDeliveredTop5FamilyMax(question, gold.object_id);
  const nearTopMiss =
    (gold.final_rank === null || gold.final_rank > 5) &&
    gold.fused_rank !== null &&
    gold.fused_rank > 5;
  const honest =
    nearTopMiss &&
    !hasCoverageOrBudgetSignal(gold) &&
    goldFamilyMax !== null &&
    rank5FamilyMax !== null &&
    goldFamilyMax < rank5FamilyMax;
  return {
    classification: honest ? "honest_higher_r_obj" : null,
    gold_family_max: goldFamilyMax,
    rank5_family_max: rank5FamilyMax,
    gold_winning_family: winningFamily(gold.fused_rank_contribution_per_stream),
    e0_control: isE0Control(question, gold)
  };
}

function familyMaxRObj(
  contributions: DiagnosticStreamContributions | null
): number | null {
  if (contributions === null) return null;
  return aggregateFamilyContributions(contributions);
}

function winningFamily(
  contributions: DiagnosticStreamContributions | null
): RecallFusionFamilyId | null {
  if (contributions === null) return null;
  const byFamily = familyMaxContributionsById(contributions);
  let winner: RecallFusionFamilyId | null = null;
  let best = 0;
  for (const familyId of RECALL_FUSION_FAMILY_IDS) {
    if (byFamily[familyId] > best) {
      best = byFamily[familyId];
      winner = familyId;
    }
  }
  return winner;
}

/**
 * Strict comparison against ALL occupiers requires every occupier's
 * contributions; any occupier without a ledger makes the claim unprovable.
 */
function minDeliveredTop5FamilyMax(
  question: LongMemEvalQuestionDiagnostic,
  goldObjectId: string
): number | null {
  const ledgers = deliveredTop5Contributions(question, goldObjectId);
  if (ledgers === null || ledgers.length === 0) return null;
  let min: number | null = null;
  for (const contributions of ledgers) {
    const familyMax = aggregateFamilyContributions(contributions);
    if (min === null || familyMax < min) min = familyMax;
  }
  return min;
}

function deliveredTop5Contributions(
  question: LongMemEvalQuestionDiagnostic,
  goldObjectId: string
): readonly DiagnosticStreamContributions[] | null {
  const fromCandidates = (question.candidates ?? []).filter(
    (row) =>
      row.final_rank !== null &&
      row.final_rank <= 5 &&
      row.object_id !== goldObjectId
  );
  if (fromCandidates.length > 0) {
    return collectContributions(fromCandidates);
  }
  const fromDelivered = (question.delivered_results ?? []).filter(
    (row) => row.rank <= 5 && row.object_id !== goldObjectId
  );
  return collectContributions(fromDelivered);
}

function collectContributions(
  rows: readonly Readonly<{
    readonly fused_rank_contribution_per_stream:
      DiagnosticStreamContributions | null;
  }>[]
): readonly DiagnosticStreamContributions[] | null {
  const ledgers: DiagnosticStreamContributions[] = [];
  for (const row of rows) {
    if (row.fused_rank_contribution_per_stream === null) return null;
    ledgers.push(row.fused_rank_contribution_per_stream);
  }
  return ledgers;
}

function isE0Control(
  question: LongMemEvalQuestionDiagnostic,
  gold: LongMemEvalGoldDiagnostic
): boolean {
  const embeddingVote =
    gold.fused_rank_contribution_per_stream?.["embedding_similarity"] ?? 0;
  if (embeddingVote !== 0) return false;
  const goldCandidate = (question.candidates ?? []).find(
    (row) => row.object_id === gold.object_id
  );
  return (goldCandidate?.deep_head_trace ?? null) === null;
}
