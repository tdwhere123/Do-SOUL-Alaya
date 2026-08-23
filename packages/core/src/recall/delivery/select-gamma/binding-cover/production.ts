import type {
  FineAssessmentSelectionContext,
  FineAssessmentSelectionParams
} from "../../fine-assessment-selection/types.js";
import type {
  SelectGammaBinding,
  SelectGammaWalkObjective
} from "../types.js";
import { attributeCandidateBindingCoverage } from "./candidate-receipt.js";
import { createBindingAwareWalkObjective } from "./objective.js";
import { resolveBindingQueryObligation } from "./query-obligation.js";
import { materializeSelectedBindingSetReceipt } from "./selected-receipt.js";
import type {
  BindingCoverState,
  BindingQueryObligation,
  CandidateBindingCoverageReceipt,
  SelectedBindingSetReceipt
} from "./types.js";

export const PRODUCTION_SELECT_GAMMA_SOURCE_HARD_DEDUPE = false;

export type FineAssessmentBindingCover = Readonly<{
  readonly receiptsByCandidateKey: ReadonlyMap<string, CandidateBindingCoverageReceipt>;
  readonly obligation: BindingQueryObligation;
  readonly objective: SelectGammaWalkObjective<BindingCoverState>;
  selectedBindingSet(
    selectedCandidateKeys: readonly string[]
  ): SelectedBindingSetReceipt;
}>;

export function bindFineAssessmentBindingCover(
  params: FineAssessmentSelectionParams,
  context: FineAssessmentSelectionContext,
  binding: SelectGammaBinding
): FineAssessmentBindingCover {
  const composition = context.supplementaryData.openSemanticFactorComposition;
  const obligation = resolveBindingQueryObligation({
    composition,
    querySoughtFacets: context.supplementaryData.querySoughtFacets,
    answerShape: context.answerShapePlan.shape
  });
  const receiptsByCandidateKey = attributeCandidateBindingCoverage({
    candidates: params.orderedCandidates,
    composition,
    answerVariableIds: obligation.answer_variable_ids
  });
  const objective = createBindingAwareWalkObjective({
    weights: binding.feature_weights,
    receiptsByCandidateKey,
    contentKeyByCandidateKey: contentKeys(params, context)
  });
  return Object.freeze({
    receiptsByCandidateKey,
    obligation,
    objective,
    selectedBindingSet: (selectedCandidateKeys: readonly string[]) =>
      materializeSelectedBindingSetReceipt({
        selectedCandidateKeys,
        receiptsByCandidateKey,
        obligation
      })
  });
}

function contentKeys(
  params: FineAssessmentSelectionParams,
  context: FineAssessmentSelectionContext
): ReadonlyMap<string, string> {
  const gists = context.supplementaryData.evidenceGistsByMemoryId;
  const keys = new Map<string, string>();
  for (const candidate of params.orderedCandidates) {
    const gist = gists[candidate.entry.object_id]?.trim();
    if (gist !== undefined && gist.length > 0) {
      keys.set(candidate.fusion.candidate_key, gist);
    }
  }
  return keys;
}
