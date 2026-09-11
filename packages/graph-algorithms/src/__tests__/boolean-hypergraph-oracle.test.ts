import { describe, expect, it } from "vitest";
import {
  evaluateBooleanHypergraph,
  solveMaxMinField,
  type BooleanHyperedge,
  type BooleanHypergraphInput,
  type MaxMinInput,
  type MaxMinTransition
} from "../index.js";
import { enumerateMaxMinField } from "./max-min-enumerate.js";

describe("evaluateBooleanHypergraph", () => {
  it("omits unseeded nodes and keeps seeded milligrade 0", () => {
    const isolated = evaluateBooleanHypergraph(graph(["accepting"], [], []));
    expect(isolated.has("accepting")).toBe(false);

    const seededZero = evaluateBooleanHypergraph(graph(["seed"], [["seed", 0]], []));
    expect(seededZero.get("seed")).toBe(0);

    const incomingOnly = evaluateBooleanHypergraph(graph(
      ["from", "to"],
      [],
      [{ kind: "unary", from: "from", to: "to", strength: 1000 }]
    ));
    expect(incomingOnly.has("from")).toBe(false);
    expect(incomingOnly.has("to")).toBe(false);

    const cycle = evaluateBooleanHypergraph(graph(
      ["a", "b"],
      [],
      [
        { kind: "unary", from: "a", to: "b", strength: 1000 },
        { kind: "unary", from: "b", to: "a", strength: 900 }
      ]
    ));
    expect(cycle.has("a")).toBe(false);
    expect(cycle.has("b")).toBe(false);

    const reachableZero = evaluateBooleanHypergraph(graph(
      ["seed", "accepting"],
      [["seed", 0]],
      [{ kind: "unary", from: "seed", to: "accepting", strength: 1000 }]
    ));
    expect(reachableZero.get("seed")).toBe(0);
    expect(reachableZero.get("accepting")).toBe(0);
  });

  it("assigns AND as the min of joint premises and edge strength", () => {
    const bothPresent = evaluateBooleanHypergraph(graph(
      ["p", "q", "t"],
      [["p", 800], ["q", 800]],
      [{ kind: "and", from: ["p", "q"], to: "t", strength: 700 }]
    ));
    expect(bothPresent.get("p")).toBe(800);
    expect(bothPresent.get("q")).toBe(800);
    expect(bothPresent.get("t")).toBe(700);

    const oneMissing = evaluateBooleanHypergraph(graph(
      ["p", "q", "t"],
      [["p", 800]],
      [{ kind: "and", from: ["p", "q"], to: "t", strength: 700 }]
    ));
    expect(oneMissing.get("p")).toBe(800);
    expect(oneMissing.has("q")).toBe(false);
    expect(oneMissing.has("t")).toBe(false);
  });

  it("assigns OR as the max of alternatives", () => {
    const values = evaluateBooleanHypergraph(graph(
      ["a", "b", "t"],
      [["a", 600], ["b", 900]],
      [{ kind: "or", from: ["a", "b"], to: "t", strength: 1000 }]
    ));
    expect(values.get("a")).toBe(600);
    expect(values.get("b")).toBe(900);
    expect(values.get("t")).toBe(900);
  });

  it("matches enumerateMaxMinField and solveMaxMinField on unary graphs", () => {
    const deployment = graph(
      ["r", "l", "c", "s", "h", "u"],
      [["r", 1000]],
      [
        { kind: "unary", from: "r", to: "l", strength: 950 },
        { kind: "unary", from: "l", to: "c", strength: 850 },
        { kind: "unary", from: "r", to: "c", strength: 800 },
        { kind: "unary", from: "r", to: "s", strength: 900 },
        { kind: "unary", from: "s", to: "h", strength: 550 }
      ]
    );
    expectUnaryMatchesMaxMin(deployment);

    const rng = mulberry32(9062026);
    for (let nodeCount = 1; nodeCount < 8; nodeCount += 1) {
      for (let trial = 0; trial < 40; trial += 1) {
        expectUnaryMatchesMaxMin(randomUnaryGraph(nodeCount, rng));
      }
    }
  });

  it("copies the source grade through an admitted identity edge at top", () => {
    const copied = evaluateBooleanHypergraph(graph(
      ["src", "dst"],
      [["src", 850]],
      [{ kind: "identity", from: "src", to: "dst" }]
    ));
    expect(copied.get("src")).toBe(850);
    expect(copied.get("dst")).toBe(850);

    const zero = evaluateBooleanHypergraph(graph(
      ["src", "dst"],
      [["src", 0]],
      [{ kind: "identity", from: "src", to: "dst" }]
    ));
    expect(zero.get("src")).toBe(0);
    expect(zero.get("dst")).toBe(0);

    const unseeded = evaluateBooleanHypergraph(graph(
      ["src", "dst"],
      [],
      [{ kind: "identity", from: "src", to: "dst" }]
    ));
    expect(unseeded.has("src")).toBe(false);
    expect(unseeded.has("dst")).toBe(false);
  });
});

function graph(
  nodeIds: readonly string[],
  seeds: ReadonlyArray<readonly [string, number]>,
  edges: readonly BooleanHyperedge[],
  top = 1000
): BooleanHypergraphInput {
  return { nodeIds, seeds: new Map(seeds), edges, bottom: 0, top };
}

function expectUnaryMatchesMaxMin(input: BooleanHypergraphInput): void {
  const hypergraph = evaluateBooleanHypergraph(input);
  const maxMinInput = unaryAsMaxMin(input);
  expectMapsEqual(hypergraph, enumerateMaxMinField(maxMinInput));
  expectMapsEqual(hypergraph, solveMaxMinField(maxMinInput).values);
  for (const nodeId of maxMinInput.seeds.keys()) {
    if (!new Set(input.nodeIds).has(nodeId)) continue;
    expect(hypergraph.has(nodeId)).toBe(true);
  }
}

function unaryAsMaxMin(input: BooleanHypergraphInput): MaxMinInput {
  const transitions: MaxMinTransition[] = [];
  for (const edge of input.edges) {
    if (edge.kind !== "unary") {
      throw new Error("unary comparison received a non-unary hyperedge");
    }
    transitions.push({ from: edge.from, to: edge.to, strength: edge.strength });
  }
  return {
    nodeIds: input.nodeIds,
    seeds: input.seeds,
    transitions,
    bottom: 0,
    top: input.top
  };
}

function randomUnaryGraph(nodeCount: number, rng: () => number): BooleanHypergraphInput {
  const nodeIds = Array.from({ length: nodeCount }, (_, index) => `n${index}`);
  const edges: BooleanHyperedge[] = [];
  for (let from = 0; from < nodeCount; from += 1) {
    for (let to = 0; to < nodeCount; to += 1) {
      if (rng() < 0.29) {
        edges.push({
          kind: "unary",
          from: nodeIds[from]!,
          to: nodeIds[to]!,
          strength: 1 + Math.floor(rng() * 5)
        });
      }
    }
  }
  const seeds: Array<readonly [string, number]> = [];
  for (const nodeId of nodeIds) {
    if (rng() < 0.4) seeds.push([nodeId, Math.floor(rng() * 6)]);
  }
  return graph(nodeIds, seeds, edges, 5);
}

function expectMapsEqual(
  left: ReadonlyMap<string, number>,
  right: ReadonlyMap<string, number>
): void {
  expect([...left.entries()].sort(compareEntry)).toEqual([...right.entries()].sort(compareEntry));
}

function compareEntry(
  left: readonly [string, number],
  right: readonly [string, number]
): number {
  return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let next = state;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}
