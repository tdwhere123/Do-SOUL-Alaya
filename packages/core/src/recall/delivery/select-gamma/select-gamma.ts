import type {
  SelectGammaPort,
  SelectGammaRequest,
  SelectGammaResult
} from "@do-soul/alaya-protocol";
import {
  acceptSelectGammaCoverage,
  selectGammaMarginalGain
} from "./objective.js";
import type {
  SelectGammaBinding,
  SelectGammaFeatureWeights,
  SelectGammaFormulaCandidate
} from "./types.js";

export function createSelectGammaPort(
  binding: SelectGammaBinding
): SelectGammaPort {
  const candidates = indexCandidates(binding.candidates);
  const weights = binding.feature_weights ?? {};
  return Object.freeze({
    select: (request: SelectGammaRequest): SelectGammaResult => Object.freeze({
      selected_candidate_keys: selectFormulaCandidates(
        request,
        candidates,
        weights,
        binding.max_selected
      )
    })
  });
}

function selectFormulaCandidates(
  request: SelectGammaRequest,
  candidates: ReadonlyMap<string, SelectGammaFormulaCandidate>,
  weights: SelectGammaFeatureWeights,
  maxSelected?: number
): readonly string[] {
  assertTokenBudget(request.token_budget);
  const remaining = request.eligible_candidate_keys.map((key) => {
    const candidate = candidates.get(key);
    if (candidate === undefined) {
      throw new Error(`Select_Gamma received an unknown candidate key: ${key}`);
    }
    return candidate;
  });
  return greedySelect(remaining, request.token_budget, weights, maxSelected);
}

function greedySelect(
  remaining: SelectGammaFormulaCandidate[],
  tokenBudget: number,
  weights: SelectGammaFeatureWeights,
  maxSelected?: number
): readonly string[] {
  const selected: string[] = [];
  const covered = new Map<string, number>();
  let usedTokens = 0;
  while (remaining.length > 0) {
    if (maxSelected !== undefined && selected.length >= maxSelected) break;
    const picked = pickNext(
      remaining,
      covered,
      weights,
      tokenBudget - usedTokens
    );
    if (picked === null) break;
    const candidate = remaining.splice(picked.index, 1)[0]!;
    selected.push(candidate.candidate_key);
    usedTokens += candidate.token_cost;
    acceptSelectGammaCoverage(candidate, covered);
  }
  return Object.freeze(selected);
}

function pickNext(
  remaining: readonly SelectGammaFormulaCandidate[],
  covered: ReadonlyMap<string, number>,
  weights: SelectGammaFeatureWeights,
  remainingTokens: number
): Readonly<{ readonly index: number }> | null {
  let bestIndex = -1;
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestKey = "";
  for (let index = 0; index < remaining.length; index += 1) {
    const candidate = remaining[index]!;
    if (!fitsTokenBudget(candidate.token_cost, remainingTokens)) continue;
    const gain = selectGammaMarginalGain(candidate, covered, weights);
    const score = gain / candidate.token_cost;
    if (score > bestScore || (score === bestScore && candidate.candidate_key < bestKey)) {
      bestScore = score;
      bestIndex = index;
      bestKey = candidate.candidate_key;
    }
  }
  return bestIndex < 0 ? null : Object.freeze({ index: bestIndex });
}

function fitsTokenBudget(tokenCost: number, remainingTokens: number): boolean {
  if (!Number.isFinite(tokenCost) || tokenCost <= 0) {
    throw new Error("Select_Gamma token_cost must be finite and positive");
  }
  return tokenCost <= remainingTokens;
}

function assertTokenBudget(tokenBudget: number): void {
  if (!Number.isFinite(tokenBudget) || tokenBudget < 0) {
    throw new Error("Select_Gamma token_budget must be finite and non-negative");
  }
}

function indexCandidates(
  candidates: readonly SelectGammaFormulaCandidate[]
): ReadonlyMap<string, SelectGammaFormulaCandidate> {
  const indexed = new Map<string, SelectGammaFormulaCandidate>();
  for (const candidate of candidates) {
    if (indexed.has(candidate.candidate_key)) {
      throw new Error("Select_Gamma candidate keys must be unique");
    }
    indexed.set(candidate.candidate_key, candidate);
  }
  return indexed;
}
