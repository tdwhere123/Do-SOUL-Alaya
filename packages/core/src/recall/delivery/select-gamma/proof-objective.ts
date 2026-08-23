import {
  materializeCoverageSelectionCandidateStates,
  materializeCoverageSelectionObjectiveReceipt,
  type CoverageSelectionObjective
} from "../coverage-selection.js";
import type { MaterializedConfiguredCoverageSelection } from
  "../../field/facility/selection-objective.js";
import type {
  FineAssessmentCandidate,
  FineAssessmentSelectionContext
} from "../fine-assessment-selection/types.js";
import { createSelectGammaGenericWalkObjective } from "./walk-objective.js";
import type {
  SelectGammaBinding,
  SelectGammaCoverState,
  SelectGammaFormulaCandidate
} from "./types.js";

export function prepareSelectGammaProof(
  candidates: readonly FineAssessmentCandidate[],
  context: FineAssessmentSelectionContext,
  binding: SelectGammaBinding
) {
  const objective = createSelectGammaProofObjective(binding);
  const preparedSelection: MaterializedConfiguredCoverageSelection<
    FineAssessmentCandidate
  > = Object.freeze({
    candidateStates: materializeCoverageSelectionCandidateStates({
      candidates,
      relevanceByCandidateKey: context.coverageRelevanceByCandidateKey,
      supplementaryData: context.supplementaryData
    }),
    objective: objective as unknown as MaterializedConfiguredCoverageSelection<
      FineAssessmentCandidate
    >["objective"]
  });
  return Object.freeze({
    preparedSelection,
    objective: materializeCoverageSelectionObjectiveReceipt(objective)
  });
}

function createSelectGammaProofObjective(
  binding: SelectGammaBinding
): CoverageSelectionObjective<FineAssessmentCandidate, SelectGammaCoverState> {
  const byKey = new Map(binding.candidates.map((candidate) => [
    candidate.candidate_key,
    candidate
  ]));
  const walkObjective = createSelectGammaGenericWalkObjective(binding);
  return Object.freeze({
    operator_id: walkObjective.operator_id,
    mathematical_class: walkObjective.mathematical_class,
    createState: walkObjective.createState,
    cloneState: walkObjective.cloneState,
    marginalGain: ({ candidate, state }) => walkObjective.marginalGain(
      boundCandidate(byKey, candidate.fusion.candidate_key),
      state
    ),
    accept: ({ candidate, state }) => walkObjective.accept(
      boundCandidate(byKey, candidate.fusion.candidate_key),
      state
    )
  });
}

function boundCandidate(
  byKey: ReadonlyMap<string, SelectGammaFormulaCandidate>,
  candidateKey: string
): SelectGammaFormulaCandidate {
  const candidate = byKey.get(candidateKey);
  if (candidate === undefined) {
    throw new Error("Select_Gamma proof candidate is absent from the live binding");
  }
  return candidate;
}
