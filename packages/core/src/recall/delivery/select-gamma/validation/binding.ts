import type {
  SelectGammaBinding,
  SelectGammaFormulaCandidate,
  SelectGammaRequest
} from "../types.js";

export function validateMaxSelected(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Select_Gamma max_selected must be a non-negative integer");
  }
  return value;
}

export function validateDimensionLimits(
  limits: Readonly<Record<string, number>> | null
): void {
  if (limits === null) return;
  for (const [dimension, limit] of Object.entries(limits)) {
    if (dimension.length === 0 || !Number.isSafeInteger(limit) || limit < 0) {
      throw new Error("Select_Gamma dimension limits must be non-negative integers");
    }
  }
}

export function assertUniqueEligibleKeys(keys: readonly string[]): void {
  if (new Set(keys).size !== keys.length) {
    throw new Error("Select_Gamma eligible candidate keys must be unique");
  }
}

export function assertTokenCost(tokenCost: number): void {
  if (!Number.isFinite(tokenCost) || tokenCost <= 0) {
    throw new Error("Select_Gamma token_cost must be finite and positive");
  }
}

export function assertTokenBudget(tokenBudget: number): void {
  if (!Number.isFinite(tokenBudget) || tokenBudget < 0) {
    throw new Error("Select_Gamma token_budget must be finite and non-negative");
  }
}

export function indexCandidates(
  candidates: readonly SelectGammaFormulaCandidate[],
  workspaceId: string
): ReadonlyMap<string, SelectGammaFormulaCandidate> {
  const indexed = new Map<string, SelectGammaFormulaCandidate>();
  for (const candidate of candidates) {
    if (candidate.workspace_id !== workspaceId) {
      throw new Error("Select_Gamma candidate workspace does not match the binding");
    }
    if (indexed.has(candidate.candidate_key)) {
      throw new Error("Select_Gamma candidate keys must be unique");
    }
    indexed.set(candidate.candidate_key, candidate);
  }
  return indexed;
}

export function assertBoundIdentity(
  request: SelectGammaRequest,
  binding: SelectGammaBinding
): void {
  if (request.workspace_id !== binding.workspace_id ||
      request.generation_id !== binding.generation_id ||
      request.condition_digest !== binding.condition_digest) {
    throw new Error("Select_Gamma request identity does not match the binding");
  }
}

export function sumFiniteTopKTokenCosts(
  descendingTokenCosts: readonly number[],
  k: number
): number {
  let sum = 0;
  for (const tokenCost of descendingTokenCosts.slice(0, k)) {
    sum += tokenCost;
    if (!Number.isFinite(sum)) {
      throw new Error("Select_Gamma top-K token cost upper bound must be finite");
    }
  }
  return sum;
}
