import { SELECT_GAMMA_OPERATOR_ID } from "@do-soul/alaya-protocol";
import type {
  CoverageSelectableCandidate,
  CoverageSelectionCandidateState,
  CoverageSelectionObjective,
  CoverageSelectionSupplementary
} from "../coverage-selection.js";
import { requireByKey } from "./admission/require-by-key.js";
import {
  acceptSelectGammaCoverage,
  selectGammaMarginalGain
} from "./objective.js";
import type {
  SelectGammaCoverState,
  SelectGammaFeatureWeights,
  SelectGammaWalkObjective
} from "./types.js";

export function createSelectGammaGenericWalkObjective(
  weights: SelectGammaFeatureWeights
): SelectGammaWalkObjective<SelectGammaCoverState> {
  return Object.freeze({
    operator_id: SELECT_GAMMA_OPERATOR_ID,
    createState: () => new Map<string, number>(),
    cloneState: (state) => new Map(state),
    marginalGain: (candidate, state) =>
      selectGammaMarginalGain(candidate, state, weights),
    accept: (candidate, state) => acceptSelectGammaCoverage(candidate, state),
    decomposeGain: (candidate, state) => {
      const gain = selectGammaMarginalGain(candidate, state, weights);
      return Object.freeze({
        quality: candidate.quality,
        coverage: gain - candidate.quality
      });
    }
  });
}

export function bindCoverageSelectionWalkObjective<
  T extends CoverageSelectableCandidate,
  State
>(params: Readonly<{
  readonly objective: CoverageSelectionObjective<T, State>;
  readonly candidateStates: readonly CoverageSelectionCandidateState<T>[];
  readonly supplementaryData: CoverageSelectionSupplementary;
}>): SelectGammaWalkObjective<State> {
  const byKey = new Map(params.candidateStates.map((state) => [
    state.candidate.fusion.candidate_key,
    state
  ]));
  const objective = params.objective;
  const observation = (candidateKey: string, state: State) => {
    const bound = requireByKey(
      byKey,
      candidateKey,
      "Select_Gamma coverage candidate is absent from the walk binding"
    );
    return {
      candidate: bound.candidate,
      identity: bound.identity,
      relevance: bound.relevance,
      coverage: bound.coverage,
      state,
      supplementaryData: params.supplementaryData
    };
  };
  return Object.freeze({
    operator_id: objective.operator_id,
    configuration_digest: objective.configuration_digest,
    createState: objective.createState,
    cloneState: objective.cloneState,
    marginalGain: (candidate, state) =>
      objective.marginalGain(observation(candidate.candidate_key, state)),
    accept: (candidate, state) =>
      objective.accept(observation(candidate.candidate_key, state))
  });
}
