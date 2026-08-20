import type {
  CoverageSelectableCandidate,
  CoverageSelectionCandidateState,
  CoverageSelectionObjective,
  CoverageSelectionObjectiveReceipt,
  CoverageSelectionSupplementary
} from "../../delivery/coverage-selection.js";
import {
  evaluateCoverageSelectionCandidateStates,
  materializeCoverageSelectionObjectiveReceipt,
  orderCoverageSelectionCandidateStatesByMarginalGain
} from
  "../../delivery/coverage-selection.js";
import { compareText } from "../../../shared/compare-text.js";

const SCORE_EPSILON = 1e-12;

export type CoverageCardinalityLocalSearchReceipt = Readonly<{
  readonly objective: CoverageSelectionObjectiveReceipt;
  readonly initial_score: number;
  readonly final_score: number;
  readonly selected_candidate_keys: readonly string[];
  readonly swap_count: number;
}>;

export type CoverageCardinalityExactReceipt = Readonly<{
  readonly objective: CoverageSelectionObjectiveReceipt;
  readonly status: "exact" | "time_limit";
  readonly selected_candidate_keys: readonly string[];
  readonly lower_bound: number;
  readonly upper_bound: number;
  readonly absolute_gap: number;
  readonly nodes_expanded: number;
}>;

type SolverCandidate<T> = CoverageSelectionCandidateState<T>;
type SolverNode<T, State> = Readonly<{
  readonly nextIndex: number;
  readonly selected: readonly SolverCandidate<T>[];
  readonly state: State;
  readonly score: number;
  readonly upperBound: number;
}>;

type SolverParams<T, State> = Readonly<{
  readonly candidates: readonly SolverCandidate<T>[];
  readonly objective: CoverageSelectionObjective<T, State>;
  readonly supplementaryData?: CoverageSelectionSupplementary;
}>;

export function improveCoverageCardinalityByOneSwap<
  T extends CoverageSelectableCandidate,
  State
>(params: SolverParams<T, State> & Readonly<{
  readonly initial_candidate_keys: readonly string[];
}>): CoverageCardinalityLocalSearchReceipt {
  const byKey = candidateMap(params.candidates);
  let selected: readonly SolverCandidate<T>[] = params.initial_candidate_keys.map(
    (key) => requireCandidate(byKey, key)
  );
  assertUniqueSelection(selected);
  const initialScore = evaluateSelection(selected, params);
  let score = initialScore;
  let swapCount = 0;
  while (true) {
    const improvement = bestOneSwap(params.candidates, selected, score, params);
    if (improvement === null) break;
    selected = improvement.selected;
    score = improvement.score;
    swapCount += 1;
  }
  return Object.freeze({
    objective: materializeCoverageSelectionObjectiveReceipt(params.objective),
    initial_score: initialScore,
    final_score: score,
    selected_candidate_keys: freezeSelectionKeys(selected),
    swap_count: swapCount
  });
}

export function solveCoverageCardinalityExactly<
  T extends CoverageSelectableCandidate,
  State
>(params: SolverParams<T, State> & Readonly<{
  readonly cardinality: number;
  readonly time_limit_ms: number;
  readonly now?: () => number;
}>): CoverageCardinalityExactReceipt {
  assertSolverParams(params);
  if (params.objective.mathematical_class !== "monotone_submodular") {
    throw new Error("coverage exact solver requires a monotone-submodular objective");
  }
  const cloneState = requireStateCloner(params.objective);
  const now = params.now ?? Date.now;
  const deadline = now() + params.time_limit_ms;
  const ordered = orderBySingletonGain(params.candidates, params);
  const root = makeNode(
    ordered, 0, [], params.objective.createState(), 0, params.cardinality, params
  );
  const search = runExactSearch({
    ordered,
    cardinality: params.cardinality,
    params,
    cloneState,
    deadline,
    now,
    root,
    incumbent: greedyLeaf(ordered, params.cardinality, params)
  });
  return exactReceipt(
    search.incumbent,
    search.queue,
    search.nodesExpanded,
    materializeCoverageSelectionObjectiveReceipt(params.objective)
  );
}

function runExactSearch<T extends CoverageSelectableCandidate, State>(input: Readonly<{
  readonly ordered: readonly SolverCandidate<T>[];
  readonly cardinality: number;
  readonly params: SolverParams<T, State>;
  readonly cloneState: (state: State) => State;
  readonly deadline: number;
  readonly now: () => number;
  readonly root: SolverNode<T, State>;
  readonly incumbent: SolverNode<T, State>;
}>): Readonly<{
  readonly incumbent: SolverNode<T, State>;
  readonly queue: MaxBoundQueue<T, State>;
  readonly nodesExpanded: number;
}> {
  const queue = new MaxBoundQueue<T, State>([input.root]);
  let incumbent = input.incumbent;
  let nodesExpanded = 0;
  while (queue.size > 0 && input.now() <= input.deadline) {
    const node = queue.pop()!;
    if (node.upperBound <= incumbent.score + SCORE_EPSILON) continue;
    nodesExpanded += 1;
    if (node.selected.length === input.cardinality) {
      incumbent = betterLeaf(node, incumbent);
      continue;
    }
    if (input.ordered.length - node.nextIndex <
        input.cardinality - node.selected.length) continue;
    enqueueBranches(queue, node, incumbent, input);
  }
  return Object.freeze({ incumbent, queue, nodesExpanded });
}

function enqueueBranches<T extends CoverageSelectableCandidate, State>(
  queue: MaxBoundQueue<T, State>,
  node: SolverNode<T, State>,
  incumbent: SolverNode<T, State>,
  input: Readonly<{
    ordered: readonly SolverCandidate<T>[];
    cardinality: number;
    params: SolverParams<T, State>;
    cloneState: (state: State) => State;
  }>
): void {
  const candidate = input.ordered[node.nextIndex]!;
  const includedState = input.cloneState(node.state);
  const gain = marginalGain(candidate, includedState, input.params);
  accept(candidate, includedState, input.params);
  for (const child of [
    makeNode(input.ordered, node.nextIndex + 1, [...node.selected, candidate],
      includedState, node.score + gain, input.cardinality, input.params),
    makeNode(input.ordered, node.nextIndex + 1, node.selected,
      node.state, node.score, input.cardinality, input.params)
  ]) {
    if (child.upperBound > incumbent.score + SCORE_EPSILON) queue.push(child);
  }
}

function exactReceipt<T extends CoverageSelectableCandidate, State>(
  best: SolverNode<T, State>,
  queue: MaxBoundQueue<T, State>,
  nodesExpanded: number,
  objective: CoverageSelectionObjectiveReceipt
): CoverageCardinalityExactReceipt {
  const upperBound = queue.size === 0
    ? best.score
    : Math.max(best.score, queue.peek()!.upperBound);
  const absoluteGap = Math.max(0, upperBound - best.score);
  return Object.freeze({
    objective,
    status: absoluteGap <= SCORE_EPSILON ? "exact" : "time_limit",
    selected_candidate_keys: freezeSelectionKeys(best.selected),
    lower_bound: best.score,
    upper_bound: upperBound,
    absolute_gap: absoluteGap,
    nodes_expanded: nodesExpanded
  });
}

function greedyLeaf<T extends CoverageSelectableCandidate, State>(
  candidates: readonly SolverCandidate<T>[],
  cardinality: number,
  params: SolverParams<T, State>
): SolverNode<T, State> {
  const selected = orderCoverageSelectionCandidateStatesByMarginalGain({
    candidates,
    objective: params.objective,
    supplementaryData: params.supplementaryData ?? { evidenceGistsByMemoryId: {} }
  }).slice(0, cardinality);
  const state = params.objective.createState();
  let score = 0;
  for (const candidate of selected) {
    score += marginalGain(candidate, state, params);
    accept(candidate, state, params);
  }
  return Object.freeze({
    nextIndex: candidates.length,
    selected: Object.freeze(selected),
    state,
    score,
    upperBound: score
  });
}

function bestOneSwap<T extends CoverageSelectableCandidate, State>(
  candidates: readonly SolverCandidate<T>[],
  selected: readonly SolverCandidate<T>[],
  currentScore: number,
  params: SolverParams<T, State>
): Readonly<{ readonly selected: readonly SolverCandidate<T>[]; readonly score: number }> | null {
  const selectedKeys = new Set(selected.map(candidateKey));
  let best: Readonly<{ selected: readonly SolverCandidate<T>[]; score: number }> | null = null;
  for (let remove = 0; remove < selected.length; remove += 1) {
    for (const addition of candidates) {
      if (selectedKeys.has(candidateKey(addition))) continue;
      const proposal = selected.map((value, index) => index === remove ? addition : value);
      const score = evaluateSelection(proposal, params);
      if (score <= currentScore + SCORE_EPSILON) continue;
      if (best === null || score > best.score + SCORE_EPSILON ||
          (Math.abs(score - best.score) <= SCORE_EPSILON &&
            compareSelection(proposal, best.selected) < 0)) {
        best = Object.freeze({ selected: Object.freeze(proposal), score });
      }
    }
  }
  return best;
}

function evaluateSelection<T extends CoverageSelectableCandidate, State>(
  selected: readonly SolverCandidate<T>[],
  params: SolverParams<T, State>
): number {
  return evaluateCoverageSelectionCandidateStates({
    candidates: selected,
    objective: params.objective,
    supplementaryData: params.supplementaryData ?? { evidenceGistsByMemoryId: {} }
  }).score;
}

function makeNode<T extends CoverageSelectableCandidate, State>(
  ordered: readonly SolverCandidate<T>[],
  nextIndex: number,
  selected: readonly SolverCandidate<T>[],
  state: State,
  score: number,
  cardinality: number,
  params: SolverParams<T, State>
): SolverNode<T, State> {
  const slots = cardinality - selected.length;
  const gains = ordered.slice(nextIndex).map((candidate) =>
    marginalGain(candidate, state, params)
  ).sort((left, right) => right - left);
  const upperBound = score + gains.slice(0, slots).reduce((sum, gain) => sum + gain, 0);
  return Object.freeze({ nextIndex, selected: Object.freeze(selected), state, score, upperBound });
}

function orderBySingletonGain<T extends CoverageSelectableCandidate, State>(
  candidates: readonly SolverCandidate<T>[],
  params: SolverParams<T, State>
): readonly SolverCandidate<T>[] {
  return Object.freeze([...candidates].sort((left, right) => {
    const leftGain = marginalGain(left, params.objective.createState(), params);
    const rightGain = marginalGain(right, params.objective.createState(), params);
    return rightGain - leftGain || compareCandidates(left, right);
  }));
}

function marginalGain<T extends CoverageSelectableCandidate, State>(
  value: SolverCandidate<T>,
  state: State,
  params: SolverParams<T, State>
): number {
  const gain = params.objective.marginalGain(objectiveParams(value, state, params));
  if (!Number.isFinite(gain) || gain < 0) {
    throw new Error("coverage cardinality solver requires finite non-negative marginal gain");
  }
  return gain;
}

function accept<T extends CoverageSelectableCandidate, State>(
  value: SolverCandidate<T>,
  state: State,
  params: SolverParams<T, State>
): void {
  params.objective.accept(objectiveParams(value, state, params));
}

function objectiveParams<T extends CoverageSelectableCandidate, State>(
  value: SolverCandidate<T>,
  state: State,
  params: SolverParams<T, State>
) {
  return {
    candidate: value.candidate,
    identity: value.identity,
    relevance: value.relevance,
    coverage: value.coverage,
    state,
    supplementaryData: params.supplementaryData ?? { evidenceGistsByMemoryId: {} }
  } as const;
}

function assertSolverParams<T extends CoverageSelectableCandidate, State>(
  params: SolverParams<T, State> & Readonly<{ cardinality: number; time_limit_ms: number }>
): void {
  candidateMap(params.candidates);
  if (!Number.isSafeInteger(params.cardinality) || params.cardinality < 0 ||
      params.cardinality > params.candidates.length) {
    throw new Error("coverage cardinality must be a feasible non-negative integer");
  }
  if (!Number.isFinite(params.time_limit_ms) || params.time_limit_ms < 0) {
    throw new Error("coverage exact solver time limit must be finite and non-negative");
  }
}

function requireStateCloner<T extends CoverageSelectableCandidate, State>(
  objective: CoverageSelectionObjective<T, State>
): (state: State) => State {
  if (objective.cloneState === undefined) {
    throw new Error("coverage exact solver requires an objective state cloner");
  }
  return objective.cloneState;
}

function candidateMap<T extends CoverageSelectableCandidate>(
  values: readonly SolverCandidate<T>[]
): ReadonlyMap<string, SolverCandidate<T>> {
  const output = new Map(values.map((value) => [candidateKey(value), value]));
  if (output.size !== values.length) throw new Error("coverage solver candidate keys must be unique");
  return output;
}

function requireCandidate<T extends CoverageSelectableCandidate>(
  values: ReadonlyMap<string, SolverCandidate<T>>,
  key: string
): SolverCandidate<T> {
  const value = values.get(key);
  if (value === undefined) throw new Error("coverage local-search selection is not a candidate");
  return value;
}

function assertUniqueSelection<T extends CoverageSelectableCandidate>(
  values: readonly SolverCandidate<T>[]
): void {
  if (new Set(values.map(candidateKey)).size !== values.length) {
    throw new Error("coverage local-search selection must be unique");
  }
}

function betterLeaf<T extends CoverageSelectableCandidate, State>(
  candidate: SolverNode<T, State>,
  incumbent: SolverNode<T, State>
): SolverNode<T, State> {
  if (candidate.score > incumbent.score + SCORE_EPSILON) return candidate;
  if (Math.abs(candidate.score - incumbent.score) <= SCORE_EPSILON &&
      compareSelection(candidate.selected, incumbent.selected) < 0) return candidate;
  return incumbent;
}

function freezeSelectionKeys<T extends CoverageSelectableCandidate>(
  values: readonly SolverCandidate<T>[]
): readonly string[] {
  return Object.freeze(values.map(candidateKey).sort(compareText));
}

function compareSelection<T extends CoverageSelectableCandidate>(
  left: readonly SolverCandidate<T>[],
  right: readonly SolverCandidate<T>[]
): number {
  return compareText(
    JSON.stringify(left.map(candidateKey).sort(compareText)),
    JSON.stringify(right.map(candidateKey).sort(compareText))
  );
}

function compareCandidates<T extends CoverageSelectableCandidate>(
  left: SolverCandidate<T>,
  right: SolverCandidate<T>
): number {
  return compareText(candidateKey(left), candidateKey(right));
}

function candidateKey<T extends CoverageSelectableCandidate>(
  value: SolverCandidate<T>
): string {
  return value.candidate.fusion.candidate_key;
}


class MaxBoundQueue<T, State> {
  readonly #values: SolverNode<T, State>[];

  constructor(values: readonly SolverNode<T, State>[]) {
    this.#values = [...values];
  }

  get size(): number {
    return this.#values.length;
  }

  peek(): SolverNode<T, State> | undefined {
    return this.#values[0];
  }

  push(value: SolverNode<T, State>): void {
    this.#values.push(value);
    let index = this.#values.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compareNodes(this.#values[parent]!, value) >= 0) break;
      this.#values[index] = this.#values[parent]!;
      index = parent;
    }
    this.#values[index] = value;
  }

  pop(): SolverNode<T, State> | undefined {
    const first = this.#values[0];
    const last = this.#values.pop();
    if (first === undefined || last === undefined || this.#values.length === 0) {
      return first;
    }
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      if (left >= this.#values.length) break;
      const right = left + 1;
      const child = right < this.#values.length &&
        compareNodes(this.#values[right]!, this.#values[left]!) > 0 ? right : left;
      if (compareNodes(last, this.#values[child]!) >= 0) break;
      this.#values[index] = this.#values[child]!;
      index = child;
    }
    this.#values[index] = last;
    return first;
  }
}

function compareNodes<T, State>(
  left: SolverNode<T, State>,
  right: SolverNode<T, State>
): number {
  return left.upperBound - right.upperBound || right.nextIndex - left.nextIndex;
}
