import {
  acceptSelectGammaCoverage,
  selectGammaMarginalGain
} from "../objective.js";
import type {
  SelectGammaFeatureWeights,
  SelectGammaFormulaCandidate,
  SelectGammaWalkObjective
} from "../types.js";
import { acceptBindingCoverRho, bindingCoverRho, boundRedundancy } from "./rho.js";
import {
  BINDING_COVER_CONFIGURATION_DIGEST,
  BINDING_COVER_VALUE_WEIGHT,
  SELECT_GAMMA_BINDING_COVERAGE_OPERATOR_ID,
  type BindingCoverState,
  type CandidateBindingCoverageReceipt
} from "./types.js";

export function createBindingAwareWalkObjective(params: Readonly<{
  readonly weights: SelectGammaFeatureWeights;
  readonly receiptsByCandidateKey: ReadonlyMap<string, CandidateBindingCoverageReceipt>;
  readonly contentKeyByCandidateKey?: ReadonlyMap<string, string>;
}>): SelectGammaWalkObjective<BindingCoverState> {
  const receipts = params.receiptsByCandidateKey;
  const contentKeys = params.contentKeyByCandidateKey ?? new Map<string, string>();
  const weights = params.weights;
  return Object.freeze({
    operator_id: SELECT_GAMMA_BINDING_COVERAGE_OPERATOR_ID,
    configuration_digest: BINDING_COVER_CONFIGURATION_DIGEST,
    createState: createBindingCoverState,
    cloneState: cloneBindingCoverState,
    marginalGain: (candidate, state) =>
      bindingAwareGain(candidate, state, weights, receipts, contentKeys),
    accept: (candidate, state) =>
      acceptBindingAware(candidate, state, receipts, contentKeys),
    decomposeGain: (candidate, state) => Object.freeze({
      quality: candidate.quality,
      coverage: coverageGain(candidate, state, weights, receipts, contentKeys)
    })
  });
}

export function createBindingCoverState(): BindingCoverState {
  return {
    covered: new Map<string, number>(),
    valuesByVariable: new Map<string, Set<string>>(),
    lineageKeys: new Set<string>(),
    contentKeys: new Set<string>()
  };
}

export function cloneBindingCoverState(state: BindingCoverState): BindingCoverState {
  return {
    covered: new Map(state.covered),
    valuesByVariable: new Map([...state.valuesByVariable].map(([variable, values]) =>
      [variable, new Set(values)]
    )),
    lineageKeys: new Set(state.lineageKeys),
    contentKeys: new Set(state.contentKeys)
  };
}

function bindingAwareGain(
  candidate: SelectGammaFormulaCandidate,
  state: BindingCoverState,
  weights: SelectGammaFeatureWeights,
  receipts: ReadonlyMap<string, CandidateBindingCoverageReceipt>,
  contentKeys: ReadonlyMap<string, string>
): number {
  const positive = selectGammaMarginalGain(candidate, state.covered, weights) +
    BINDING_COVER_VALUE_WEIGHT * newValueCount(candidate.candidate_key, receipts, state);
  const rho = boundRedundancy(
    bindingCoverRho(candidate, state, contentKeys.get(candidate.candidate_key)),
    positive
  );
  return positive - rho;
}

function coverageGain(
  candidate: SelectGammaFormulaCandidate,
  state: BindingCoverState,
  weights: SelectGammaFeatureWeights,
  receipts: ReadonlyMap<string, CandidateBindingCoverageReceipt>,
  contentKeys: ReadonlyMap<string, string>
): number {
  return bindingAwareGain(candidate, state, weights, receipts, contentKeys) -
    candidate.quality;
}

function acceptBindingAware(
  candidate: SelectGammaFormulaCandidate,
  state: BindingCoverState,
  receipts: ReadonlyMap<string, CandidateBindingCoverageReceipt>,
  contentKeys: ReadonlyMap<string, string>
): void {
  acceptSelectGammaCoverage(candidate, state.covered);
  acceptValues(candidate.candidate_key, receipts, state);
  acceptBindingCoverRho(candidate, state, contentKeys.get(candidate.candidate_key));
}

function newValueCount(
  candidateKey: string,
  receipts: ReadonlyMap<string, CandidateBindingCoverageReceipt>,
  state: BindingCoverState
): number {
  const receipt = receipts.get(candidateKey);
  if (receipt === undefined) return 0;
  let added = 0;
  for (const value of receipt.values) {
    const existing = state.valuesByVariable.get(value.variable_id);
    if (existing === undefined || !existing.has(value.semantic_identity)) {
      added += 1;
    }
  }
  return added;
}

function acceptValues(
  candidateKey: string,
  receipts: ReadonlyMap<string, CandidateBindingCoverageReceipt>,
  state: BindingCoverState
): void {
  const receipt = receipts.get(candidateKey);
  if (receipt === undefined) return;
  for (const value of receipt.values) {
    const current = state.valuesByVariable.get(value.variable_id);
    if (current === undefined) {
      state.valuesByVariable.set(value.variable_id, new Set([value.semantic_identity]));
      continue;
    }
    current.add(value.semantic_identity);
  }
}
