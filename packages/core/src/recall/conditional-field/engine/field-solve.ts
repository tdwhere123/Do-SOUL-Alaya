import { CONDITIONAL_FIELD_SCHEMA_VERSION, MILLIGRADE_TOP,
  type FieldValue } from "@do-soul/alaya-protocol";
import { preparedFieldBinding, productStateNodeId, type BindMaxMinResult, type BindMaxMinSuccess
} from "../reference/bind-max-min.js";
import type { BindableState, FieldEngineState, RemainingWork } from "./field-engine.js";
import { appendFieldGraph, fieldGraphComplete, nextFieldGraphAtom, stepFieldGraph, type FieldGraphAdditions } from "./field-graph-preparation.js";
import { residualGradeUpper, residualsInvalidateBounds } from "../index/completeness.js";
import { fieldPartitionNodeId, hardIdentityCapContractId, joinContractSummaries, selectedCapCoordinate } from "../cap-contract.js";
import { PersistentStringMap } from "@do-soul/alaya-graph-algorithms";

const NO_ADDITIONS: FieldGraphAdditions = { seeds: [], transitions: [] };

type SolveBand = Readonly<{ binding: BindMaxMinSuccess; runs: number; steps: number }>;

export function bindChargedField(charged: BindableState, remainingWork: RemainingWork[]): {
  readonly binding: BindMaxMinResult; readonly exploration: number; readonly reserve: number; readonly complete: boolean;
  readonly remaining_memory_bytes: number; readonly solver_retained_bytes: number; readonly memory_exhausted: boolean;
} {
  const prior = charged.proven_binding?.kind === "bound" ? charged.proven_binding : undefined;
  const reusable = prior?.preparation !== undefined && charged.binding_delta?.reset !== true;
  let possibleGraph = appendFieldGraph(reusable ? prior.preparation : undefined,
    reusable ? charged.binding_delta?.possible ?? NO_ADDITIONS : { seeds: charged.seeds, transitions: charged.transitions },
    { seeds: charged.seeds, transitions: charged.transitions });
  let guaranteedGraph = appendFieldGraph(reusable ? prior.guaranteed_preparation : undefined,
    reusable ? charged.binding_delta?.guaranteed ?? NO_ADDITIONS : { seeds: charged.guaranteed_seeds, transitions: charged.guaranteed_transitions },
    { seeds: charged.guaranteed_seeds, transitions: charged.guaranteed_transitions });
  let next = reusable ? prior.next_band ?? "possible" : "possible";
  let cross = reusable && possibleGraph.nodes === prior.preparation?.nodes
    && guaranteedGraph.nodes === prior.guaranteed_preparation?.nodes && prior.cross_contract_conflicts !== undefined
    ? prior.cross_contract_conflicts : { products: new PersistentStringMap<boolean>(), count: 0 };
  let possibleSteps = 0;
  let guaranteedSteps = 0;
  let memory = charged.remaining_memory_bytes;
  let retained = charged.solver_retained_bytes ?? 0;
  let possibleBlocked = false;
  let guaranteedBlocked = false;
  const allowance = charged.memory_exhausted ? 0 : charged.remaining_exploration + charged.remaining_reserve;
  while (possibleSteps + guaranteedSteps < allowance && (!fieldGraphComplete(possibleGraph) || !fieldGraphComplete(guaranteedGraph))) {
    const possibleRunnable = !possibleBlocked && !fieldGraphComplete(possibleGraph);
    const guaranteedRunnable = !guaranteedBlocked && !fieldGraphComplete(guaranteedGraph);
    if (!possibleRunnable && !guaranteedRunnable) break;
    const usePossible = !guaranteedRunnable || next === "possible" && possibleRunnable;
    const atom = nextFieldGraphAtom(usePossible ? possibleGraph : guaranteedGraph, cross.products.size);
    if (atom.bytes > memory) {
      if (usePossible) possibleBlocked = true; else guaranteedBlocked = true;
      continue;
    }
    const liveBefore = possibleGraph.retainedBytes + guaranteedGraph.retainedBytes;
    if (usePossible) { possibleGraph = stepFieldGraph(possibleGraph, memory, atom); possibleSteps += 1; next = "guaranteed"; }
    else { guaranteedGraph = stepFieldGraph(guaranteedGraph, memory, atom); guaranteedSteps += 1; next = "possible"; }
    const changed = (usePossible ? possibleGraph : guaranteedGraph).changedProduct;
    if (changed !== undefined) {
      const conflicted = crossContractConflict(possibleGraph.values, guaranteedGraph.values, changed);
      const was = cross.products.get(changed) === true;
      if (conflicted !== was) cross = { products: cross.products.with(changed, conflicted),
        count: cross.count + Number(conflicted) - Number(was) };
    }
    // Continuations already hold prior solver_retained_bytes. This request
    // charges the live graph version, not every intermediate tree copy.
    const liveDelta = Math.max(0, possibleGraph.retainedBytes + guaranteedGraph.retainedBytes - liveBefore);
    memory -= liveDelta;
    retained += liveDelta;
  }
  const possible = bandResult(charged, possibleGraph, possibleSteps, false);
  const guaranteed = bandResult(charged, guaranteedGraph, guaranteedSteps, true);
  const complete = possible.binding.solver_complete && guaranteed.binding.solver_complete;
  if (!complete && !remainingWork.some((row) => row.kind === "relaxation")) {
    remainingWork.push({ kind: "relaxation", units: Math.max(1,
      (possible.binding.work_queue?.size ?? 0) + (guaranteed.binding.work_queue?.size ?? 0)) });
  }
  return {
    binding: annotateBounds(charged, possible, guaranteed, next, cross),
    exploration: Math.max(0, charged.remaining_exploration - possibleSteps - guaranteedSteps),
    reserve: charged.remaining_reserve - Math.max(0, possibleSteps + guaranteedSteps - charged.remaining_exploration),
    complete, remaining_memory_bytes: memory, solver_retained_bytes: retained,
    memory_exhausted: charged.memory_exhausted || possibleBlocked || guaranteedBlocked
  };
}

function bandResult(state: BindableState, preparation: NonNullable<BindMaxMinSuccess["preparation"]>, steps: number,
  guaranteed: boolean): SolveBand {
  const binding = preparedFieldBinding({
    query_id: state.query_id, snapshot_id: state.snapshot_id, budget: state.budget,
    seeds: guaranteed ? state.guaranteed_seeds : state.seeds,
    transitions: guaranteed ? state.guaranteed_transitions : state.transitions,
    identities: state.identity_index,
    facets: state.facets,
  }, preparation, steps);
  return { binding, steps, runs: steps > 0 ? 1 : 0 };
}

function annotateBounds(state: BindableState, possible: SolveBand, guaranteed: SolveBand,
  next: "possible" | "guaranteed", cross: NonNullable<BindMaxMinSuccess["cross_contract_conflicts"]>): BindMaxMinSuccess {
  const bound = possible.binding;
  const lower = guaranteed.binding;
  const residualHigh = residualGradeUpper(state.residuals);
  const invalidated = residualsInvalidateBounds(state.residuals);
  let materialized: readonly FieldValue[] | undefined;
  let retainedTransitions: readonly import("@do-soul/alaya-protocol").Transition[] | undefined;
  let seeds: readonly import("@do-soul/alaya-protocol").SeedActivation[] | undefined;
  let facets: readonly import("@do-soul/alaya-protocol").FacetVector[] | undefined;
  return {
    kind: "bound", values: bound.values,
    next_band: next,
    cross_contract_conflicts: cross,
    solver_steps: possible.steps + guaranteed.steps,
    solver_runs: possible.runs + guaranteed.runs,
    solver_complete: bound.solver_complete && lower.solver_complete,
    possible_complete: bound.solver_complete,
    guaranteed_complete: lower.solver_complete,
    guaranteed_values: lower.values,
    preparation: bound.preparation,
    guaranteed_preparation: lower.preparation,
    work_queue: bound.work_queue,
    guaranteed_queue: lower.work_queue,
    get remaining_worklist() { return bound.solver_complete ? lower.remaining_worklist : bound.remaining_worklist; },
    get guaranteed_worklist() { return lower.remaining_worklist; },
    snapshot: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      query_id: state.query_id,
      snapshot_id: state.snapshot_id,
      has_incomparable_activations: cross.count > 0,
      get seeds() { return seeds ??= [...state.seeds]; },
      get facets() { return facets ??= [...state.facets]; },
      get retained_transitions() { return retainedTransitions ??= state.transitions.filter((row) => row.applicable); },
      get values() {
        if (materialized === undefined) {
          const keys = state.identity_index ?? new Map([...bound.preparation!.keys, ...lower.preparation!.keys]);
          materialized = [...keys.values()].map((key) => projectedValue(key, bound, lower.values,
            lower.preparation, residualHigh, invalidated));
        }
        return materialized;
      }
    }
  };
}

export function orderedProjectionValues(state: FieldEngineState): Readonly<{ size: number; at(index: number): FieldValue | undefined }> | undefined {
  const identities = state.ordered_identities;
  const binding = state.binding;
  if (identities === undefined || binding.kind !== "bound") return undefined;
  const residualHigh = residualGradeUpper(state.residuals);
  const invalidated = residualsInvalidateBounds(state.residuals);
  return { size: identities.size, at(index) {
    const key = identities.entryAt(index)?.[1];
    if (key === undefined) return undefined;
    return projectedValue(key, binding, binding.guaranteed_values, binding.guaranteed_preparation, residualHigh, invalidated);
  } };
}

function projectedValue(key: FieldValue["state"], bound: BindMaxMinSuccess, lower: ReadonlyMap<string, number> | undefined,
  lowerPreparation: BindMaxMinSuccess["preparation"], residualHigh: number | undefined, invalidated: boolean): FieldValue {
  const id = productStateNodeId(key);
  const possible = bound.preparation?.values.summary(id) ?? {};
  const guaranteed = lowerPreparation?.values.summary(id) ?? {};
  const combined = joinContractSummaries(possible, guaranteed);
  const coordinate = selectedCapCoordinate(combined);
  const base = { schema_version: 1 as const, state: key, accepting: key.program_state === "accepting" };
  if (coordinate === undefined && combined.conflict) {
    return { ...base, activation: { kind: "incomparable", reason: "cap_contract_conflict" } };
  }
  const possibleGrade = coordinate === undefined ? bound.values.get(id) : coordinateGrade(bound.preparation, id, coordinate);
  const low = coordinate === undefined ? lower?.get(id) : coordinateGrade(lowerPreparation, id, coordinate);
  const grade = low === undefined ? possibleGrade : Math.max(possibleGrade ?? low, low);
  if (grade === undefined) return { ...base, activation: { kind: "unreachable" } };
  const contract = coordinate === undefined || coordinate.length === 0 ? undefined : coordinate;
  return { ...base, activation: { kind: "reachable", milligrades: grade,
      ...(contract === undefined ? {} : { cap_contract_id: contract }) }, milligrades: grade,
    ...(contract === undefined ? {} : { cap_contract_id: contract }),
    ...valueBounds(grade, low, residualHigh, invalidated, bound.possible_complete ?? bound.solver_complete) };
}

/** Read both bands in the selected coordinate. An independently grounded Hard
 * value can be lifted before its queued numeric copy is prepared; no Soft value
 * can stand in for a missing lower-bound premise in another coordinate. */
function coordinateGrade(preparation: BindMaxMinSuccess["preparation"], id: string, coordinate: string): number | undefined {
  const direct = preparation?.numericValues.get(fieldPartitionNodeId(id, coordinate));
  const hard = preparation?.numericValues.get(fieldPartitionNodeId(id, hardIdentityCapContractId()));
  return hard ?? direct;
}

function crossContractConflict(possible: NonNullable<BindMaxMinSuccess["preparation"]>["values"],
  guaranteed: NonNullable<BindMaxMinSuccess["preparation"]>["values"], id: string): boolean {
  const combined = joinContractSummaries(possible.summary(id), guaranteed.summary(id));
  return combined.conflict === true && selectedCapCoordinate(combined) === undefined;
}

function valueBounds(grade: number, admitted: number | undefined, residualHigh: number | undefined,
  invalidated: boolean, possibleComplete: boolean): Pick<FieldValue, "high_milligrades"> & Partial<Pick<FieldValue, "low_milligrades">> {
  return {
    // Unknown support is lattice bottom (no lower proof), not a reachable zero.
    ...(invalidated || admitted === undefined ? {} : { low_milligrades: admitted }),
    high_milligrades: invalidated || !possibleComplete ? MILLIGRADE_TOP : Math.max(grade, admitted ?? grade, residualHigh ?? grade)
  };
}
