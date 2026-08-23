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
import { requireByKey } from "./admission/require-by-key.js";
import type {
  SelectGammaBinding,
  SelectGammaFormulaCandidate,
  SelectGammaWalkObjective
} from "./types.js";

export function prepareSelectGammaProof(
  candidates: readonly FineAssessmentCandidate[],
  context: FineAssessmentSelectionContext,
  binding: SelectGammaBinding,
  walkObjective: SelectGammaWalkObjective<any>
) {
  const objective = createSelectGammaProofObjective(binding, walkObjective);
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

function createSelectGammaProofObjective<State>(
  binding: SelectGammaBinding,
  walkObjective: SelectGammaWalkObjective<State>
): CoverageSelectionObjective<FineAssessmentCandidate, State> {
  const byKey = new Map(binding.candidates.map((candidate) => [
    candidate.candidate_key,
    candidate
  ]));
  return Object.freeze({
    operator_id: walkObjective.operator_id,
    configuration_digest: walkObjective.configuration_digest,
    createState: walkObjective.createState,
    cloneState: proofCloneState(walkObjective),
    marginalGain: ({ candidate, state }) => walkObjective.marginalGain(
      boundFormulaCandidate(byKey, candidate.fusion.candidate_key),
      state
    ),
    accept: ({ candidate, state }) => walkObjective.accept(
      boundFormulaCandidate(byKey, candidate.fusion.candidate_key),
      state
    )
  });
}

function proofCloneState<State>(
  walkObjective: SelectGammaWalkObjective<State>
): (state: State) => State {
  const clone = walkObjective.cloneState;
  if (clone !== undefined) return (state) => clone(state);
  return (state) => {
    if (state instanceof Map) return new Map(state) as State;
    throw new Error("Select_Gamma proof requires cloneState");
  };
}

function boundFormulaCandidate(
  byKey: ReadonlyMap<string, SelectGammaFormulaCandidate>,
  candidateKey: string
): SelectGammaFormulaCandidate {
  return requireByKey(
    byKey,
    candidateKey,
    "Select_Gamma proof candidate is absent from the live binding"
  );
}
