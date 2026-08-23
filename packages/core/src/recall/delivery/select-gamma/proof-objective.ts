import {
  materializeCoverageSelectionCandidateStates,
  materializeCoverageSelectionObjectiveReceipt,
  type CoverageSelectionCandidateState,
  type CoverageSelectionObjective
} from "../coverage-selection.js";
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

export type SelectGammaPreparedSelection = Readonly<{
  readonly candidateStates: readonly CoverageSelectionCandidateState<
    FineAssessmentCandidate
  >[];
  readonly objective: CoverageSelectionObjective<FineAssessmentCandidate, unknown>;
}>;

export function prepareSelectGammaProof<State>(
  candidates: readonly FineAssessmentCandidate[],
  context: FineAssessmentSelectionContext,
  binding: SelectGammaBinding,
  walkObjective: SelectGammaWalkObjective<State>
) {
  const objective = createSelectGammaProofObjective(binding, walkObjective);
  return Object.freeze({
    preparedSelection: Object.freeze({
      candidateStates: materializeCoverageSelectionCandidateStates({
        candidates,
        relevanceByCandidateKey: context.coverageRelevanceByCandidateKey,
        supplementaryData: context.supplementaryData
      }),
      objective
    }),
    objective: materializeCoverageSelectionObjectiveReceipt(objective)
  });
}

function createSelectGammaProofObjective<State>(
  binding: SelectGammaBinding,
  walkObjective: SelectGammaWalkObjective<State>
): CoverageSelectionObjective<FineAssessmentCandidate, unknown> {
  const clone = walkObjective.cloneState;
  if (clone === undefined) {
    throw new Error("Select_Gamma proof requires cloneState");
  }
  const byKey = new Map(binding.candidates.map((candidate) => [
    candidate.candidate_key,
    candidate
  ]));
  return Object.freeze({
    operator_id: walkObjective.operator_id,
    configuration_digest: walkObjective.configuration_digest,
    createState: walkObjective.createState,
    cloneState: (state: unknown) => clone(state as State),
    marginalGain: ({ candidate, state }) => walkObjective.marginalGain(
      boundFormulaCandidate(byKey, candidate.fusion.candidate_key),
      state as State
    ),
    accept: ({ candidate, state }) => walkObjective.accept(
      boundFormulaCandidate(byKey, candidate.fusion.candidate_key),
      state as State
    )
  });
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
