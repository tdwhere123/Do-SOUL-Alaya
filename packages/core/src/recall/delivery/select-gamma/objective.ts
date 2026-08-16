import type {
  SelectGammaCoverState,
  SelectGammaFeatureWeights
} from "./types.js";

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
