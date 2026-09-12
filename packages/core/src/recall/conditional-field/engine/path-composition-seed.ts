import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  MILLIGRADE_BOTTOM,
  MILLIGRADE_TOP,
  memoryProductStateKey,
  sourceProductStateKey,
  type ProductStateKey,
  type QueryInterpretation,
  type QueryProgram,
  type SeedActivation,
  type Transition,
  type TypedObservation
} from "@do-soul/alaya-protocol";
import {
  identitySeedGrade,
  isHardIdentityContractId
} from "../cap-contract.js";
import { compareText } from "../../../shared/compare-text.js";
import { interpretQuery } from "../reference/interpret-query.js";
import { productStateNodeId } from "../reference/bind-max-min.js";
import {
  UNBOUND_BINDING,
  seedBindingContext,
  type BindingContextStore
} from "./binding-environment.js";
import {
  ACCEPTING_PROGRAM_STATE,
  compileProgramAutomaton
} from "./program-automaton.js";

const DEFAULT_PROGRAM_STATE = ACCEPTING_PROGRAM_STATE;
const DEFAULT_HYPOTHESIS = "h0";
const DEFAULT_TIME_STATE = "as_of";

export function serialMin(grades: readonly number[]): number {
  if (grades.length === 0) return MILLIGRADE_BOTTOM;
  let grade = MILLIGRADE_TOP;
  for (const value of grades) {
    if (value < grade) grade = value;
  }
  return grade;
}

export function alternativeMax(grades: readonly number[]): number {
  if (grades.length === 0) return MILLIGRADE_BOTTOM;
  let grade = MILLIGRADE_BOTTOM;
  for (const value of grades) {
    if (value > grade) grade = value;
  }
  return grade;
}

export function productStateFromObservation(
  observation: TypedObservation,
  defaults: Partial<Omit<ProductStateKey, "schema_version" | "target">> & {
    readonly workspace_id?: string;
    readonly object_id?: string;
    readonly source_revision?: string;
  } = {}
): ProductStateKey {
  const workspaceId = defaults.workspace_id ?? observation.workspace_id;
  if (workspaceId === undefined) {
    throw new Error("product state requires workspace_id");
  }
  const programState = defaults.program_state ?? DEFAULT_PROGRAM_STATE;
  const hypothesisId = defaults.hypothesis_id ?? DEFAULT_HYPOTHESIS;
  const bindingContext = defaults.binding_context ?? UNBOUND_BINDING;
  const timeState = defaults.time_state ?? DEFAULT_TIME_STATE;
  const target = observation.target;
  if (target !== undefined && target.kind === "source_evidence") {
    return sourceProductStateKey({
      workspace_id: workspaceId,
      root_kind: target.root_kind,
      root_id: target.root_id,
      source_version: defaults.source_revision ?? target.source_version,
      content_digest: target.content_digest,
      evidence_object_id: target.evidence_object_id,
      program_state: programState,
      hypothesis_id: hypothesisId,
      binding_context: bindingContext,
      time_state: timeState
    });
  }
  return memoryProductStateKey({
    workspace_id: workspaceId,
    object_id: defaults.object_id ?? observation.object_id,
    source_revision: defaults.source_revision ?? observation.source_revision,
    program_state: programState,
    hypothesis_id: hypothesisId,
    binding_context: bindingContext,
    time_state: timeState
  });
}

export function observationIsGuaranteed(observation: TypedObservation): boolean {
  return observation.applicability.verdict === "true";
}

export function queryAdmitsGuaranteedSeed(interpretation: QueryInterpretation): boolean {
  return runtimeProgram(interpretation.program) !== "empty";
}

export function seedFromObservation(
  observation: TypedObservation,
  state: ProductStateKey
): SeedActivation | undefined {
  if (observation.applicability.verdict !== "true") return undefined;
  if (observation.association_milligrades === undefined) return undefined;
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    state,
    milligrades: observation.association_milligrades
  };
}

export function timeStateFor(
  interpretation: QueryInterpretation,
  asOf: string
): string {
  if (interpretation.time_window !== undefined) return interpretation.time_window.end;
  if (interpretation.interpretation_clock !== undefined) return interpretation.interpretation_clock;
  return asOf.length > 0 ? asOf : DEFAULT_TIME_STATE;
}

export function hypothesisIdsFor(interpretation: QueryInterpretation): readonly string[] {
  if (interpretation.hypotheses.length === 0) return [DEFAULT_HYPOTHESIS];
  return interpretation.hypotheses.map((row) => row.hypothesis_id);
}

export function runtimeProgram(program: QueryProgram): QueryProgram | "empty" | "epsilon" {
  const interpreted = interpretQuery(program);
  if (interpreted.kind === "empty") return "empty";
  if (interpreted.kind === "epsilon") return "epsilon";
  if (interpreted.kind === "unsupported") return "empty";
  return program;
}

export function seedProgramStates(program: QueryProgram): readonly string[] {
  const runtime = runtimeProgram(program);
  if (runtime === "empty") return [];
  if (runtime === "epsilon") return [ACCEPTING_PROGRAM_STATE];
  return compileProgramAutomaton(runtime).start;
}

export function seedActivationsForObservation(
  observation: TypedObservation,
  interpretation: QueryInterpretation,
  asOf: string,
  bindingContexts?: BindingContextStore
): readonly SeedActivation[] {
  if (observation.applicability.verdict !== "true") return [];
  if (!queryAdmitsGuaranteedSeed(interpretation)) return [];
  const runtime = runtimeProgram(interpretation.program);
  const automaton = runtime === "empty" || runtime === "epsilon"
    ? undefined
    : compileProgramAutomaton(runtime);
  const states = runtime === "empty"
    ? []
    : runtime === "epsilon"
      ? [ACCEPTING_PROGRAM_STATE]
      : automaton?.start ?? [];
  if (states.length === 0) return [];
  const timeState = timeStateFor(interpretation, asOf);
  const seeds: SeedActivation[] = [];
  for (const programState of states) {
    for (const hypothesis of seedHypotheses(interpretation)) {
      const binding = seedBindingContext(
        automaton,
        observation.object_id,
        hypothesis.bindings,
        programState,
        bindingContexts
      );
      if (binding === undefined) continue;
      const state = productStateFromObservation(observation, {
        program_state: programState,
        hypothesis_id: hypothesis.hypothesis_id,
        binding_context: binding,
        time_state: timeState
      });
      const seed = observation.association_milligrades === undefined
        ? identitySeedGrade(state)
        : seedFromObservation(observation, state);
      if (seed !== undefined) seeds.push(seed);
    }
  }
  return Object.freeze(seeds);
}

export function mergeSeeds(seeds: readonly SeedActivation[]): readonly SeedActivation[] {
  const best = new Map<string, SeedActivation>();
  for (const seed of seeds) {
    const nodeId = productStateNodeId(seed.state);
    const prior = best.get(nodeId);
    if (prior === undefined) {
      best.set(nodeId, seed);
      continue;
    }
    if ((prior.cap_contract_id ?? "") === (seed.cap_contract_id ?? "")) {
      if (seed.milligrades > prior.milligrades) best.set(nodeId, seed);
      continue;
    }
    if (isHardIdentityContractId(prior.cap_contract_id) && !isHardIdentityContractId(seed.cap_contract_id)) {
      best.set(nodeId, seed);
    }
  }
  return Object.freeze(sortSeeds([...best.values()]));
}

export function collectIdentities(
  seeds: readonly SeedActivation[],
  transitions: readonly Transition[],
  prior: readonly ProductStateKey[] = []
): readonly ProductStateKey[] {
  const keys = new Map<string, ProductStateKey>();
  for (const state of prior) keys.set(productStateNodeId(state), state);
  for (const seed of seeds) keys.set(productStateNodeId(seed.state), seed.state);
  for (const transition of transitions) {
    keys.set(productStateNodeId(transition.from), transition.from);
    keys.set(productStateNodeId(transition.to), transition.to);
  }
  return Object.freeze(sortStates([...keys.values()]));
}

function sortSeeds(seeds: readonly SeedActivation[]): SeedActivation[] {
  return [...seeds].sort((left, right) =>
    compareText(productStateNodeId(left.state), productStateNodeId(right.state))
  );
}

function sortStates(states: readonly ProductStateKey[]): ProductStateKey[] {
  return [...states].sort((left, right) =>
    compareText(productStateNodeId(left), productStateNodeId(right))
  );
}

function seedHypotheses(interpretation: QueryInterpretation): readonly {
  readonly hypothesis_id: string;
  readonly bindings: QueryInterpretation["hypotheses"][number]["bindings"] | undefined;
}[] {
  if (interpretation.hypotheses.length === 0) {
    return [{ hypothesis_id: DEFAULT_HYPOTHESIS, bindings: undefined }];
  }
  return interpretation.hypotheses;
}
