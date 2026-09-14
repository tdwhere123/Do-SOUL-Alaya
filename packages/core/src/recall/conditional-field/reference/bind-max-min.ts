import {
  solveMaxMinField,
  type MaxMinTransition,
  type MaxMinWorkItem,
  type MaxMinWorkQueue
} from "@do-soul/alaya-graph-algorithms";
import type { PersistentStringMap } from "@do-soul/alaya-graph-algorithms";
import {
  MILLIGRADE_BOTTOM,
  MILLIGRADE_TOP,
  canonicalProductIdentity,
  canonicalIndexEntryIdentity,
  type CompletenessReport,
  type DerivationKind,
  type FieldSnapshot,
  type FieldValue,
  type ProductStateKey,
  type RequestBudget,
  type SeedActivation,
  type Transition
} from "@do-soul/alaya-protocol";
import { appendFieldGraph, fieldGraphComplete, stepFieldGraph,
  type FieldGraphAdditions, type PreparedFieldGraph } from "../engine/field-graph-preparation.js";
import type { RetainedRows } from "../engine/retained-sequence.js";
import { hardIdentityCapContractId, isHardIdentityContractId } from "../cap-contract.js";

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
  readonly preparation?: PreparedFieldGraph;
  readonly guaranteed_preparation?: PreparedFieldGraph;
  readonly work_queue?: MaxMinWorkQueue;
  readonly guaranteed_queue?: MaxMinWorkQueue;
  readonly next_band?: "possible" | "guaranteed";
  readonly cross_contract_conflicts?: Readonly<{ products: PersistentStringMap<boolean>; count: number }>;
}>;

export type BindMaxMinRejection = Readonly<{
  readonly kind: "resource_rejected";
  readonly completeness: CompletenessReport;
}>;

export type BindMaxMinResult = BindMaxMinSuccess | BindMaxMinRejection;

export type BindMaxMinInput = Readonly<{
  readonly query_id: string;
  readonly snapshot_id: string;
  readonly seeds: RetainedRows<SeedActivation>;
  readonly transitions: RetainedRows<Transition>;
  readonly budget: RequestBudget;
  readonly facets?: RetainedRows<FieldSnapshot["facets"][number]>;
  readonly prior_values?: ReadonlyMap<string, number>;
  readonly worklist?: readonly MaxMinWorkItem[];
  readonly work_limit?: number;
  readonly identities?: ReadonlyMap<string, ProductStateKey>;
  readonly incremental?: Readonly<{ prior?: PreparedFieldGraph; additions: FieldGraphAdditions; queue?: MaxMinWorkQueue }>;
}>;

export function productStateNodeId(key: ProductStateKey): string {
  return canonicalProductIdentity(key);
}

export function productIndexOrderKey(state: ProductStateKey): string {
  return canonicalIndexEntryIdentity({ schema_version: 1, target: state.target,
    hypothesis_id: state.hypothesis_id, output_binding: state.binding_context,
    program_state: state.program_state, time_state: state.time_state,
    role: "associated", association_milligrades: 0, claim: "unknown", explanation_ids: [] });
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
  if (input.incremental !== undefined) {
    let prepared = appendFieldGraph(input.incremental.prior, input.incremental.additions,
      { seeds: input.seeds, transitions: input.transitions });
    let steps = 0;
    while (!fieldGraphComplete(prepared) && steps < (input.work_limit ?? Number.MAX_SAFE_INTEGER)) {
      const next = stepFieldGraph(prepared, input.budget.memory_bytes - prepared.retainedBytes);
      if (next === prepared) break;
      prepared = next;
      steps += 1;
    }
    return preparedFieldBinding(input, prepared, steps);
  }
  const contract = uniqueGradeContract(input.seeds, input.transitions);
  if (contract === "mixed") return bindPartitionedMaxMinField(input);
  return bindNumericMaxMinField(input, contract === "" ? undefined : contract);
}

export function preparedFieldBinding(input: BindMaxMinInput, prepared: PreparedFieldGraph, steps: number): BindMaxMinSuccess {
  let snapshotValues: readonly FieldValue[] | undefined;
  return {
    kind: "bound", values: prepared.values, preparation: prepared,
    solver_steps: steps, solver_runs: steps > 0 ? 1 : 0, solver_complete: fieldGraphComplete(prepared),
    work_queue: prepared.queue, get remaining_worklist() { return [...prepared.queue]; },
    snapshot: {
      schema_version: 1, query_id: input.query_id, snapshot_id: input.snapshot_id,
      has_incomparable_activations: prepared.values.conflictCount > 0,
      get seeds() { return [...input.seeds]; },
      get facets() { return [...input.facets ?? []]; },
      get retained_transitions() { return input.transitions.filter((row) => row.applicable); },
      get values() {
        return snapshotValues ??= fieldValues(input.identities ?? prepared.keys, prepared.values, undefined,
          { get: (id: string) => prepared.values.contract(id) }, (id) => prepared.values.conflicted(id));
      }
    }
  };
}

function bindNumericMaxMinField(input: BindMaxMinInput, contractId: string | undefined): BindMaxMinResult {
  const keys = input.identities ?? collectKeys(input.seeds, input.transitions);
  const seeds = new Map(input.seeds.map((seed) => [productStateNodeId(seed.state), seed.milligrades]));
  const legalTransitions = input.transitions.filter((transition) => transition.applicable);
  const solved = solveMaxMinField({
    nodeIds: [...keys.keys()],
    seeds,
    transitions: legalTransitions.map(toMaxMinTransition),
    bottom: MILLIGRADE_BOTTOM,
    top: MILLIGRADE_TOP,
    ...(input.prior_values === undefined ? {} : { priorValues: input.prior_values }),
    ...(input.worklist === undefined ? {} : { worklist: input.worklist }),
    ...(input.work_limit === undefined ? {} : { workLimit: input.work_limit })
  });
  let snapshotSeeds: FieldSnapshot["seeds"] | undefined;
  let snapshotValues: FieldSnapshot["values"] | undefined;
  let snapshotTransitions: FieldSnapshot["retained_transitions"] | undefined;
  let snapshotFacets: FieldSnapshot["facets"] | undefined;
  return {
    kind: "bound",
    values: solved.values,
    solver_steps: solved.steps,
    solver_runs: 1,
    solver_complete: solved.complete,
    get remaining_worklist() { return solved.remainingWorklist; },
    work_queue: solved.workQueue,
    snapshot: {
      schema_version: 1,
      snapshot_id: input.snapshot_id,
      query_id: input.query_id,
      has_incomparable_activations: false,
      get seeds() { return snapshotSeeds ??= [...input.seeds]; },
      get values() { return snapshotValues ??= fieldValues(keys, solved.values, contractId); },
      get retained_transitions() { return snapshotTransitions ??= retainedProtocolTransitions(legalTransitions, solved.retainedTransitions); },
      get facets() { return snapshotFacets ??= [...input.facets ?? []]; }
    }
  };
}

function bindPartitionedMaxMinField(input: BindMaxMinInput): BindMaxMinResult {
  const groups = new Map<string, { seeds: SeedActivation[]; transitions: Transition[] }>();
  for (const seed of input.seeds) {
    const key = normalizeGradeContract(seed.cap_contract_id);
    const group = groups.get(key) ?? { seeds: [], transitions: [] };
    group.seeds.push(seed);
    groups.set(key, group);
  }
  for (const transition of input.transitions) {
    if (!transition.applicable) continue;
    const key = normalizeGradeContract(transition.cap_contract_id);
    const group = groups.get(key) ?? { seeds: [], transitions: [] };
    group.transitions.push(transition);
    groups.set(key, group);
  }
  const parts: BindMaxMinSuccess[] = [];
  const contractByNode = new Map<string, string>();
  const values = new Map<string, number>();
  const conflicts = new Set<string>();
  let steps = 0;
  let complete = true;
  for (const [contract, group] of groups) {
    const bound = bindNumericMaxMinField({
      ...input,
      seeds: group.seeds,
      transitions: group.transitions,
      incremental: undefined,
      identities: collectKeys(group.seeds, group.transitions)
    }, contract === "" ? undefined : contract);
    if (bound.kind !== "bound") return bound;
    parts.push(bound);
    steps += bound.solver_steps;
    complete = complete && bound.solver_complete;
    for (const [nodeId, milligrades] of bound.values) {
      if (conflicts.has(nodeId)) continue;
      const prior = values.get(nodeId);
      const priorContract = contractByNode.get(nodeId);
      if (prior === undefined || priorContract === undefined) {
        values.set(nodeId, milligrades);
        contractByNode.set(nodeId, contract);
        continue;
      }
      if (priorContract === contract) continue;
      const keepIncoming = isHardIdentityContractId(priorContract === "" ? undefined : priorContract)
        && !isHardIdentityContractId(contract === "" ? undefined : contract);
      const keepPrior = isHardIdentityContractId(contract === "" ? undefined : contract)
        && !isHardIdentityContractId(priorContract === "" ? undefined : priorContract);
      if (keepIncoming) {
        values.set(nodeId, milligrades);
        contractByNode.set(nodeId, contract);
      } else if (!keepPrior) {
        values.delete(nodeId);
        contractByNode.delete(nodeId);
        conflicts.add(nodeId);
      }
    }
  }
  const keys = input.identities ?? collectKeys(input.seeds, input.transitions);
  const last = parts.at(-1);
  let snapshotSeeds: FieldSnapshot["seeds"] | undefined;
  let snapshotValues: FieldSnapshot["values"] | undefined;
  let snapshotTransitions: FieldSnapshot["retained_transitions"] | undefined;
  let snapshotFacets: FieldSnapshot["facets"] | undefined;
  return {
    kind: "bound",
    values,
    solver_steps: steps,
    solver_runs: parts.length,
    solver_complete: complete,
    get remaining_worklist() { return last?.remaining_worklist ?? []; },
    work_queue: last?.work_queue,
    snapshot: {
      schema_version: 1,
      snapshot_id: input.snapshot_id,
      query_id: input.query_id,
      has_incomparable_activations: conflicts.size > 0,
      get seeds() { return snapshotSeeds ??= [...input.seeds]; },
      get values() {
        return snapshotValues ??= fieldValues(keys, values, undefined, contractByNode, (id) => conflicts.has(id));
      },
      get retained_transitions() {
        return snapshotTransitions ??= input.transitions.filter((row) => row.applicable);
      },
      get facets() { return snapshotFacets ??= [...input.facets ?? []]; }
    }
  };
}

function uniqueGradeContract(
  seeds: RetainedRows<SeedActivation>,
  transitions: RetainedRows<Transition>
): string | "mixed" {
  const raw = new Set<string>();
  const normalized = new Set<string>();
  const note = (id: string | undefined) => {
    raw.add(id ?? "");
    normalized.add(normalizeGradeContract(id));
  };
  for (const seed of seeds) note(seed.cap_contract_id);
  for (const transition of transitions) {
    if (transition.applicable) note(transition.cap_contract_id);
  }
  if (normalized.size > 1) return "mixed";
  if (raw.size === 1 && raw.has("")) return "";
  return [...normalized][0] ?? "";
}

function normalizeGradeContract(id: string | undefined): string {
  if (id === undefined || id.length === 0) return hardIdentityCapContractId();
  return id;
}

function collectKeys(
  seeds: RetainedRows<SeedActivation>,
  transitions: RetainedRows<Transition>
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
  values: ReadonlyMap<string, number>,
  contractId?: string,
  contractByNode?: Pick<ReadonlyMap<string, string>, "get">,
  incomparable?: (id: string) => boolean
): readonly FieldValue[] {
  const fields: FieldValue[] = [];
  for (const [nodeId, state] of keys) {
    if (incomparable?.(nodeId)) {
      fields.push({ schema_version: 1, state, accepting: state.program_state === "accepting",
        activation: { kind: "incomparable", reason: "cap_contract_conflict" } });
      continue;
    }
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
    const stamped = contractId ?? emptyToUndefined(contractByNode?.get(nodeId));
    fields.push({
      schema_version: 1,
      state,
      milligrades,
      accepting: state.program_state === "accepting",
      activation: {
        kind: "reachable",
        milligrades,
        ...(stamped === undefined ? {} : { cap_contract_id: stamped })
      },
      ...(stamped === undefined ? {} : { cap_contract_id: stamped })
    });
  }
  return fields;
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
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
