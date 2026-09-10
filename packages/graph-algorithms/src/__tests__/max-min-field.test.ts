import { describe, expect, it } from "vitest";
import {
  solveMaxMinField,
  type MaxMinInput,
  type MaxMinTransition,
  type MaxMinWorkItem
} from "../index.js";
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
    expectMapsEqual(
      relabeled,
      new Map([...original].map(([nodeId, value]) => [nodeId, value * value]))
    );
  });

  it("omits unseeded nodes and keeps seeded milligrade 0 reachable", () => {
    const isolated = solveMaxMinField({
      nodeIds: ["accepting"],
      seeds: new Map(),
      transitions: [],
      bottom: 0,
      top: 1000
    });
    expect(isolated.values.has("accepting")).toBe(false);
    expect(isolated.complete).toBe(true);

    const seededZero = solveMaxMinField({
      nodeIds: ["seed"],
      seeds: new Map([["seed", 0]]),
      transitions: [],
      bottom: 0,
      top: 1000
    });
    expect(seededZero.values.get("seed")).toBe(0);

    const hard = solveMaxMinField({
      nodeIds: ["seed", "accepting"],
      seeds: new Map([["seed", 0]]),
      transitions: [{ from: "seed", to: "accepting", strength: 1000 }],
      bottom: 0,
      top: 1000
    });
    expect(hard.values.get("seed")).toBe(0);
    expect(hard.values.get("accepting")).toBe(0);

    const incomingOnly = solveMaxMinField({
      nodeIds: ["from", "to"],
      seeds: new Map(),
      transitions: [{ from: "from", to: "to", strength: 1000 }],
      bottom: 0,
      top: 1000
    });
    expect(incomingOnly.values.has("from")).toBe(false);
    expect(incomingOnly.values.has("to")).toBe(false);

    const cycle = solveMaxMinField({
      nodeIds: ["a", "b"],
      seeds: new Map(),
      transitions: [
        { from: "a", to: "b", strength: 1000 },
        { from: "b", to: "a", strength: 900 }
      ],
      bottom: 0,
      top: 1000
    });
    expect(cycle.values.has("a")).toBe(false);
    expect(cycle.values.has("b")).toBe(false);
    expect(cycle.complete).toBe(true);
    expectMapsEqual(cycle.values, enumerateMaxMinField({
      nodeIds: ["a", "b"],
      seeds: new Map(),
      transitions: [
        { from: "a", to: "b", strength: 1000 },
        { from: "b", to: "a", strength: 900 }
      ],
      bottom: 0,
      top: 1000
    }));
  });

  it("keeps proven lower values and resumes the residual worklist after a pause", () => {
    const input: MaxMinInput = {
      nodeIds: ["a", "b", "c", "d"],
      seeds: new Map([["a", 1000]]),
      transitions: [
        { from: "a", to: "b", strength: 900 },
        { from: "b", to: "c", strength: 800 },
        { from: "c", to: "d", strength: 700 }
      ],
      bottom: 0,
      top: 1000
    };
    const paused = solveMaxMinField({ ...input, workLimit: 1 });
    expect(paused.complete).toBe(false);
    expect(paused.steps).toBe(1);
    expect(paused.values.get("a")).toBe(1000);
    expect(paused.values.get("b")).toBe(900);
    expect(paused.values.has("d")).toBe(false);
    expect(paused.remainingWorklist.length).toBeGreaterThan(0);
    const resumed = solveMaxMinField({
      ...input,
      priorValues: paused.values,
      worklist: paused.remainingWorklist
    });
    expect(resumed.complete).toBe(true);
    expect(resumed.values.get("d")).toBe(700);
    expectMapsEqual(resumed.values, enumerateMaxMinField(input));
    for (const [nodeId, value] of paused.values) {
      expect(resumed.values.get(nodeId)).toBeGreaterThanOrEqual(value);
    }
  });

  it("matches the simple-path oracle and unary grade closure, including seed 0", () => {
    const rng = mulberry32(9062026);
    for (let nodeCount = 1; nodeCount < 8; nodeCount += 1) {
      for (let trial = 0; trial < 40; trial += 1) {
        const input = randomGraph(nodeCount, rng);
        const solved = solveMaxMinField(input);
        expectMapsEqual(solved.values, enumerateMaxMinField(input));
        expect(unaryGradeClosed(input, solved.values)).toBe(true);
      }
    }
    const zeroSeed = {
      nodeIds: ["a", "b", "c"],
      seeds: new Map([["a", 0]]),
      transitions: [
        { from: "a", to: "b", strength: 900 },
        { from: "b", to: "c", strength: 400 }
      ],
      bottom: 0 as const,
      top: 1000
    };
    const solved = solveMaxMinField(zeroSeed);
    expectMapsEqual(solved.values, enumerateMaxMinField(zeroSeed));
    expect(solved.values.get("c")).toBe(0);
    expect(unaryGradeClosed(zeroSeed, solved.values)).toBe(true);
  });

  it("converges under different work limits without raising on duplicate pages", () => {
    const input = deploymentInput();
    const oracle = enumerateMaxMinField(input);
    const full = solveMaxMinField(input).values;
    expectMapsEqual(full, oracle);
    for (const width of [1, 2, 5, 20]) {
      expectMapsEqual(solveByPages(input, width).values, oracle);
    }
    const once = solveMaxMinField(input);
    const replay = solveMaxMinField({
      ...input,
      priorValues: once.values,
      transitions: [...input.transitions, ...input.transitions]
    });
    expectMapsEqual(replay.values, once.values);
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

function solveByPages(input: MaxMinInput, pageWidth: number): ReturnType<typeof solveMaxMinField> {
  let values: ReadonlyMap<string, number> | undefined;
  let worklist: readonly MaxMinWorkItem[] | undefined;
  let last: ReturnType<typeof solveMaxMinField> | undefined;
  for (let round = 0; round < 64; round += 1) {
    last = solveMaxMinField({
      ...input,
      priorValues: values,
      worklist,
      workLimit: pageWidth
    });
    if (values !== undefined) {
      for (const [nodeId, value] of values) {
        expect(last.values.get(nodeId) ?? -1).toBeGreaterThanOrEqual(value);
      }
    }
    values = last.values;
    worklist = last.remainingWorklist;
    if (last.complete) return last;
  }
  if (last !== undefined && last.complete) return last;
  throw new Error("paged max-min solve did not complete");
}

function unaryGradeClosed(input: MaxMinInput, values: ReadonlyMap<string, number>): boolean {
  const nodeSet = new Set(input.nodeIds);
  const seedZero = [...input.seeds.keys()].filter((nodeId) => nodeSet.has(nodeId));
  const reachedZero = reachableFrom(seedZero, input.transitions.filter((transition) =>
    nodeSet.has(transition.from) && nodeSet.has(transition.to)
  ));
  for (const nodeId of nodeSet) {
    if (values.has(nodeId) !== reachedZero.has(nodeId)) return false;
  }
  for (let grade = 1; grade <= input.top; grade += 1) {
    const seeds = [...input.seeds].flatMap(([nodeId, value]) =>
      nodeSet.has(nodeId) && value >= grade ? [nodeId] : []
    );
    const edges = input.transitions.filter((transition) =>
      nodeSet.has(transition.from) && nodeSet.has(transition.to) && transition.strength >= grade
    );
    const reached = reachableFrom(seeds, edges);
    for (const nodeId of nodeSet) {
      const has = (values.get(nodeId) ?? Number.NEGATIVE_INFINITY) >= grade;
      if (has !== reached.has(nodeId)) return false;
    }
  }
  return true;
}

function reachableFrom(
  seeds: readonly string[],
  transitions: readonly MaxMinTransition[]
): Set<string> {
  const outgoing = new Map<string, string[]>();
  for (const transition of transitions) {
    const list = outgoing.get(transition.from);
    if (list === undefined) outgoing.set(transition.from, [transition.to]);
    else list.push(transition.to);
  }
  const reached = new Set<string>(seeds);
  const stack = [...seeds];
  while (stack.length > 0) {
    const nodeId = stack.pop()!;
    for (const next of outgoing.get(nodeId) ?? []) {
      if (reached.has(next)) continue;
      reached.add(next);
      stack.push(next);
    }
  }
  return reached;
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
