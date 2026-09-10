import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  MILLIGRADE_BOTTOM,
  MILLIGRADE_TOP,
  type CoverageRegion,
  type FieldSnapshot,
  type SeedActivation,
  type Transition
} from "@do-soul/alaya-protocol";
import {
  bindMaxMinField,
  productStateNodeId,
  type BindMaxMinInput,
  type BindMaxMinResult,
  type BindMaxMinSuccess
} from "../reference/bind-max-min.js";
import {
  residualGradeUpper,
  residualsInvalidateBounds
} from "../index/completeness.js";
import type { BindableState, RemainingWork } from "./field-engine.js";

type GuaranteedSolve = {
  readonly values: ReadonlyMap<string, number>;
  readonly solver_steps: number;
  readonly solver_runs: number;
  readonly solver_complete: boolean;
  readonly remaining_worklist: BindMaxMinSuccess["remaining_worklist"];
};

type DualSolve = {
  readonly possible: BindMaxMinResult;
  readonly guaranteed: GuaranteedSolve;
  readonly exploration: number;
  readonly reserve: number;
  readonly solverRuns: number;
  readonly solverSteps: number;
  readonly complete: boolean;
  readonly possibleComplete: boolean;
  readonly remainingWorklist: BindMaxMinSuccess["remaining_worklist"];
  readonly guaranteedGraphKey: string;
};

export function bindChargedField(
  charged: BindableState,
  remainingWork: RemainingWork[]
): {
  readonly binding: BindMaxMinResult;
  readonly exploration: number;
  readonly reserve: number;
  readonly complete: boolean;
} {
  const solved = solvePossibleAndGuaranteed(charged, remainingWork);
  return {
    binding: annotateBounds(solved, charged.residuals),
    exploration: solved.exploration,
    reserve: solved.reserve,
    complete: solved.complete
  };
}

function solvePossibleAndGuaranteed(
  charged: BindableState,
  remainingWork: RemainingWork[]
): DualSolve {
  const prior = charged.proven_binding?.kind === "bound" ? charged.proven_binding : undefined;
  const samePossible = prior !== undefined && samePossibleGraph(prior, charged);
  const guaranteedGraphKey = fieldGraphKey(charged.guaranteed_seeds, charged.guaranteed_transitions);
  const sameGuaranteed = prior !== undefined && prior.guaranteed_graph_key === guaranteedGraphKey;
  const possibleDone = prior?.possible_complete === true;
  const guaranteedDone = prior?.guaranteed_complete === true;
  if (samePossible && sameGuaranteed && possibleDone && guaranteedDone && prior !== undefined) {
    return reuseComplete(prior, charged, guaranteedGraphKey);
  }
  const possibleRun = runPossible(charged, prior, samePossible, possibleDone, remainingWork);
  const possibleComplete = isPossibleComplete(possibleRun.binding);
  const guaranteedRun = possibleComplete
    ? runGuaranteed(charged, storedGuaranteed(prior), sameGuaranteed, guaranteedDone, possibleRun.exploration, possibleRun.reserve, remainingWork)
    : {
      guaranteed: storedGuaranteed(prior),
      exploration: possibleRun.exploration,
      reserve: possibleRun.reserve,
      runs: 0,
      steps: 0
    };
  const remainingWorklist = possibleRun.binding.kind === "bound" && !possibleComplete
    ? possibleRun.binding.remaining_worklist
    : guaranteedRun.guaranteed.remaining_worklist;
  const complete = possibleComplete && guaranteedRun.guaranteed.solver_complete;
  if (!complete && !remainingWork.some((row) => row.kind === "relaxation")) {
    remainingWork.push({ kind: "relaxation", units: Math.max(remainingWorklist.length, 1) });
  }
  return {
    possible: possibleRun.binding,
    guaranteed: guaranteedRun.guaranteed,
    exploration: guaranteedRun.exploration,
    reserve: guaranteedRun.reserve,
    solverRuns: possibleRun.runs + guaranteedRun.runs,
    solverSteps: possibleRun.steps + guaranteedRun.steps,
    complete,
    possibleComplete,
    remainingWorklist,
    guaranteedGraphKey
  };
}

function runPossible(
  charged: BindableState,
  prior: BindMaxMinSuccess | undefined,
  sameGraph: boolean,
  done: boolean,
  remainingWork: RemainingWork[]
): { binding: BindMaxMinResult; exploration: number; reserve: number; runs: number; steps: number } {
  if (sameGraph && done && prior !== undefined) {
    return {
      binding: reusePossible(prior),
      exploration: charged.remaining_exploration,
      reserve: charged.remaining_reserve,
      runs: 0,
      steps: 0
    };
  }
  const resume = sameGraph && prior !== undefined && !done ? prior.remaining_worklist : undefined;
  const run = runSolverBinding({
    query_id: charged.query_id,
    snapshot_id: charged.snapshot_id,
    seeds: charged.seeds,
    transitions: charged.transitions,
    budget: charged.budget,
    facets: charged.facets,
    // Cap/permission revisions are nonmonotone; prior values would pin stale support.
    ...(prior === undefined || !sameGraph ? {} : { prior_values: prior.values }),
    ...(resume === undefined || resume.length === 0 ? {} : { worklist: resume })
  }, charged.remaining_exploration, charged.remaining_reserve, remainingWork);
  const binding = run.binding ?? prior ?? emptyBoundSnapshot(charged);
  return {
    binding,
    exploration: run.exploration,
    reserve: run.reserve,
    runs: binding.kind === "bound" ? binding.solver_runs : 0,
    steps: binding.kind === "bound" ? binding.solver_steps : 0
  };
}

function runGuaranteed(
  charged: BindableState,
  prior: GuaranteedSolve,
  sameGraph: boolean,
  done: boolean,
  exploration: number,
  reserve: number,
  remainingWork: RemainingWork[]
): { guaranteed: GuaranteedSolve; exploration: number; reserve: number; runs: number; steps: number } {
  if (sameGraph && done) {
    return { guaranteed: prior, exploration, reserve, runs: 0, steps: 0 };
  }
  const resume = sameGraph && !done ? prior.remaining_worklist : undefined;
  const run = runSolverBinding({
    query_id: charged.query_id,
    snapshot_id: charged.snapshot_id,
    seeds: charged.guaranteed_seeds,
    transitions: charged.guaranteed_transitions,
    budget: charged.budget,
    ...(prior.values.size === 0 || !sameGraph ? {} : { prior_values: prior.values }),
    ...(resume === undefined || resume.length === 0 ? {} : { worklist: resume })
  }, exploration, reserve, remainingWork);
  if (run.binding?.kind !== "bound") {
    return { guaranteed: prior, exploration: run.exploration, reserve: run.reserve, runs: 0, steps: 0 };
  }
  return {
    guaranteed: {
      values: run.binding.values,
      solver_steps: run.binding.solver_steps,
      solver_runs: run.binding.solver_runs,
      solver_complete: run.binding.solver_complete,
      remaining_worklist: run.binding.remaining_worklist
    },
    exploration: run.exploration,
    reserve: run.reserve,
    runs: run.binding.solver_runs,
    steps: run.binding.solver_steps
  };
}

function runSolverBinding(
  input: BindMaxMinInput,
  exploration: number,
  reserve: number,
  remainingWork: RemainingWork[]
): { binding: BindMaxMinResult | undefined; exploration: number; reserve: number } {
  const available = exploration + reserve;
  if (available < 1) {
    remainingWork.push({ kind: "relaxation", units: 1 });
    return { binding: undefined, exploration, reserve };
  }
  const binding = bindMaxMinField({ ...input, work_limit: available });
  const units = binding.kind === "bound" ? Math.max(binding.solver_steps, 1) : 1;
  const paid = payWork(exploration, reserve, remainingWork, units, "relaxation");
  return { binding, exploration: paid.exploration, reserve: paid.reserve };
}

function reuseComplete(
  prior: BindMaxMinSuccess,
  charged: BindableState,
  guaranteedGraphKey: string
): DualSolve {
  return {
    possible: prior,
    guaranteed: storedGuaranteed(prior),
    exploration: charged.remaining_exploration,
    reserve: charged.remaining_reserve,
    solverRuns: 0,
    solverSteps: 0,
    complete: true,
    possibleComplete: true,
    remainingWorklist: prior.remaining_worklist,
    guaranteedGraphKey
  };
}

function reusePossible(prior: BindMaxMinSuccess): BindMaxMinSuccess {
  return {
    kind: "bound",
    values: prior.values,
    snapshot: prior.snapshot,
    solver_steps: 0,
    solver_runs: 0,
    solver_complete: true,
    remaining_worklist: [],
    possible_complete: true
  };
}

function storedGuaranteed(prior: BindMaxMinSuccess | undefined): GuaranteedSolve {
  if (prior === undefined) {
    return { values: new Map(), solver_steps: 0, solver_runs: 0, solver_complete: false, remaining_worklist: [] };
  }
  if (prior.guaranteed_values !== undefined) {
    return {
      values: prior.guaranteed_values,
      solver_steps: 0,
      solver_runs: 0,
      solver_complete: prior.guaranteed_complete === true,
      remaining_worklist: prior.guaranteed_worklist ?? []
    };
  }
  return { values: new Map(), solver_steps: 0, solver_runs: 0, solver_complete: false, remaining_worklist: [] };
}

function isPossibleComplete(binding: BindMaxMinResult): boolean {
  if (binding.kind !== "bound") return false;
  return binding.possible_complete ?? binding.solver_complete;
}

function samePossibleGraph(prior: BindMaxMinSuccess, charged: BindableState): boolean {
  return fieldGraphKey(prior.snapshot.seeds, prior.snapshot.retained_transitions)
    === fieldGraphKey(charged.seeds, charged.transitions.filter((row) => row.applicable));
}

function fieldGraphKey(seeds: readonly SeedActivation[], transitions: readonly Transition[]): string {
  return [
    ...seeds.map((row) => `s:${productStateNodeId(row.state)}:${row.milligrades}`),
    ...transitions.map((row) =>
      `e:${productStateNodeId(row.from)}:${productStateNodeId(row.to)}:${row.relation_kind}:${row.strength_milligrades}:${row.applicable}`)
  ].sort().join("\n");
}

function payWork(
  exploration: number,
  reserve: number,
  remainingWork: RemainingWork[],
  units: number,
  kind: RemainingWork["kind"]
): { exploration: number; reserve: number; paid: number } {
  let remainingExploration = exploration;
  let remainingReserve = reserve;
  let paid = 0;
  while (paid < units) {
    if (remainingExploration >= 1) {
      remainingExploration -= 1;
      paid += 1;
      continue;
    }
    if (remainingReserve >= 1) {
      remainingReserve -= 1;
      paid += 1;
      continue;
    }
    remainingWork.push({ kind, units: units - paid });
    break;
  }
  return { exploration: remainingExploration, reserve: remainingReserve, paid };
}

function emptyBoundSnapshot(state: BindableState): BindMaxMinResult {
  const snapshot: FieldSnapshot = {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    snapshot_id: state.snapshot_id,
    query_id: state.query_id,
    seeds: state.seeds,
    values: [],
    retained_transitions: state.transitions,
    facets: state.facets
  };
  return {
    kind: "bound",
    values: new Map(),
    snapshot,
    solver_steps: 0,
    solver_runs: 0,
    solver_complete: false,
    remaining_worklist: []
  };
}

function annotateBounds(solved: DualSolve, residuals: readonly CoverageRegion[]): BindMaxMinResult {
  const binding = solved.possible;
  if (binding.kind !== "bound") return binding;
  const residualHigh = residualGradeUpper(residuals);
  const invalidated = residualsInvalidateBounds(residuals);
  const values = binding.snapshot.values.map((value) => {
    if (value.activation?.kind === "unreachable") return value;
    const admitted = solved.guaranteed.values.get(productStateNodeId(value.state));
    const low = invalidated ? MILLIGRADE_BOTTOM : (admitted ?? MILLIGRADE_BOTTOM);
    const high = invalidated
      ? MILLIGRADE_TOP
      : residualHigh === undefined
        ? (value.milligrades ?? MILLIGRADE_BOTTOM)
        : Math.max(value.milligrades ?? MILLIGRADE_BOTTOM, residualHigh);
    return { ...value, low_milligrades: low, high_milligrades: high };
  });
  return {
    kind: "bound",
    values: binding.values,
    solver_steps: solved.solverSteps,
    solver_runs: solved.solverRuns,
    solver_complete: solved.complete,
    remaining_worklist: solved.remainingWorklist,
    possible_complete: solved.possibleComplete,
    guaranteed_complete: solved.guaranteed.solver_complete,
    guaranteed_values: solved.guaranteed.values,
    guaranteed_worklist: solved.guaranteed.remaining_worklist,
    guaranteed_graph_key: solved.guaranteedGraphKey,
    snapshot: { ...binding.snapshot, values }
  };
}
