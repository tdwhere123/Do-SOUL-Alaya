import {
  solveMaxMinField,
  type MaxMinTransition
} from "@do-soul/alaya-graph-algorithms";
import {
  MILLIGRADE_BOTTOM,
  MILLIGRADE_TOP,
  type CompletenessReport,
  type FieldSnapshot,
  type FieldValue,
  type ProductStateKey,
  type RequestBudget,
  type SeedActivation,
  type Transition
} from "@do-soul/alaya-protocol";
import { stableStringify } from "../../../shared/stable-stringify.js";

export type BindMaxMinSuccess = Readonly<{
  readonly kind: "bound";
  readonly snapshot: FieldSnapshot;
  readonly values: ReadonlyMap<string, number>;
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
}>;

export function productStateNodeId(key: ProductStateKey): string {
  return stableStringify(key);
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
    top: MILLIGRADE_TOP
  });
  return {
    kind: "bound",
    values: solved.values,
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
    const milligrades = values.get(nodeId) ?? MILLIGRADE_BOTTOM;
    fields.push({
      schema_version: 1,
      state,
      milligrades,
      accepting: state.program_state === "accepting"
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
