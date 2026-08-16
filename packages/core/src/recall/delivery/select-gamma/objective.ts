import { SELECT_GAMMA_OPERATOR_ID } from "@do-soul/alaya-protocol";
import type {
  CoverageSelectableCandidate,
  CoverageSelectionObjective
} from "../coverage-selection.js";
import type {
  SelectGammaCoverState,
  SelectGammaFeatureWeights,
  SelectGammaFormulaCandidate
} from "./types.js";

export type SelectGammaCoverageState = Readonly<{
  readonly covered: SelectGammaCoverState;
}>;

export function selectGammaMarginalGain(
  candidate: Readonly<{
    readonly quality: number;
    readonly cover: Readonly<Record<string, number>>;
  }>,
  covered: ReadonlyMap<string, number>,
  weights: SelectGammaFeatureWeights
): number {
  if (!Number.isFinite(candidate.quality) || candidate.quality < 0) {
    throw new Error("Select_Gamma quality must be finite and non-negative");
  }
  let gain = candidate.quality;
  for (const [feature, weight] of Object.entries(weights)) {
    const increment = unitCover(candidate.cover[feature]);
    const previous = covered.get(feature) ?? 0;
    gain += nonNegative(weight) * (
      Math.min(1, previous + increment) - Math.min(1, previous)
    );
  }
  return gain;
}

export function acceptSelectGammaCoverage(
  candidate: Readonly<{ readonly cover: Readonly<Record<string, number>> }>,
  covered: SelectGammaCoverState
): void {
  for (const [feature, amount] of Object.entries(candidate.cover)) {
    covered.set(feature, (covered.get(feature) ?? 0) + unitCover(amount));
  }
}

export function createSelectGammaCoverageObjective<
  T extends CoverageSelectableCandidate
>(config: Readonly<{
  readonly feature_weights: SelectGammaFeatureWeights;
  readonly coverByKey?: ReadonlyMap<string, SelectGammaFormulaCandidate>;
}>): CoverageSelectionObjective<T, SelectGammaCoverageState> {
  const weights = config.feature_weights;
  const coverByKey = config.coverByKey ?? new Map();
  return Object.freeze({
    operator_id: SELECT_GAMMA_OPERATOR_ID,
    mathematical_class: "monotone_submodular",
    createState: () => ({ covered: new Map() }),
    cloneState: (state) => ({ covered: new Map(state.covered) }),
    marginalGain: ({ candidate, state }) => {
      const formula = coverByKey.get(candidate.fusion.candidate_key);
      if (formula === undefined) {
        throw new Error("Select_Gamma objective is missing candidate cover");
      }
      return selectGammaMarginalGain(formula, state.covered, weights);
    },
    accept: ({ candidate, state }) => {
      const formula = coverByKey.get(candidate.fusion.candidate_key);
      if (formula === undefined) {
        throw new Error("Select_Gamma objective is missing candidate cover");
      }
      acceptSelectGammaCoverage(formula, state.covered);
    },
    compareCandidatesOnEqualGain: (left, right) =>
      compareText(left.fusion.candidate_key, right.fusion.candidate_key)
  });
}

function unitCover(value: number | undefined): number {
  const amount = value ?? 0;
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error("Select_Gamma cover must be finite and non-negative");
  }
  return amount;
}

function nonNegative(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Select_Gamma feature weight must be finite and non-negative");
  }
  return value;
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}
