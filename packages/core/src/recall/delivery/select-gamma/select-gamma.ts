import { compareCodeUnits } from "@do-soul/alaya-protocol";
import { lastSlotDisplacementDecisions } from "./admission/displacement.js";
import {
  createIdentityAdmission,
  rejectDuplicateIdentity,
  resolveIdentityPolicy,
  retainAdmittedIdentity,
  type IdentityAdmission
} from "./admission/identity.js";
import { createSelectGammaGenericWalkObjective } from "./walk-objective.js";
import type {
  SelectGammaBinding,
  SelectGammaDecision,
  SelectGammaDecisionReceipt,
  SelectGammaFormulaCandidate,
  SelectGammaIdentityPolicy,
  SelectGammaRequest,
  SelectGammaSelectionReceipt,
  SelectGammaWalkObjective,
  SelectGammaWalkResult
} from "./types.js";

type AdmissionState = Readonly<{
  readonly selectedCount: number;
  readonly usedTokens: number;
  readonly tokenBudget: number;
  readonly identity: IdentityAdmission;
  readonly perDimensionCounts: ReadonlyMap<string, number>;
  readonly limits: Readonly<{
    readonly maxSelected: number;
    readonly perDimensionLimits: Readonly<Record<string, number>> | null;
  }>;
}>;

type SelectionLimits = AdmissionState["limits"];

export function selectGammaWalk(
  request: SelectGammaRequest,
  binding: SelectGammaBinding,
  objective?: SelectGammaWalkObjective
): SelectGammaWalkResult {
  assertBoundIdentity(request, binding);
  assertTokenBudget(request.token_budget);
  const maxSelected = validateMaxSelected(binding.max_selected);
  validateDimensionLimits(binding.per_dimension_limits);
  assertUniqueEligibleKeys(request.eligible_candidate_keys);
  const walkObjective = objective ??
    createSelectGammaGenericWalkObjective(binding.feature_weights);
  const identityPolicy = resolveIdentityPolicy(binding);
  const indexed = indexCandidates(binding.candidates, binding.workspace_id);
  const remaining = request.eligible_candidate_keys.map((key) => {
    const candidate = indexed.get(key);
    if (candidate === undefined) {
      throw new Error(`Select_Gamma received an unknown candidate key: ${key}`);
    }
    return candidate;
  });
  const selectionReceipt = buildSelectionReceipt(
    remaining,
    maxSelected,
    request.token_budget,
    walkObjective,
    identityPolicy
  );
  return greedySelect(
    remaining,
    request.token_budget,
    walkObjective,
    {
      maxSelected,
      perDimensionLimits: binding.per_dimension_limits
    },
    selectionReceipt,
    identityPolicy
  );
}

function greedySelect<State>(
  remaining: SelectGammaFormulaCandidate[],
  tokenBudget: number,
  objective: SelectGammaWalkObjective<State>,
  limits: SelectionLimits,
  selectionReceipt: SelectGammaSelectionReceipt,
  identityPolicy: SelectGammaIdentityPolicy
): SelectGammaWalkResult {
  const selected: string[] = [];
  const decisions: SelectGammaDecision[] = [];
  const covered = objective.createState();
  const identity = createIdentityAdmission(identityPolicy);
  const perDimensionCounts = new Map<string, number>();
  let usedTokens = 0;
  while (remaining.length > 0) {
    const rejected = rejectConstrainedCandidates(remaining, {
      selectedCount: selected.length,
      usedTokens,
      tokenBudget,
      identity,
      perDimensionCounts,
      limits
    }, decisions);
    if (rejected.size === remaining.length) break;
    remaining.splice(0, remaining.length, ...remaining.filter((_, index) =>
      !rejected.has(index)));
    const picked = pickNext(
      remaining, covered, objective, selectionReceipt.ordering_basis
    );
    if (picked === null) break;
    usedTokens = admitPicked(
      remaining, picked, selected, decisions, covered, objective,
      identity, perDimensionCounts, usedTokens, limits
    );
  }
  return materializeWalkResult(selected, decisions, selectionReceipt);
}

function admitPicked<State>(
  remaining: SelectGammaFormulaCandidate[],
  picked: Readonly<{ readonly index: number; readonly gain: number }>,
  selected: string[],
  decisions: SelectGammaDecision[],
  covered: State,
  objective: SelectGammaWalkObjective<State>,
  identity: IdentityAdmission,
  perDimensionCounts: Map<string, number>,
  usedTokens: number,
  limits: SelectionLimits
): number {
  const candidate = remaining.splice(picked.index, 1)[0]!;
  const lastSlot = selected.length + 1 >= limits.maxSelected;
  const losers = lastSlot ? remaining.splice(0) : [];
  decisions.push(retainedDecision(
    candidate, decisions.length + 1, selected.length, usedTokens, picked.gain
  ));
  selected.push(candidate.candidate_key);
  const nextUsedTokens = usedTokens + candidate.token_cost;
  retainAdmittedIdentity(candidate, identity);
  incrementDimensionCount(candidate.dimension ?? "unbound", perDimensionCounts);
  if (losers.length > 0) {
    decisions.push(...lastSlotDisplacementDecisions(
      losers, candidate, picked.gain, covered, objective, decisions.length + 1
    ));
  }
  objective.accept(candidate, covered);
  return nextUsedTokens;
}

function materializeWalkResult(
  selected: string[],
  decisions: SelectGammaDecision[],
  selectionReceipt: SelectGammaSelectionReceipt
): SelectGammaWalkResult {
  return Object.freeze({
    selected_candidate_keys: Object.freeze(selected),
    decisions: Object.freeze(decisions),
    selection_receipt: selectionReceipt
  });
}

function incrementDimensionCount(
  dimension: string,
  counts: Map<string, number>
): void {
  counts.set(dimension, (counts.get(dimension) ?? 0) + 1);
}

function pickNext<State>(
  remaining: readonly SelectGammaFormulaCandidate[],
  covered: State,
  objective: SelectGammaWalkObjective<State>,
  orderingBasis: SelectGammaSelectionReceipt["ordering_basis"]
): Readonly<{ readonly index: number; readonly gain: number }> | null {
  let bestIndex = -1;
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestGain = Number.NEGATIVE_INFINITY;
  let bestAuthority = Number.NEGATIVE_INFINITY;
  let bestKey = "";
  for (let index = 0; index < remaining.length; index += 1) {
    const candidate = remaining[index]!;
    assertTokenCost(candidate.token_cost);
    const gain = objective.marginalGain(candidate, covered);
    const score = orderingBasis === "raw_marginal_gain"
      ? gain : gain / candidate.token_cost;
    const authority = authorityTieBreakRank(candidate);
    if (isPreferredCandidate(
      score, authority, candidate.candidate_key,
      bestScore, bestAuthority, bestKey
    )) {
      bestScore = score;
      bestIndex = index;
      bestAuthority = authority;
      bestKey = candidate.candidate_key;
      bestGain = gain;
    }
  }
  return bestIndex < 0 ? null : Object.freeze({ index: bestIndex, gain: bestGain });
}

function isPreferredCandidate(
  score: number,
  authority: number,
  candidateKey: string,
  bestScore: number,
  bestAuthority: number,
  bestKey: string
): boolean {
  return score > bestScore || (score === bestScore && (
    authority > bestAuthority || (authority === bestAuthority &&
      compareCodeUnits(candidateKey, bestKey) < 0)
  ));
}

function authorityTieBreakRank(candidate: SelectGammaFormulaCandidate): number {
  if (candidate.authority_tie_break === "verified_user_assertion") return 2;
  if (candidate.authority_tie_break === "verified_user_projection") return 1;
  return 0;
}

function rejectConstrainedCandidates(
  remaining: readonly SelectGammaFormulaCandidate[],
  state: AdmissionState,
  decisions: SelectGammaDecision[]
): ReadonlySet<number> {
  const rejected = new Set<number>();
  remaining.forEach((candidate, index) => {
    const receipt = rejectedReceipt(candidate, state);
    if (receipt === null) return;
    rejected.add(index);
    decisions.push(Object.freeze({
      candidate_key: candidate.candidate_key,
      selection_order: decisions.length + 1,
      selected_rank: null,
      marginal_gain: null,
      receipt
    }));
  });
  return rejected;
}

function rejectedReceipt(
  candidate: SelectGammaFormulaCandidate,
  state: AdmissionState
): SelectGammaDecisionReceipt | null {
  const eligibility = candidate.eligibility;
  if (eligibility.risk === "blocked" || eligibility.authority === "blocked") {
    return Object.freeze({ kind: "ineligible", ...eligibility });
  }
  const duplicate = rejectDuplicateIdentity(candidate, state.identity);
  if (duplicate !== null) return duplicate;
  const dimension = candidate.dimension;
  const dimensionCount = state.perDimensionCounts.get(dimension) ?? 0;
  const dimensionLimit = state.limits.perDimensionLimits?.[dimension] ?? null;
  if (dimensionLimit !== null && dimensionCount >= dimensionLimit) {
    return Object.freeze({
      kind: "dimension_limit", dimension,
      accepted_before: dimensionCount, limit: dimensionLimit
    });
  }
  if (state.selectedCount >= state.limits.maxSelected) {
    return Object.freeze({
      kind: "max_entries", accepted_before: state.selectedCount,
      limit: state.limits.maxSelected
    });
  }
  assertTokenCost(candidate.token_cost);
  return state.usedTokens + candidate.token_cost > state.tokenBudget
    ? Object.freeze({
        kind: "max_total_tokens", token_total_before: state.usedTokens,
        token_estimate: candidate.token_cost, limit: state.tokenBudget
      })
    : null;
}

function retainedDecision(
  candidate: SelectGammaFormulaCandidate,
  selectionOrder: number,
  selectedCount: number,
  usedTokens: number,
  gain: number
): SelectGammaDecision {
  return Object.freeze({
    candidate_key: candidate.candidate_key,
    selection_order: selectionOrder,
    selected_rank: selectedCount + 1,
    marginal_gain: gain,
    receipt: Object.freeze({
      kind: "retained",
      selected_count_before: selectedCount,
      token_total_before: usedTokens,
      token_estimate: candidate.token_cost,
      source: candidate.source,
      lineage: candidate.lineage
    })
  });
}

function buildSelectionReceipt(
  candidates: readonly SelectGammaFormulaCandidate[],
  maxSelected: number,
  tokenBudget: number,
  objective: SelectGammaWalkObjective,
  identityPolicy: SelectGammaIdentityPolicy
): SelectGammaSelectionReceipt {
  const cardinalityBound = Math.min(maxSelected, candidates.length);
  const tokenCosts = candidates.map(({ token_cost }) => {
    assertTokenCost(token_cost);
    return token_cost;
  }).sort((left, right) => right - left);
  const maxTokenCostSum = sumFiniteTopKTokenCosts(
    tokenCosts,
    cardinalityBound
  );
  const operatorId = objective.operator_id.trim();
  if (operatorId.length === 0) {
    throw new Error("Select_Gamma objective operator id must be non-empty");
  }
  const witness = Object.freeze({
    kind: "static_top_k_token_bound" as const,
    eligible_candidate_count: candidates.length,
    k: cardinalityBound,
    top_k_token_cost_upper_bound: maxTokenCostSum,
    token_budget: tokenBudget
  });
  return Object.freeze({
    schema_version: 4 as const,
    objective_semantic_id: operatorId,
    configuration_digest: objective.configuration_digest ?? null,
    source_hard_dedupe: identityPolicy === "source_hard_dedupe",
    ordering_basis: maxTokenCostSum <= tokenBudget
      ? "raw_marginal_gain" as const
      : "marginal_gain_per_token" as const,
    witness
  });
}

function sumFiniteTopKTokenCosts(
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

function validateMaxSelected(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Select_Gamma max_selected must be a non-negative integer");
  }
  return value;
}

function validateDimensionLimits(
  limits: Readonly<Record<string, number>> | null
): void {
  if (limits === null) return;
  for (const [dimension, limit] of Object.entries(limits)) {
    if (dimension.length === 0 || !Number.isSafeInteger(limit) || limit < 0) {
      throw new Error("Select_Gamma dimension limits must be non-negative integers");
    }
  }
}

function assertUniqueEligibleKeys(keys: readonly string[]): void {
  if (new Set(keys).size !== keys.length) {
    throw new Error("Select_Gamma eligible candidate keys must be unique");
  }
}

function assertTokenCost(tokenCost: number): void {
  if (!Number.isFinite(tokenCost) || tokenCost <= 0) {
    throw new Error("Select_Gamma token_cost must be finite and positive");
  }
}

function assertTokenBudget(tokenBudget: number): void {
  if (!Number.isFinite(tokenBudget) || tokenBudget < 0) {
    throw new Error("Select_Gamma token_budget must be finite and non-negative");
  }
}

function indexCandidates(
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

function assertBoundIdentity(
  request: SelectGammaRequest,
  binding: SelectGammaBinding
): void {
  if (request.workspace_id !== binding.workspace_id ||
      request.generation_id !== binding.generation_id ||
      request.condition_digest !== binding.condition_digest) {
    throw new Error("Select_Gamma request identity does not match the binding");
  }
}
