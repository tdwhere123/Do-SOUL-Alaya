import {
  solveMaxMinField,
  type MaxMinTransition,
  type MaxMinWorkItem,
  type MaxMinWorkQueue
} from "@do-soul/alaya-graph-algorithms";
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
import { prepareFieldGraph, type FieldGraphAdditions, type PreparedFieldGraph } from "../engine/field-graph-preparation.js";
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
  const contract = uniqueGradeContract(input.seeds, input.transitions);
  if (contract === "mixed") return bindPartitionedMaxMinField(input);
  return bindNumericMaxMinField(input, contract === "" ? undefined : contract);
}

function bindNumericMaxMinField(input: BindMaxMinInput, contractId: string | undefined): BindMaxMinResult {
  const prepared = input.incremental === undefined ? undefined : prepareFieldGraph({ prior: input.incremental.prior,
    additions: input.incremental.additions, priorValues: input.prior_values, workQueue: input.incremental.queue,
    workLimit: input.work_limit ?? Number.MAX_SAFE_INTEGER });
  const keys = input.identities ?? prepared?.preparation.keys ?? collectKeys(input.seeds, input.transitions);
  const seeds = prepared?.seedChanges ?? new Map(input.seeds.map((seed) => [productStateNodeId(seed.state), seed.milligrades]));
  const legalTransitions = prepared === undefined ? input.transitions.filter((transition) => transition.applicable) : undefined;
  const solved = solveMaxMinField({
    nodeIds: prepared === undefined ? [...keys.keys()] : [],
    seeds,
    transitions: legalTransitions?.map(toMaxMinTransition) ?? [],
    bottom: MILLIGRADE_BOTTOM,
    top: MILLIGRADE_TOP,
    ...(input.prior_values === undefined ? {} : { priorValues: input.prior_values }),
    ...(input.worklist === undefined ? {} : { worklist: input.worklist }),
    ...(input.work_limit === undefined ? {} : { workLimit: Math.max(0, input.work_limit - (prepared?.steps ?? 0)) }),
    ...(prepared === undefined ? {} : { preparedGraph: prepared.preparation.graph, workQueue: prepared.queue })
  });
  let snapshotSeeds: FieldSnapshot["seeds"] | undefined;
  let snapshotValues: FieldSnapshot["values"] | undefined;
  let snapshotTransitions: FieldSnapshot["retained_transitions"] | undefined;
  let snapshotFacets: FieldSnapshot["facets"] | undefined;
  return {
    kind: "bound",
    values: solved.values,
    solver_steps: solved.steps + (prepared?.steps ?? 0),
    solver_runs: 1,
    solver_complete: solved.complete && (prepared?.complete ?? true),
    get remaining_worklist() { return solved.remainingWorklist; },
    work_queue: solved.workQueue,
    preparation: prepared?.preparation,
    snapshot: {
      schema_version: 1,
      snapshot_id: input.snapshot_id,
      query_id: input.query_id,
      get seeds() { return snapshotSeeds ??= [...input.seeds]; },
      get values() { return snapshotValues ??= fieldValues(keys, solved.values, contractId); },
      get retained_transitions() { return snapshotTransitions ??= prepared === undefined
        ? retainedProtocolTransitions(legalTransitions!, solved.retainedTransitions) : input.transitions.filter((row) => row.applicable); },
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
      get seeds() { return snapshotSeeds ??= [...input.seeds]; },
      get values() {
        return snapshotValues ??= fieldValues(keys, values, undefined, contractByNode);
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
  contractByNode?: ReadonlyMap<string, string>
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
