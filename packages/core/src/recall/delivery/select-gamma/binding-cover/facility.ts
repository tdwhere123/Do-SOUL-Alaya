import { ATTRIBUTED_FACILITY_COVERAGE_OPERATOR_ID } from
  "../../../field/facility-objective.js";
import { materializeConfiguredCoverageSelection } from
  "../../../field/facility/selection-objective.js";
import type {
  FineAssessmentSelectionContext,
  FineAssessmentSelectionParams
} from "../../fine-assessment-selection/types.js";
import { bindCoverageSelectionWalkObjective } from "../walk-objective.js";
import type { SelectGammaWalkObjective } from "../types.js";

const PRODUCTION_FACILITY_CONFIG = Object.freeze({
  operator_id: ATTRIBUTED_FACILITY_COVERAGE_OPERATOR_ID,
  base_relevance_weight: 1,
  demand_weights: Object.freeze({
    entity: 1,
    relation: 1,
    time: 1,
    logical_object: 1,
    independent_evidence: 1
  })
});

export function bindProductionFacilityWalkObjective(
  params: FineAssessmentSelectionParams,
  context: FineAssessmentSelectionContext
): SelectGammaWalkObjective<unknown> | null {
  if (context.supplementaryData.queryProbes === undefined) return null;
  const prepared = materializeConfiguredCoverageSelection({
    candidates: params.orderedCandidates,
    relevanceByCandidateKey: context.coverageRelevanceByCandidateKey,
    supplementaryData: context.supplementaryData,
    config: PRODUCTION_FACILITY_CONFIG
  });
  return bindCoverageSelectionWalkObjective({
    objective: prepared.objective,
    candidateStates: prepared.candidateStates,
    supplementaryData: context.supplementaryData
  }) as SelectGammaWalkObjective<unknown>;
}
