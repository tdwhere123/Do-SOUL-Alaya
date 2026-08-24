import { resolveCoverageIdentity } from "../../coverage-selection.js";
import type {
  FineAssessmentSelectionContext,
  FineAssessmentSelectionParams
} from "../../fine-assessment-selection/types.js";
import { isWorkspaceMemoryCandidate } from
  "../../../runtime/recall-service-helpers.js";
import type {
  SelectGammaBinding,
  SelectGammaWalkObjective
} from "../types.js";
import { attributeCandidateBindingCoverage } from "./candidate-receipt.js";
import { digestBindingCoverConfiguration } from "./digest.js";
import { bindProductionFacilityWalkObjective } from "./facility.js";
import { createBindingAwareWalkObjective } from "./objective.js";
import { resolveBindingQueryObligation } from "./query-obligation.js";
import { materializeSelectedBindingSetReceipt } from "./selected-receipt.js";
import type {
  BindingCoverState,
  BindingQueryObligation,
  CandidateBindingCoverageReceipt,
  SelectedBindingSetReceipt
} from "./types.js";

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
  const facility = bindProductionFacilityWalkObjective(params, context);
  const objective = createBindingAwareWalkObjective({
    receiptsByCandidateKey,
    contentKeyByCandidateKey: contentKeys(params, context),
    rankingScoreByCandidateKey: rankingScores(params),
    facility,
    configurationDigest: digestBindingCoverConfiguration({
      receiptsByCandidateKey,
      answerVariableIds: obligation.answer_variable_ids,
      obligationFacets: obligation.obligation_facets,
      valuesStatus: obligation.values_status,
      facilityDigest: facility?.configuration_digest ?? null
    })
  });
  return Object.freeze({
    receiptsByCandidateKey,
    obligation,
    objective,
    selectedBindingSet: (selectedCandidateKeys: readonly string[]) =>
      materializeSelectedBindingSetReceipt({
        selectedCandidateKeys,
        receiptsByCandidateKey,
        obligation,
        formulaCandidates: binding.candidates
      })
  });
}

function rankingScores(
  params: FineAssessmentSelectionParams
): ReadonlyMap<string, number> {
  return new Map(params.orderedCandidates.map((candidate) => [
    candidate.fusion.candidate_key,
    candidate.fusion.fused_score
  ]));
}

function contentKeys(
  params: FineAssessmentSelectionParams,
  context: FineAssessmentSelectionContext
): ReadonlyMap<string, string> {
  const keys = new Map<string, string>();
  for (const candidate of params.orderedCandidates) {
    if (!isWorkspaceMemoryCandidate(candidate)) continue;
    const gistKey = resolveCoverageIdentity(
      candidate,
      context.supplementaryData
    ).gistKey;
    if (gistKey.length > 0) keys.set(candidate.fusion.candidate_key, gistKey);
  }
  return keys;
}
