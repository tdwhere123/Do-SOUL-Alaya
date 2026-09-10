import { CONDITIONAL_FIELD_SCHEMA_VERSION, MILLIGRADE_BOTTOM, MILLIGRADE_TOP,
  type FieldValue } from "@do-soul/alaya-protocol";
import { bindMaxMinField, productStateNodeId, type BindMaxMinResult, type BindMaxMinSuccess
} from "../reference/bind-max-min.js";
import type { BindableState, FieldEngineState, RemainingWork } from "./field-engine.js";
import type { FieldGraphAdditions } from "./field-graph-preparation.js";
import { residualGradeUpper, residualsInvalidateBounds } from "../index/completeness.js";

const NO_ADDITIONS: FieldGraphAdditions = { seeds: [], transitions: [] };

type SolveBand = Readonly<{ binding: BindMaxMinSuccess; exploration: number; reserve: number; runs: number; steps: number }>;

export function bindChargedField(charged: BindableState, remainingWork: RemainingWork[]): {
  readonly binding: BindMaxMinResult; readonly exploration: number; readonly reserve: number; readonly complete: boolean;
} {
  const prior = charged.proven_binding?.kind === "bound" ? charged.proven_binding : undefined;
  const reusable = prior?.preparation !== undefined && charged.binding_delta?.reset !== true;
  const possible = runBand(charged, reusable ? prior : undefined,
    reusable ? charged.binding_delta?.possible ?? NO_ADDITIONS : { seeds: charged.seeds, transitions: charged.transitions },
    charged.remaining_exploration, charged.remaining_reserve, false);
  const guaranteedPrior = reusable ? priorGuaranteed(prior!) : undefined;
  const guaranteed = runBand(charged, guaranteedPrior,
    reusable ? charged.binding_delta?.guaranteed ?? NO_ADDITIONS
      : { seeds: charged.guaranteed_seeds, transitions: charged.guaranteed_transitions },
    possible.binding.solver_complete ? possible.exploration : 0,
    possible.binding.solver_complete ? possible.reserve : 0, true);
  const complete = possible.binding.solver_complete && guaranteed.binding.solver_complete;
  if (!complete && !remainingWork.some((row) => row.kind === "relaxation")) {
    remainingWork.push({ kind: "relaxation", units: Math.max(1,
      (possible.binding.work_queue?.size ?? 0) + (guaranteed.binding.work_queue?.size ?? 0)) });
  }
  return {
    binding: annotateBounds(charged, possible, guaranteed),
    exploration: possible.binding.solver_complete ? guaranteed.exploration : possible.exploration,
    reserve: possible.binding.solver_complete ? guaranteed.reserve : possible.reserve,
    complete
  };
}

function runBand(state: BindableState, prior: BindMaxMinSuccess | undefined, additions: FieldGraphAdditions,
  exploration: number, reserve: number, guaranteed: boolean): SolveBand {
  if (prior?.solver_complete && additions.seeds.length === 0 && additions.transitions.length === 0) {
    return { binding: prior, exploration, reserve, runs: 0, steps: 0 };
  }
  const limit = exploration + reserve;
  const result = bindMaxMinField({
    query_id: state.query_id, snapshot_id: state.snapshot_id, budget: state.budget,
    seeds: guaranteed ? state.guaranteed_seeds : state.seeds,
    transitions: guaranteed ? state.guaranteed_transitions : state.transitions,
    identities: state.identity_index,
    facets: state.facets,
    prior_values: prior?.values,
    work_limit: limit,
    incremental: { prior: prior?.preparation, additions, queue: prior?.work_queue }
  });
  if (result.kind !== "bound") throw new Error("admitted field budget changed during binding");
  const spent = result.solver_steps;
  const explorationPaid = Math.min(exploration, spent);
  return { binding: result, exploration: exploration - explorationPaid,
    reserve: reserve - (spent - explorationPaid), runs: spent > 0 ? 1 : 0, steps: spent };
}

function priorGuaranteed(prior: BindMaxMinSuccess): BindMaxMinSuccess | undefined {
  if (prior.guaranteed_preparation === undefined) return undefined;
  return { kind: "bound", values: prior.guaranteed_values ?? new Map(),
    preparation: prior.guaranteed_preparation, work_queue: prior.guaranteed_queue,
    solver_steps: 0, solver_runs: 0, solver_complete: prior.guaranteed_complete === true,
    get remaining_worklist() { return [...prior.guaranteed_queue ?? []]; },
    snapshot: prior.snapshot };
}

function annotateBounds(state: BindableState, possible: SolveBand, guaranteed: SolveBand): BindMaxMinSuccess {
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
      get seeds() { return seeds ??= [...state.seeds]; },
      get facets() { return facets ??= [...state.facets]; },
      get retained_transitions() { return retainedTransitions ??= state.transitions.filter((row) => row.applicable); },
      get values() {
        materialized ??= bound.snapshot.values.map((value) => value.activation?.kind === "unreachable" ? value : {
          ...value,
          ...valueBounds(value.milligrades ?? MILLIGRADE_BOTTOM,
            lower.values.get(productStateNodeId(value.state)), residualHigh, invalidated)
        });
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
    const id = productStateNodeId(key);
    const grade = binding.values.get(id);
    return grade === undefined ? { schema_version: 1, state: key, accepting: key.program_state === "accepting", activation: { kind: "unreachable" } }
      : { schema_version: 1, state: key, accepting: key.program_state === "accepting", activation: { kind: "reachable", milligrades: grade },
        milligrades: grade, ...valueBounds(grade, binding.guaranteed_values?.get(id), residualHigh, invalidated) };
  } };
}

function valueBounds(grade: number, admitted: number | undefined, residualHigh: number | undefined,
  invalidated: boolean): Pick<FieldValue, "low_milligrades" | "high_milligrades"> {
  return {
    low_milligrades: invalidated ? MILLIGRADE_BOTTOM : admitted ?? MILLIGRADE_BOTTOM,
    high_milligrades: invalidated ? MILLIGRADE_TOP : residualHigh === undefined ? grade : Math.max(grade, residualHigh)
  };
}
