import { describe, expect, it } from "vitest";
import { solveMaxMinField, type MaxMinInput, type MaxMinTransition } from "../index.js";
import { enumerateMaxMinField } from "./max-min-enumerate.js";

describe("solveMaxMinField", () => {
  it("matches independent simple-path enumeration on small graphs with cycles", () => {
    const rng = mulberry32(9062026);
    for (let nodeCount = 1; nodeCount < 8; nodeCount += 1) {
      for (let trial = 0; trial < 80; trial += 1) {
        const input = randomGraph(nodeCount, rng);
        expectMapsEqual(solveMaxMinField(input).values, enumerateMaxMinField(input));
      }
    }
  });

  it("does not raise values when duplicate edges are replayed", () => {
    const input = deploymentInput();
    const once = solveMaxMinField(input).values;
    const twice = solveMaxMinField({
      ...input,
      transitions: [...input.transitions, ...input.transitions]
    }).values;
    expectMapsEqual(once, twice);
    expectMapsEqual(once, enumerateMaxMinField(input));
  });

  it("assigns the deployment bottleneck values", () => {
    const result = solveMaxMinField(deploymentInput());
    expect(result.values.get("c")).toBe(850);
    expect(result.values.get("h")).toBe(550);
    expect(result.values.get("l")).toBe(950);
    expect(result.values.get("s")).toBe(900);
    expect(result.values.get("r")).toBe(1000);
    expect(result.retainedTransitions).toHaveLength(5);
  });

  it("keeps a 20-hop homogeneous 900 chain at 900", () => {
    const nodeIds = Array.from({ length: 21 }, (_, index) => `n${index}`);
    const transitions: MaxMinTransition[] = [];
    for (let index = 0; index < 20; index += 1) {
      transitions.push({ from: `n${index}`, to: `n${index + 1}`, strength: 900 });
    }
    const result = solveMaxMinField({
      nodeIds,
      seeds: new Map([["n0", 900]]),
      transitions,
      bottom: 0,
      top: 1000
    });
    expect(result.values.get("n20")).toBe(900);
    for (const nodeId of nodeIds) expect(result.values.get(nodeId)).toBe(900);
  });

  it("squares values when strengths are squared", () => {
    const input = deploymentInput();
    const squared: MaxMinInput = {
      ...input,
      seeds: new Map([...input.seeds].map(([nodeId, value]) => [nodeId, value * value])),
      transitions: input.transitions.map((transition) => ({
        ...transition,
        strength: transition.strength * transition.strength
      })),
      top: 1000 * 1000
    };
    const original = solveMaxMinField(input).values;
    const relabeled = solveMaxMinField(squared).values;
    for (const nodeId of input.nodeIds) {
      expect(relabeled.get(nodeId)).toBe((original.get(nodeId) ?? 0) ** 2);
    }
  });
});

function deploymentInput(): MaxMinInput {
  return {
    nodeIds: ["r", "l", "c", "s", "h", "u"],
    seeds: new Map([["r", 1000]]),
    transitions: [
      { from: "r", to: "l", strength: 950 },
      { from: "l", to: "c", strength: 850 },
      { from: "r", to: "c", strength: 800 },
      { from: "r", to: "s", strength: 900 },
      { from: "s", to: "h", strength: 550 }
    ],
    bottom: 0,
    top: 1000
  };
}

function randomGraph(nodeCount: number, rng: () => number): MaxMinInput {
  const nodeIds = Array.from({ length: nodeCount }, (_, index) => `n${index}`);
  const transitions: MaxMinTransition[] = [];
  for (let from = 0; from < nodeCount; from += 1) {
    for (let to = 0; to < nodeCount; to += 1) {
      if (rng() < 0.29) {
        transitions.push({
          from: nodeIds[from]!,
          to: nodeIds[to]!,
          strength: 1 + Math.floor(rng() * 5)
        });
      }
    }
  }
  const seeds = new Map<string, number>();
  for (const nodeId of nodeIds) {
    if (rng() < 0.4) seeds.set(nodeId, Math.floor(rng() * 6));
  }
  return { nodeIds, seeds, transitions, bottom: 0, top: 5 };
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
