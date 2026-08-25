import type {
  SelectGammaFormulaCandidate,
  SelectGammaGainParts,
  SelectGammaWalkObjective
} from "../types.js";
import {
  resolveCoverAvailability,
  type BindingValuesStatus
} from "./composition.js";
import { acceptBindingCoverRho, bindingCoverRho, boundRedundancy } from "./rho.js";
import {
  BINDING_COVER_VALUE_WEIGHT,
  OBLIGATION_COVER_PREFIX,
  SELECT_GAMMA_BINDING_COVERAGE_OPERATOR_ID,
  type BindingCoverState,
  type CandidateBindingCoverageReceipt
} from "./types.js";

export function createBindingAwareWalkObjective(params: Readonly<{
  readonly receiptsByCandidateKey: ReadonlyMap<string, CandidateBindingCoverageReceipt>;
  readonly contentKeyByCandidateKey?: ReadonlyMap<string, string>;
  readonly rankingScoreByCandidateKey?: ReadonlyMap<string, number>;
  readonly valuesStatus: BindingValuesStatus;
  readonly obligationFacetCount?: number;
  readonly configurationDigest: string;
  readonly facility?: SelectGammaWalkObjective<unknown> | null;
}>): SelectGammaWalkObjective<BindingCoverState> {
  const receipts = params.receiptsByCandidateKey;
  const contentKeys = params.contentKeyByCandidateKey ?? new Map<string, string>();
  const rankingScores = params.rankingScoreByCandidateKey;
  const facility = params.facility ?? null;
  const valuesStatus = params.valuesStatus;
  const obligationFacetCount = params.obligationFacetCount ?? 0;
  return Object.freeze({
    operator_id: SELECT_GAMMA_BINDING_COVERAGE_OPERATOR_ID,
    configuration_digest: params.configurationDigest,
    createState: () => createBindingCoverState(facility),
    cloneState: (state) => cloneBindingCoverState(state, facility),
    marginalGain: (candidate, state) =>
      bindingAwareGain(
        candidate, state, receipts, contentKeys, facility, rankingScores,
        valuesStatus, obligationFacetCount
      ),
    accept: (candidate, state) =>
      acceptBindingAware(candidate, state, receipts, contentKeys, facility),
    decomposeGain: (candidate, state) =>
      decomposeBindingGain(
        candidate, state, receipts, facility, valuesStatus, obligationFacetCount
      )
  });
}

function createBindingCoverState(
  facility: SelectGammaWalkObjective<unknown> | null
): BindingCoverState {
  return {
    facility: facility?.createState() ?? null,
    obligationCovered: new Map<string, number>(),
    valuesByVariable: new Map<string, Set<string>>(),
    lineageKeys: new Set<string>(),
    contentKeys: new Set<string>()
  };
}

function cloneBindingCoverState(
  state: BindingCoverState,
  facility: SelectGammaWalkObjective<unknown> | null
): BindingCoverState {
  return {
    facility: facility?.cloneState === undefined
      ? state.facility
      : facility.cloneState(state.facility),
    obligationCovered: new Map(state.obligationCovered),
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
  receipts: ReadonlyMap<string, CandidateBindingCoverageReceipt>,
  contentKeys: ReadonlyMap<string, string>,
  facility: SelectGammaWalkObjective<unknown> | null,
  rankingScoreByCandidateKey: ReadonlyMap<string, number> | undefined,
  valuesStatus: BindingValuesStatus,
  obligationFacetCount: number
): number {
  const coverGain = incrementalCoverGain(candidate, state, receipts);
  const availability = resolveCoverAvailability({
    valuesStatus,
    obligationFacetCount,
    coverGain
  });
  const positive = availability === "positive"
    ? qualityTerm(candidate, state, facility) + coverGain
    : rankingScore(candidate, rankingScoreByCandidateKey);
  const rho = boundRedundancy(
    bindingCoverRho(candidate, state, contentKeys.get(candidate.candidate_key)),
    positive
  );
  return positive - rho;
}

function decomposeBindingGain(
  candidate: SelectGammaFormulaCandidate,
  state: BindingCoverState,
  receipts: ReadonlyMap<string, CandidateBindingCoverageReceipt>,
  facility: SelectGammaWalkObjective<unknown> | null,
  valuesStatus: BindingValuesStatus,
  obligationFacetCount: number
): SelectGammaGainParts {
  const coverGain = incrementalCoverGain(candidate, state, receipts);
  const cover_availability = resolveCoverAvailability({
    valuesStatus,
    obligationFacetCount,
    coverGain
  });
  return Object.freeze({
    quality: qualityTerm(candidate, state, facility),
    coverage: cover_availability === "unavailable" ? 0 : coverGain,
    cover_availability
  });
}

function incrementalCoverGain(
  candidate: SelectGammaFormulaCandidate,
  state: BindingCoverState,
  receipts: ReadonlyMap<string, CandidateBindingCoverageReceipt>
): number {
  return obligationFacetGain(candidate, state) +
    BINDING_COVER_VALUE_WEIGHT * newValueCount(candidate.candidate_key, receipts, state);
}

function rankingScore(
  candidate: SelectGammaFormulaCandidate,
  rankingScoreByCandidateKey: ReadonlyMap<string, number> | undefined
): number {
  return rankingScoreByCandidateKey?.get(candidate.candidate_key) ?? candidate.quality;
}

function qualityTerm(
  candidate: SelectGammaFormulaCandidate,
  state: BindingCoverState,
  facility: SelectGammaWalkObjective<unknown> | null
): number {
  if (facility === null) return candidate.quality;
  return facility.marginalGain(candidate, state.facility) + temporalFit(candidate);
}

function temporalFit(candidate: SelectGammaFormulaCandidate): number {
  return candidate.quality_channels.temporal.status === "available"
    ? candidate.quality_channels.temporal.value
    : 0;
}

function obligationFacetGain(
  candidate: SelectGammaFormulaCandidate,
  state: BindingCoverState
): number {
  let gain = 0;
  for (const [feature, amount] of Object.entries(candidate.cover)) {
    if (!feature.startsWith(OBLIGATION_COVER_PREFIX)) continue;
    const previous = state.obligationCovered.get(feature) ?? 0;
    gain += Math.min(1, previous + amount) - Math.min(1, previous);
  }
  return gain;
}

function acceptBindingAware(
  candidate: SelectGammaFormulaCandidate,
  state: BindingCoverState,
  receipts: ReadonlyMap<string, CandidateBindingCoverageReceipt>,
  contentKeys: ReadonlyMap<string, string>,
  facility: SelectGammaWalkObjective<unknown> | null
): void {
  facility?.accept(candidate, state.facility);
  acceptObligationCover(candidate, state);
  acceptValues(candidate.candidate_key, receipts, state);
  acceptBindingCoverRho(candidate, state, contentKeys.get(candidate.candidate_key));
}

function acceptObligationCover(
  candidate: SelectGammaFormulaCandidate,
  state: BindingCoverState
): void {
  for (const [feature, amount] of Object.entries(candidate.cover)) {
    if (!feature.startsWith(OBLIGATION_COVER_PREFIX)) continue;
    state.obligationCovered.set(
      feature,
      (state.obligationCovered.get(feature) ?? 0) + amount
    );
  }
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
