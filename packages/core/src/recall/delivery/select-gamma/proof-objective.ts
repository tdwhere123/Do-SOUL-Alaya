import { SELECT_GAMMA_OPERATOR_ID } from "@do-soul/alaya-protocol";
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
import {
  acceptSelectGammaCoverage,
  selectGammaMarginalGain
} from "./objective.js";
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
  const weights = binding.feature_weights;
  return Object.freeze({
    operator_id: SELECT_GAMMA_OPERATOR_ID,
    mathematical_class: "monotone_submodular" as const,
    createState: () => new Map<string, number>(),
    cloneState: (state) => new Map(state),
    marginalGain: ({ candidate, state }) => selectGammaMarginalGain(
      boundCandidate(byKey, candidate.fusion.candidate_key),
      state,
      weights
    ),
    accept: ({ candidate, state }) => acceptSelectGammaCoverage(
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
