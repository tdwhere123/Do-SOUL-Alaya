import { describe, expect, it } from "vitest";
import { evaluateBooleanHypergraph, type BooleanHyperedge } from "@do-soul/alaya-graph-algorithms";
import type { ObserverPage, ProductStateKey, QueryInterpretation, QueryProgram, Transition } from "@do-soul/alaya-protocol";
import {
  applyObserverPage, createConditionalField, withdrawDerivationLeaves, type FieldEngineState
} from "../../../../recall/conditional-field/engine/field-engine.js";
import { bindEngineState } from "../../../../recall/conditional-field/engine/field-update.js";
import {
  adjacencyEffectsForRows, type CompiledAdjacencyEffect
} from "../../../../recall/conditional-field/engine/path-composition-adjacency.js";
import { encodeBindingContext } from "../../../../recall/conditional-field/engine/binding-environment.js";
import { compileProgramAutomaton } from "../../../../recall/conditional-field/engine/program-automaton.js";
import { seedDerivationIdentity } from "../../../../recall/conditional-field/engine/path-derivation.js";
import { groundedOutputDerivations } from "../../../../recall/conditional-field/engine/output-derivations.js";
import { localLeafIds, traceDerivationForest } from "../../../../recall/conditional-field/engine/derivation-provenance.js";
import { productStateNodeId } from "../../../../recall/conditional-field/reference/bind-max-min.js";
import { defaultBudget, defaultView, productKey, SNAPSHOT_ID } from "../reference/deployment.fixture.js";

const LEAVES = ["a", "b", "c"] as const;
type Leaf = typeof LEAVES[number];
type Grade = 0 | 400 | 700 | 1000;
type Coordinate = "hypothesis_id" | "binding_context" | "time_state";
type Route = Readonly<{ leaves: readonly Leaf[]; grade: Grade; admitted: boolean }>;
type Scenario = Readonly<{
  name: string;
  program: Extract<QueryProgram, { kind: "alternative" }>;
  routes: readonly [Route, Route];
  cycles?: boolean;
  incompatible?: Coordinate;
}>;
const VALIDITY: Transition["validity"] = { kind: "open", valid_from: "2026-01-01T00:00:00.000Z" };
const OUTPUT_BINDING = encodeBindingContext(new Map([["x", "seed"], ["y", "end"]]));
const relation = (relation_kind: string): QueryProgram => ({
  schema_version: 1, kind: "relation", relation_kind, source_variable: "x", target_variable: "y",
  guard: { schema_version: 1, kind: "query_predicate", verdict: "true", time_scope: "none" },
  facet_mode: "same_path", threshold_milligrades: 0
});
const both = (left: string, right: string): QueryProgram => ({
  schema_version: 1, kind: "hyperedge", join: "and", premises: [relation(left), relation(right)]
});
const either = (...options: QueryProgram[]): Scenario["program"] => ({ schema_version: 1, kind: "alternative", options });

// Programs and reference premise sets are separately authored. Relation transfers
// are hard identity; comparable grades belong to the explicit branch seeds.
const SCENARIOS: readonly Scenario[] = [
  { name: "a joint route and a lower independent alternative", program: either(both("a", "b"), relation("c")),
    routes: [{ leaves: ["a", "b"], grade: 700, admitted: true }, { leaves: ["c"], grade: 400, admitted: true }] },
  { name: "two joint alternatives sharing a required leaf", program: either(both("a", "b"), both("a", "c")),
    routes: [{ leaves: ["a", "b"], grade: 1000, admitted: true }, { leaves: ["a", "c"], grade: 700, admitted: true }] },
  { name: "a zero-grade alternative feeding a founded cycle beside an unfounded cycle",
    program: either(both("a", "b"), relation("c")), cycles: true,
    routes: [{ leaves: ["a", "b"], grade: 400, admitted: true }, { leaves: ["c"], grade: 0, admitted: true }] },
  ...(["hypothesis_id", "binding_context", "time_state"] as const).map((incompatible): Scenario => ({
    name: `an incompatible ${incompatible} joint premise beside an independent alternative`,
    program: either(both("a", "b"), relation("c")), incompatible,
    routes: [{ leaves: ["a", "b"], grade: 700, admitted: false }, { leaves: ["c"], grade: 400, admitted: true }]
  }))
];

function fixture(scenario: Scenario) {
  const interpretation: QueryInterpretation = {
    schema_version: 1, query_id: "mixed-support", snapshot_id: SNAPSHOT_ID, status: "resolved",
    interpretation_clock: "2026-09-07T00:00:00.000Z",
    program: scenario.program, view: defaultView(), holes: [], hypotheses: []
  };
  const automaton = compileProgramAutomaton(scenario.program);
  const seeds = scenario.program.options.map((option, index) => {
    const start = option.kind === "hyperedge"
      ? automaton.hyperedgeAdvances.find((advance) => advance.hyperedge === option)?.from
      : automaton.advances.find((advance) => advance.relation === option)?.from;
    expect(start).toBeDefined();
    expect(automaton.start).toContain(start);
    return { schema_version: 1 as const, state: productKey("seed", "h0", "unbound", start!),
      milligrades: scenario.routes[index]!.grade };
  });
  const outputs = new Map(["end", ...(scenario.cycles ? ["cycle", "unfounded-a", "unfounded-b"] : [])]
    .map((id) => [id, productKey(id, "h0", OUTPUT_BINDING)]));
  const fixedPairs = scenario.cycles
    ? [["end", "cycle"], ["cycle", "end"], ["unfounded-a", "unfounded-b"], ["unfounded-b", "unfounded-a"]] as const
    : [];
  const transitions: Transition[] = fixedPairs.map(([from, to]) => ({
    schema_version: 1, from: outputs.get(from)!, to: outputs.get(to)!, relation_kind: `${from}-to-${to}`,
    instance_id: `${from}-to-${to}`, strength_milligrades: 1000, validity: VALIDITY, applicable: true
  }));
  const fixedLeaves = new Set([
    ...seeds.map((seed) => seedDerivationIdentity(productStateNodeId(seed.state))),
    ...transitions.map((transition) => transition.instance_id!)
  ]);
  return { scenario, interpretation, seeds, transitions, outputs, fixedLeaves };
}
type Fixture = ReturnType<typeof fixture>;

function page(): ObserverPage {
  return { schema_version: 1, query_id: "mixed-support", snapshot_id: SNAPSHOT_ID,
    cursor: { schema_version: 1, cursor_id: "adjacency", query_id: "mixed-support", snapshot_id: SNAPSHOT_ID,
      region_id: "adjacency", position: null, committed_through: null },
    observations: [], outcome: { schema_version: 1, status: "exhausted" }, open_regions: [] };
}

function freshField(input: Fixture, active: ReadonlySet<Leaf>): FieldEngineState {
  const initial = createConditionalField({ interpretation: input.interpretation, budget: defaultBudget({ finalization_reserve: 0 }),
    seeds: input.seeds, transitions: input.transitions, residuals: [] });
  const rows = LEAVES.filter((leaf) => active.has(leaf)).map((leaf) => ({
    sourceObjectId: "seed", targetObjectId: "end", predicate: leaf, assertionId: leaf, validity: VALIDITY
  }));
  const effects = adjacencyEffectsForRows(rows, {
    interpretation: input.interpretation, asOf: "2026-09-07T00:00:00.000Z",
    liveStates: initial.seen_identities, overlay: {},
    sourceFacts: new Map(["seed", "end"].map((object_id) => [object_id, { object_id, source_revision: "rev" }]))
  }).map((effect) => incompatibleAdmissionControl(effect, input.scenario.incompatible));
  return applyObserverPage(initial, { page: page(), effects });
}

function incompatibleAdmissionControl(effect: CompiledAdjacencyEffect, coordinate: Coordinate | undefined): CompiledAdjacencyEffect {
  if (coordinate === undefined || effect.hyperedge === undefined) return effect;
  expect(effect.hyperedge_premises).toHaveLength(2);
  // A deliberately contradictory compiler output tests the Field admission seam;
  // it is not claimed to arise from these compatible source rows naturally.
  return { ...effect, hyperedge_premises: effect.hyperedge_premises!.map((premise, index) => index === 0 ? premise
    : { ...premise, [coordinate]: coordinate === "binding_context"
      ? encodeBindingContext(new Map([["x", "other"], ["y", "end"]])) : `incompatible-${coordinate}` }) };
}

function activeLeaves(mask: number): ReadonlySet<Leaf> {
  return new Set(LEAVES.filter((_, index) => (mask & (1 << index)) !== 0));
}

function referenceGraph(input: Fixture, active: ReadonlySet<Leaf>) {
  const nodeIds = ["end"], seeds = new Map<string, number>(), edges: BooleanHyperedge[] = [];
  for (const [index, route] of input.scenario.routes.entries()) {
    const source = `route-${index}`, joint = `${source}:joint`;
    const premises = route.leaves.map((leaf) => `${source}:${leaf}`);
    nodeIds.push(source, joint, ...premises);
    seeds.set(source, route.grade);
    for (const [offset, leaf] of route.leaves.entries()) if (active.has(leaf)) {
      edges.push({ kind: "identity", from: source, to: premises[offset]! });
    }
    if (route.admitted) edges.push({ kind: "and", from: premises, to: joint, strength: 1000 });
  }
  edges.push({ kind: "or", from: ["route-0:joint", "route-1:joint"], to: "end", strength: 1000 });
  if (input.scenario.cycles) {
    nodeIds.push("cycle", "unfounded-a", "unfounded-b");
    edges.push({ kind: "identity", from: "end", to: "cycle" }, { kind: "identity", from: "cycle", to: "end" },
      { kind: "identity", from: "unfounded-a", to: "unfounded-b" }, { kind: "identity", from: "unfounded-b", to: "unfounded-a" });
  }
  expect(nodeIds.length).toBeLessThanOrEqual(16);
  expect(edges.length).toBeLessThanOrEqual(16);
  return { nodeIds, seeds, edges, bottom: 0 as const, top: 1000 };
}

function expectedValues(input: Fixture, active: ReadonlySet<Leaf>): Map<string, number> {
  const values = evaluateBooleanHypergraph(referenceGraph(input, active));
  return new Map([...input.outputs].flatMap(([id, product]) => values.has(id)
    ? [[productStateNodeId(product), values.get(id)!] as const] : []));
}

function actualValues(state: FieldEngineState): Map<string, number> {
  expect(state.closure.propagation).toBe("fixed_point");
  expect(state.closure.observation).toBe("exhausted");
  if (state.binding.kind !== "bound") throw new Error("expected finite Field binding");
  expect(state.binding.solver_complete).toBe(true);
  return new Map(state.binding.snapshot.values.filter((value) => value.accepting && value.milligrades !== undefined)
    .map((value) => [productStateNodeId(value.state), value.milligrades!]));
}

type Grounded = ReturnType<typeof groundedOutputDerivations>;
function proofForest(grounded: Grounded, product: ProductStateKey) {
  expect(grounded.complete).toBe(true);
  const roots = grounded.roots[productStateNodeId(product)] ?? [];
  const traced = traceDerivationForest({ forest: new Map(grounded.derivations.map((node) => [node.derivation_id, node])), roots });
  expect(traced.complete).toBe(true);
  return { roots, nodes: [...traced.traversal.nodes.values()], leaves: localLeafIds(traced.traversal) };
}

function proofGrade(proof: ReturnType<typeof proofForest>, active: ReadonlySet<Leaf>): number | undefined {
  const seeds = new Map<string, number>(), edges: BooleanHyperedge[] = [];
  for (const node of proof.nodes) {
    if (node.kind === "leaf") {
      if (node.leaf_ids.every((leaf) => !LEAVES.includes(leaf as Leaf) || active.has(leaf as Leaf))) {
        expect(node.association_milligrades).toBeDefined();
        seeds.set(node.derivation_id, node.association_milligrades!);
      }
    } else edges.push({ kind: node.kind === "or" ? "or" : "and", from: node.children, to: node.derivation_id, strength: 1000 });
  }
  edges.push({ kind: "or", from: proof.roots, to: "proof-output", strength: 1000 });
  return evaluateBooleanHypergraph({ nodeIds: [...proof.nodes.map((node) => node.derivation_id), "proof-output"],
    seeds, edges, bottom: 0, top: 1000 }).get("proof-output");
}

function compareCompleted(input: Fixture, state: FieldEngineState, fresh: FieldEngineState, active: ReadonlySet<Leaf>): void {
  const expected = expectedValues(input, active);
  expect(actualValues(state)).toEqual(expected);
  expect(actualValues(fresh)).toEqual(expected);
  expect(state.seen_identities.length).toBeLessThanOrEqual(16);
  expect(state.transitions.length).toBeLessThanOrEqual(16);
  const grounded = groundedOutputDerivations({ ...state, allowance: 10_000 });
  const rebuilt = groundedOutputDerivations({ ...fresh, allowance: 10_000 });
  const supportedLeaves = new Set(input.scenario.routes.filter((route) => route.admitted && route.leaves.every((leaf) => active.has(leaf)))
    .flatMap((route) => route.leaves));
  for (const [id, product] of input.outputs) {
    const actual = proofForest(grounded, product), rebuiltProof = proofForest(rebuilt, product);
    expect(actual.leaves).toEqual(rebuiltProof.leaves);
    expect(new Set([...actual.leaves].filter((leaf) => LEAVES.includes(leaf as Leaf))))
      .toEqual(expected.has(productStateNodeId(product)) ? supportedLeaves : new Set());
    for (const leaf of actual.leaves) expect(active.has(leaf as Leaf) || input.fixedLeaves.has(leaf)).toBe(true);
    // Re-evaluate the retained AND/OR forest for every subset of the active
    // source leaves. A flattened union cannot pass the alternative controls.
    for (let mask = 0; mask < 1 << LEAVES.length; mask += 1) {
      const subset = activeLeaves(mask);
      if ([...subset].some((leaf) => !active.has(leaf))) continue;
      const grade = evaluateBooleanHypergraph(referenceGraph(input, subset)).get(id);
      expect(proofGrade(actual, subset)).toBe(grade);
      expect(proofGrade(rebuiltProof, subset)).toBe(grade);
    }
  }
}

function settle(initial: FieldEngineState, allowance: number): FieldEngineState {
  let state = initial;
  for (let step = 0; state.closure.propagation !== "fixed_point" && step < 256; step += 1) {
    const { binding, closure: _closure, ...rest } = state;
    state = bindEngineState({ ...rest, proven_binding: binding, remaining_exploration: allowance });
    expect(state.remaining_exploration).toBeGreaterThanOrEqual(0);
    expect(state.remaining_reserve).toBe(initial.remaining_reserve);
    expect((state.solver_completed_work ?? 0) - (rest.solver_completed_work ?? 0)).toBeLessThanOrEqual(allowance);
  }
  expect(state.closure.propagation).toBe("fixed_point");
  return state;
}

describe("mixed conditional supports across withdrawal and fresh reconstruction", () => {
  it.each(SCENARIOS)("preserves $name for every active-leaf subset", (scenario) => {
    const input = fixture(scenario);
    const fresh = Array.from({ length: 1 << LEAVES.length }, (_, mask) => freshField(input, activeLeaves(mask)));
    const initial = fresh.at(-1)!;
    compareCompleted(input, initial, initial, new Set(LEAVES));
    for (let mask = 0; mask < fresh.length; mask += 1) {
      const wanted = activeLeaves(mask);
      const removed = LEAVES.filter((leaf) => !wanted.has(leaf));
      for (const order of [removed, [...removed].reverse()]) {
        let state = initial, currentMask = fresh.length - 1;
        for (const leaf of order) {
          state = withdrawDerivationLeaves(state, leaf);
          currentMask &= ~(1 << LEAVES.indexOf(leaf));
          compareCompleted(input, state, fresh[currentMask]!, activeLeaves(currentMask));
        }
        expect(actualValues(state)).toEqual(expectedValues(input, wanted));
      }
    }
  });

  it.each([1, 3])("keeps zero-grade support and incomplete work separate while resuming with allowance %s", (allowance) => {
    const input = fixture(SCENARIOS[2]!);
    const initial = freshField(input, new Set(LEAVES));
    const interrupted = withdrawDerivationLeaves({ ...initial, remaining_exploration: 0 }, "a");
    expect(interrupted.closure.propagation).toBe("open");
    expect(interrupted.binding.kind === "bound" && interrupted.binding.solver_complete).toBe(false);
    const state = settle(interrupted, allowance), active = new Set<Leaf>(["b", "c"]);
    const fresh = freshField(input, active);
    compareCompleted(input, state, fresh, active);
    expect(actualValues(state).get(productStateNodeId(input.outputs.get("end")!))).toBe(0);
    let grounding = groundedOutputDerivations({ ...state, allowance: 0 });
    expect(grounding.complete).toBe(false);
    expect(grounding.roots).toEqual({});
    for (let step = 0; !grounding.complete && step < 512; step += 1) {
      const before = grounding.progress.completed_work;
      grounding = groundedOutputDerivations({ ...state, allowance, progress: grounding.progress });
      expect(grounding.work).toBeLessThanOrEqual(allowance);
      expect(grounding.progress.completed_work).toBeGreaterThan(before);
    }
    const full = groundedOutputDerivations({ ...fresh, allowance: 10_000 });
    for (const product of input.outputs.values()) {
      expect(proofForest(grounding, product).leaves).toEqual(proofForest(full, product).leaves);
    }
    const unsupported = settle(withdrawDerivationLeaves({ ...state, remaining_exploration: 0 }, "c"), allowance);
    compareCompleted(input, unsupported, freshField(input, new Set<Leaf>(["b"])), new Set<Leaf>(["b"]));
    expect(actualValues(unsupported).size).toBe(0);
  });
});
