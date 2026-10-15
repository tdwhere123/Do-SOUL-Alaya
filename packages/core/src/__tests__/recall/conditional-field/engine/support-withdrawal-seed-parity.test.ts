import { describe, expect, it } from "vitest";
import { evaluateBooleanHypergraph, type BooleanHyperedge } from "@do-soul/alaya-graph-algorithms";
import type { ProductStateKey, SeedActivation, Transition } from "@do-soul/alaya-protocol";
import { createConditionalField, withdrawDerivationLeaves, type FieldEngineState }
  from "../../../../recall/conditional-field/engine/field-engine.js";
import { groundedOutputDerivations } from "../../../../recall/conditional-field/engine/output-derivations.js";
import { localLeafIds, traceDerivationForest } from "../../../../recall/conditional-field/engine/derivation-provenance.js";
import { seedDerivationIdentity } from "../../../../recall/conditional-field/engine/path-derivation.js";
import { productStateNodeId } from "../../../../recall/conditional-field/reference/bind-max-min.js";
import { defaultBudget, productKey } from "../reference/deployment.fixture.js";
import { query, relation } from "./relation-grounding.fixture.js";

const VALIDITY: Transition["validity"] = { kind: "open", valid_from: "2026-01-01T00:00:00.000Z" };
type Edge = Readonly<{ id: string; from: string; to: string; grade: number }>;
type Seed = Readonly<{ object: string; grade: number }>;
type Graph = Readonly<{ seeds: readonly Seed[]; edges: readonly Edge[] }>;
const key = (object: string): ProductStateKey => productKey(object);
const seedLeaf = (object: string) => seedDerivationIdentity(productStateNodeId(key(object)));

function build(graph: Graph): FieldEngineState {
  const seeds: SeedActivation[] = graph.seeds.map((seed) => ({ schema_version: 1, state: key(seed.object), milligrades: seed.grade }));
  const transitions: Transition[] = graph.edges.map((edge) => ({ schema_version: 1, from: key(edge.from), to: key(edge.to),
    relation_kind: edge.id, instance_id: edge.id, strength_milligrades: edge.grade, validity: VALIDITY, applicable: true }));
  return createConditionalField({ interpretation: query(relation("p")), budget: defaultBudget({ finalization_reserve: 0 }), seeds, transitions });
}

/** Independent reference: node value is max over incoming min(source value, edge grade); seeds are bottom-up facts. */
function reference(graph: Graph): Map<string, number> {
  const nodes = [...new Set([...graph.seeds.map((s) => s.object), ...graph.edges.flatMap((e) => [e.from, e.to])])];
  const edges: BooleanHyperedge[] = graph.edges.map((edge) => ({ kind: "and", from: [edge.from], to: edge.to, strength: edge.grade }));
  const values = evaluateBooleanHypergraph({ nodeIds: nodes, seeds: new Map(graph.seeds.map((s) => [s.object, s.grade])),
    edges, bottom: 0, top: 1000 });
  return new Map(nodes.flatMap((node) => (values.get(node) ?? 0) > 0 ? [[node, values.get(node)!] as const] : []));
}
function actual(state: FieldEngineState): Map<string, number> {
  if (state.binding.kind !== "bound") throw new Error("expected a bound field");
  expect(state.binding.solver_complete).toBe(true);
  return new Map(state.binding.snapshot.values.filter((v) => v.accepting && (v.milligrades ?? 0) > 0)
    .map((v) => [v.state.target.kind === "memory_entry" ? v.state.target.object_id : "?", v.milligrades!]));
}
function proofLeaves(state: FieldEngineState): Map<string, string[]> {
  const grounded = groundedOutputDerivations({ ...state, allowance: 100_000 });
  expect(grounded.complete).toBe(true);
  const forest = new Map(grounded.derivations.map((row) => [row.derivation_id, row]));
  return new Map(Object.entries(grounded.roots).map(([id, roots]) => [id,
    [...localLeafIds(traceDerivationForest({ forest, roots }).traversal)].sort()]));
}
const rootIds = (state: FieldEngineState, object: string) =>
  [...(groundedOutputDerivations({ ...state, allowance: 100_000 }).roots[productStateNodeId(key(object))] ?? [])].sort();
const without = (graph: Graph, leaf: string): Graph => ({ seeds: graph.seeds.filter((s) => seedLeaf(s.object) !== leaf),
  edges: graph.edges.filter((e) => e.id !== leaf) });

function expectRebuildParity(graph: Graph, state: FieldEngineState, leaf: string): Graph {
  const after = without(graph, leaf), withdrawn = withdrawDerivationLeaves(state, leaf), fresh = build(after);
  expect(actual(withdrawn)).toEqual(reference(after));
  expect(actual(fresh)).toEqual(reference(after));
  expect(proofLeaves(withdrawn)).toEqual(proofLeaves(fresh));
  return after;
}

const CYCLE: Graph = { seeds: [{ object: "s1", grade: 1000 }, { object: "s2", grade: 1000 }],
  edges: [{ id: "e1", from: "s1", to: "x", grade: 1000 }, { id: "e2", from: "s2", to: "x", grade: 1000 },
    { id: "c1", from: "x", to: "y", grade: 1000 }, { id: "c2", from: "y", to: "x", grade: 1000 }] };

describe("seed and edge withdrawal matches a fresh field", () => {
  it.each([["s1", "s2"], ["s2", "s1"]] as const)("a positive cycle dies with its last seed (%s then %s)", (first, second) => {
    const full = build(CYCLE);
    expect([...actual(full).keys()].sort()).toEqual(["s1", "s2", "x", "y"]);
    let graph = CYCLE, state = full;
    graph = expectRebuildParity(graph, state, seedLeaf(first));
    state = withdrawDerivationLeaves(state, seedLeaf(first));
    // Hand-derived: the other seed still feeds the cycle, so x and y stay supported.
    expect([...actual(state).keys()].sort()).toEqual([second, "x", "y"]);
    graph = expectRebuildParity(graph, state, seedLeaf(second));
    state = withdrawDerivationLeaves(state, seedLeaf(second));
    // Hand-derived: x<->y has no founded derivation once both seeds are gone.
    expect(actual(state).size).toBe(0);
    expect(actual(build(graph)).size).toBe(0);
  });

  it("a positive cycle dies when the last feeding edge is withdrawn although its seeds remain", () => {
    let graph = CYCLE, state = build(CYCLE);
    for (const leaf of ["e1", "e2"]) {
      graph = expectRebuildParity(graph, state, leaf);
      state = withdrawDerivationLeaves(state, leaf);
    }
    expect([...actual(state).keys()].sort()).toEqual(["s1", "s2"]);
  });

  it("a mixed seed and edge removal in either order lands on the same fresh field", () => {
    for (const order of [["s1", "e2"], ["e2", "s1"]]) {
      let graph = CYCLE, state = build(CYCLE);
      for (const name of order) {
        const leaf = name.startsWith("s") ? seedLeaf(name) : name;
        graph = expectRebuildParity(graph, state, leaf);
        state = withdrawDerivationLeaves(state, leaf);
      }
      // Hand-derived: only the unconnected seed s2 survives; e1 starts at the withdrawn seed s1.
      expect([...actual(state).keys()]).toEqual(["s2"]);
      expect(actual(state)).toEqual(reference(graph));
    }
  });
});

const PARALLEL = (seed: number): Graph => ({ seeds: [{ object: "s", grade: seed }],
  edges: [{ id: "high", from: "s", to: "end", grade: 1000 }, { id: "low", from: "s", to: "end", grade: 700 }] });

describe("decreasing an alternative below a cap", () => {
  it("keeps a capped value and rebinds its proof to the surviving alternative", () => {
    const graph = PARALLEL(400), full = build(graph);
    expect(actual(full).get("end")).toBe(400);
    const before = rootIds(full, "end");
    expectRebuildParity(graph, full, "high");
    const withdrawn = withdrawDerivationLeaves(full, "high");
    // Hand-derived: min(400, 700) = 400, so the value is unchanged but the 1000 alternative no longer supports it.
    expect(actual(withdrawn).get("end")).toBe(400);
    expect(proofLeaves(withdrawn).get(productStateNodeId(key("end")))).not.toContain("high");
    expect(rootIds(withdrawn, "end")).not.toEqual(before);
    expect(rootIds(withdrawn, "end")).toEqual(rootIds(build(without(graph, "high")), "end"));
  });

  it("lowers the value once the cap no longer masks the decrease", () => {
    const graph = PARALLEL(800), full = build(graph);
    expect(actual(full).get("end")).toBe(800);
    expectRebuildParity(graph, full, "high");
    // Hand-derived: min(800, 700) = 700 after the 1000 alternative leaves.
    expect(actual(withdrawDerivationLeaves(full, "high")).get("end")).toBe(700);
    expect(actual(withdrawDerivationLeaves(full, "low")).get("end")).toBe(800);
    expectRebuildParity(graph, full, "low");
  });
});
