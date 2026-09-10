import {
  solveMaxMinField,
  type MaxMinTransition,
  type MaxMinWorkItem
} from "@do-soul/alaya-graph-algorithms";
import {
  MILLIGRADE_BOTTOM,
  MILLIGRADE_TOP,
  canonicalProductIdentity,
  type CompletenessReport,
  type DerivationKind,
  type FieldSnapshot,
  type FieldValue,
  type ProductStateKey,
  type RequestBudget,
  type SeedActivation,
  type Transition
} from "@do-soul/alaya-protocol";

export type BindMaxMinSuccess = Readonly<{
  readonly kind: "bound";
  readonly snapshot: FieldSnapshot;
  readonly values: ReadonlyMap<string, number>;
  readonly solver_steps: number;
  readonly solver_runs: number;
  readonly solver_complete: boolean;
  readonly remaining_worklist: readonly MaxMinWorkItem[];
  readonly possible_complete?: boolean;
  readonly guaranteed_complete?: boolean;
  readonly guaranteed_values?: ReadonlyMap<string, number>;
  readonly guaranteed_worklist?: readonly MaxMinWorkItem[];
  readonly guaranteed_graph_key?: string;
}>;

export type BindMaxMinRejection = Readonly<{
  readonly kind: "resource_rejected";
  readonly completeness: CompletenessReport;
}>;

export type BindMaxMinResult = BindMaxMinSuccess | BindMaxMinRejection;

export type BindMaxMinInput = Readonly<{
  readonly query_id: string;
  readonly snapshot_id: string;
  readonly seeds: readonly SeedActivation[];
  readonly transitions: readonly Transition[];
  readonly budget: RequestBudget;
  readonly facets?: FieldSnapshot["facets"];
  readonly prior_values?: ReadonlyMap<string, number>;
  readonly worklist?: readonly MaxMinWorkItem[];
  readonly work_limit?: number;
}>;

export function productStateNodeId(key: ProductStateKey): string {
  return canonicalProductIdentity(key);
}

export function projectLegalDerivationStep(
  kind: DerivationKind,
  childGrades: readonly number[]
): number {
  if (childGrades.length === 0) return MILLIGRADE_BOTTOM;
  if (kind === "leaf") return childGrades[0] ?? MILLIGRADE_BOTTOM;
  if (kind === "or") {
    let grade = MILLIGRADE_BOTTOM;
    for (const value of childGrades) {
      if (value > grade) grade = value;
    }
    return grade;
  }
  let grade = MILLIGRADE_TOP;
  for (const value of childGrades) {
    if (value < grade) grade = value;
  }
  return grade;
}

export function admitRequestBudget(budget: RequestBudget): "admit" | "resource_rejected" {
  if (budget.finalization_reserve > budget.work_units) return "resource_rejected";
  const exploration = budget.work_units - budget.finalization_reserve;
  if (budget.min_envelope > exploration) return "resource_rejected";
  if (budget.min_envelope > budget.memory_bytes) return "resource_rejected";
  return "admit";
}

export function resourceRejectedCompleteness(): CompletenessReport {
  return {
    schema_version: 1,
    logical_index: "resource_rejected",
    observed_coverage: "resource_rejected",
    transport: "resource_rejected",
    payload: "resource_rejected",
    representation: "resource_rejected"
  };
}

export function bindMaxMinField(input: BindMaxMinInput): BindMaxMinResult {
  if (admitRequestBudget(input.budget) === "resource_rejected") {
    return { kind: "resource_rejected", completeness: resourceRejectedCompleteness() };
  }
  const keys = collectKeys(input.seeds, input.transitions);
  const nodeIds = [...keys.keys()];
  const seeds = new Map<string, number>();
  for (const seed of input.seeds) {
    seeds.set(productStateNodeId(seed.state), seed.milligrades);
  }
  const legalTransitions = input.transitions.filter((transition) => transition.applicable);
  const solved = solveMaxMinField({
    nodeIds,
    seeds,
    transitions: legalTransitions.map(toMaxMinTransition),
    bottom: MILLIGRADE_BOTTOM,
    top: MILLIGRADE_TOP,
    ...(input.prior_values === undefined ? {} : { priorValues: input.prior_values }),
    ...(input.worklist === undefined ? {} : { worklist: input.worklist }),
    ...(input.work_limit === undefined ? {} : { workLimit: input.work_limit })
  });
  return {
    kind: "bound",
    values: solved.values,
    solver_steps: solved.steps,
    solver_runs: 1,
    solver_complete: solved.complete,
    remaining_worklist: solved.remainingWorklist,
    snapshot: {
      schema_version: 1,
      snapshot_id: input.snapshot_id,
      query_id: input.query_id,
      seeds: input.seeds,
      values: fieldValues(keys, solved.values),
      retained_transitions: retainedProtocolTransitions(legalTransitions, solved.retainedTransitions),
      facets: input.facets ?? []
    }
  };
}

function collectKeys(
  seeds: readonly SeedActivation[],
  transitions: readonly Transition[]
): Map<string, ProductStateKey> {
  const keys = new Map<string, ProductStateKey>();
  for (const seed of seeds) keys.set(productStateNodeId(seed.state), seed.state);
  for (const transition of transitions) {
    keys.set(productStateNodeId(transition.from), transition.from);
    keys.set(productStateNodeId(transition.to), transition.to);
  }
  return keys;
}

function toMaxMinTransition(transition: Transition): MaxMinTransition {
  return {
    from: productStateNodeId(transition.from),
    to: productStateNodeId(transition.to),
    strength: transition.strength_milligrades
  };
}

function fieldValues(
  keys: ReadonlyMap<string, ProductStateKey>,
  values: ReadonlyMap<string, number>
): readonly FieldValue[] {
  const fields: FieldValue[] = [];
  for (const [nodeId, state] of keys) {
    const milligrades = values.get(nodeId);
    if (milligrades === undefined) {
      fields.push({
        schema_version: 1,
        state,
        accepting: state.program_state === "accepting",
        activation: { kind: "unreachable" }
      });
      continue;
    }
    fields.push({
      schema_version: 1,
      state,
      milligrades,
      accepting: state.program_state === "accepting",
      activation: { kind: "reachable", milligrades }
    });
  }
  return fields;
}

function retainedProtocolTransitions(
  protocolTransitions: readonly Transition[],
  retained: readonly MaxMinTransition[]
): readonly Transition[] {
  const retainedKeys = new Set(
    retained.map((transition) => `${transition.from}\0${transition.to}\0${transition.strength}`)
  );
  return protocolTransitions.filter((transition) => retainedKeys.has(
    `${productStateNodeId(transition.from)}\0${productStateNodeId(transition.to)}\0${transition.strength_milligrades}`
  ));
}
