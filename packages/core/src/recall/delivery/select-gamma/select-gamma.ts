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
import {
  assertBoundIdentity,
  assertTokenBudget,
  assertTokenCost,
  assertUniqueEligibleKeys,
  indexCandidates,
  sumFiniteTopKTokenCosts,
  validateDimensionLimits,
  validateMaxSelected
} from "./validation/binding.js";

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

type GreedyWalk<State> = {
  remaining: SelectGammaFormulaCandidate[];
  selected: string[];
  decisions: SelectGammaDecision[];
  covered: State;
  identity: IdentityAdmission;
  perDimensionCounts: Map<string, number>;
  usedTokens: number;
  readonly tokenBudget: number;
  readonly limits: SelectionLimits;
  readonly objective: SelectGammaWalkObjective<State>;
  readonly orderingBasis: SelectGammaSelectionReceipt["ordering_basis"];
};

type PickedCandidate = Readonly<{
  readonly index: number;
  readonly gain: number;
}>;

export function selectGammaWalk(
  request: SelectGammaRequest,
  binding: SelectGammaBinding
): SelectGammaWalkResult;
export function selectGammaWalk<State>(
  request: SelectGammaRequest,
  binding: SelectGammaBinding,
  objective: SelectGammaWalkObjective<State>
): SelectGammaWalkResult;
export function selectGammaWalk<State>(
  request: SelectGammaRequest,
  binding: SelectGammaBinding,
  objective?: SelectGammaWalkObjective<State>
): SelectGammaWalkResult {
  if (objective === undefined) {
    return runSelectGammaWalk(
      request,
      binding,
      createSelectGammaGenericWalkObjective(binding.feature_weights)
    );
  }
  return runSelectGammaWalk(request, binding, objective);
}

function runSelectGammaWalk<State>(
  request: SelectGammaRequest,
  binding: SelectGammaBinding,
  walkObjective: SelectGammaWalkObjective<State>
): SelectGammaWalkResult {
  assertBoundIdentity(request, binding);
  assertTokenBudget(request.token_budget);
  const maxSelected = validateMaxSelected(binding.max_selected);
  validateDimensionLimits(binding.per_dimension_limits);
  assertUniqueEligibleKeys(request.eligible_candidate_keys);
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
  const walk: GreedyWalk<State> = {
    remaining,
    selected: [],
    decisions: [],
    covered: objective.createState(),
    identity: createIdentityAdmission(identityPolicy),
    perDimensionCounts: new Map<string, number>(),
    usedTokens: 0,
    tokenBudget,
    limits,
    objective,
    orderingBasis: selectionReceipt.ordering_basis
  };
  while (walk.remaining.length > 0) {
    if (!advanceGreedyStep(walk)) break;
  }
  return materializeWalkResult(walk.selected, walk.decisions, selectionReceipt);
}

function advanceGreedyStep<State>(walk: GreedyWalk<State>): boolean {
  const rejected = rejectConstrainedCandidates(
    walk.remaining, admissionFrom(walk), walk.decisions
  );
  if (rejected.size === walk.remaining.length) return false;
  walk.remaining.splice(0, walk.remaining.length, ...walk.remaining.filter((_, index) =>
    !rejected.has(index)));
  const picked = pickNext(
    walk.remaining, walk.covered, walk.objective, walk.orderingBasis
  );
  if (picked === null) return false;
  retainWinnerThenDisplace(walk, picked);
  return true;
}

function admissionFrom<State>(walk: GreedyWalk<State>): AdmissionState {
  return {
    selectedCount: walk.selected.length,
    usedTokens: walk.usedTokens,
    tokenBudget: walk.tokenBudget,
    identity: walk.identity,
    perDimensionCounts: walk.perDimensionCounts,
    limits: walk.limits
  };
}

function retainWinnerThenDisplace<State>(
  walk: GreedyWalk<State>,
  picked: PickedCandidate
): void {
  const winner = walk.remaining.splice(picked.index, 1)[0]!;
  const lastSlot = walk.selected.length + 1 >= walk.limits.maxSelected;
  const losers = lastSlot ? walk.remaining.splice(0) : [];
  retainWinner(walk, winner, picked.gain);
  if (losers.length > 0) {
    recordLastSlotDisplacement(walk, winner, picked.gain, losers);
  }
  walk.objective.accept(winner, walk.covered);
}

function retainWinner<State>(
  walk: GreedyWalk<State>,
  candidate: SelectGammaFormulaCandidate,
  gain: number
): void {
  walk.decisions.push(retainedDecision(
    candidate, walk.decisions.length + 1, walk.selected.length, walk.usedTokens, gain
  ));
  walk.selected.push(candidate.candidate_key);
  walk.usedTokens += candidate.token_cost;
  retainAdmittedIdentity(candidate, walk.identity);
  incrementDimensionCount(candidate.dimension ?? "unbound", walk.perDimensionCounts);
}

function recordLastSlotDisplacement<State>(
  walk: GreedyWalk<State>,
  winner: SelectGammaFormulaCandidate,
  winnerGain: number,
  losers: readonly SelectGammaFormulaCandidate[]
): void {
  const duplicateLosers: Array<readonly [SelectGammaFormulaCandidate, SelectGammaDecisionReceipt]> = [];
  const displacedLosers: SelectGammaFormulaCandidate[] = [];
  for (const loser of losers) {
    const duplicate = rejectDuplicateIdentity(loser, walk.identity);
    if (duplicate === null) {
      displacedLosers.push(loser);
    } else {
      duplicateLosers.push([loser, duplicate]);
    }
  }
  walk.decisions.push(...duplicateLosers.map(([candidate, receipt], index) =>
    Object.freeze({
      candidate_key: candidate.candidate_key,
      selection_order: walk.decisions.length + index + 1,
      selected_rank: null,
      marginal_gain: null,
      receipt
    })
  ));
  walk.decisions.push(...lastSlotDisplacementDecisions(
    displacedLosers,
    winner,
    winnerGain,
    walk.covered,
    walk.objective,
    walk.decisions.length + 1
  ));
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
  objective: Readonly<{
    readonly operator_id: string;
    readonly configuration_digest?: string;
  }>,
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

