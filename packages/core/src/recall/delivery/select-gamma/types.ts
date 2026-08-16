export type SelectGammaRisk = "clear" | "blocked";
export type SelectGammaAuthority = "clear" | "blocked";

export type SelectGammaEligibilityInput = Readonly<{
  readonly candidate_key: string;
  readonly risk: SelectGammaRisk;
  readonly authority: SelectGammaAuthority;
}>;

export type SelectGammaQualityParts = Readonly<{
  readonly relevance: number;
  readonly authority: number;
  readonly temporal_fit: number;
  readonly path_support: number;
}>;

export type SelectGammaFormulaCandidate = Readonly<{
  readonly candidate_key: string;
  readonly token_cost: number;
  readonly quality: number;
  readonly cover: Readonly<Record<string, number>>;
}>;

export type SelectGammaFeatureWeights = Readonly<Record<string, number>>;

export type SelectGammaBinding = Readonly<{
  readonly candidates: readonly SelectGammaFormulaCandidate[];
  readonly feature_weights?: SelectGammaFeatureWeights;
}>;

export type SelectGammaCoverState = Map<string, number>;
