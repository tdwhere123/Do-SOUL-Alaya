import { SELECT_GAMMA_OPERATOR_ID } from "@do-soul/alaya-protocol";
import type {
  CoverageSelectableCandidate,
  CoverageSelectionCandidateState,
  CoverageSelectionObjective,
  CoverageSelectionSupplementary
} from "../coverage-selection.js";
import {
  acceptSelectGammaCoverage,
  selectGammaMarginalGain
} from "./objective.js";
import type {
  SelectGammaBinding,
  SelectGammaCoverState,
  SelectGammaWalkObjective
} from "./types.js";

export function createSelectGammaGenericWalkObjective(
  binding: SelectGammaBinding
): SelectGammaWalkObjective<SelectGammaCoverState> {
  const weights = binding.feature_weights;
  return Object.freeze({
    operator_id: SELECT_GAMMA_OPERATOR_ID,
    mathematical_class: "monotone_submodular" as const,
    createState: () => new Map<string, number>(),
    cloneState: (state: SelectGammaCoverState) => new Map(state),
    marginalGain: (candidate, state) =>
      selectGammaMarginalGain(candidate, state, weights),
    accept: (candidate, state) => acceptSelectGammaCoverage(candidate, state)
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
  const observation = (
    candidateKey: string,
    state: State
  ) => coverageObservation(
    boundCoverageState(byKey, candidateKey),
    state,
    params.supplementaryData
  );
  return Object.freeze({
    operator_id: objective.operator_id,
    mathematical_class: objective.mathematical_class,
    configuration_digest: objective.configuration_digest,
    createState: objective.createState,
    cloneState: objective.cloneState,
    marginalGain: (candidate, state) =>
      objective.marginalGain(observation(candidate.candidate_key, state)),
    accept: (candidate, state) =>
      objective.accept(observation(candidate.candidate_key, state))
  });
}

export function selectGammaObjectiveDigest(
  objective: SelectGammaWalkObjective
): Readonly<{
  readonly operator_id: string;
  readonly configuration_digest: string | null;
}> {
  return Object.freeze({
    operator_id: objective.operator_id,
    configuration_digest: objective.configuration_digest ?? null
  });
}

function coverageObservation<T extends CoverageSelectableCandidate, State>(
  bound: CoverageSelectionCandidateState<T>,
  state: State,
  supplementaryData: CoverageSelectionSupplementary
) {
  return {
    candidate: bound.candidate,
    identity: bound.identity,
    relevance: bound.relevance,
    coverage: bound.coverage,
    state,
    supplementaryData
  };
}

function boundCoverageState<T extends CoverageSelectableCandidate>(
  byKey: ReadonlyMap<string, CoverageSelectionCandidateState<T>>,
  candidateKey: string
): CoverageSelectionCandidateState<T> {
  const bound = byKey.get(candidateKey);
  if (bound === undefined) {
    throw new Error("Select_Gamma coverage candidate is absent from the walk binding");
  }
  return bound;
}
