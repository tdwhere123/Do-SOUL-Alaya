import { describe, expect, it } from "vitest";
import { extendMaxMinGraph, solveMaxMinField, type MaxMinInput } from "../max-min-field.js";
import { MonotonicHypergraphMaintainer } from "../bottleneck-hypergraph-maintainer.js";
import { enumerateMaxMinField } from "./max-min-enumerate.js";

describe("persistent max-min resumption", () => {
  it("propagates new and raised seeds after the previous queue is empty", () => {
    const input: MaxMinInput = { nodeIds: ["a", "b", "c", "d"], bottom: 0, top: 1000,
      seeds: new Map([["a", 300]]), transitions: [
        { from: "a", to: "b", strength: 800 }, { from: "c", to: "d", strength: 600 }
      ] };
    const preparedGraph = extendMaxMinGraph(undefined, input.nodeIds, input.transitions);
    const prior = solveMaxMinField({ ...input, preparedGraph });
    expect(prior.complete).toBe(true);
    expect(prior.workQueue.size).toBe(0);
    const seeds = new Map([["a", 900], ["c", 700]]);
    const resumed = solveMaxMinField({ ...input, preparedGraph, seeds, priorValues: prior.values, workQueue: prior.workQueue });
    const expected = [["a", 900], ["b", 800], ["c", 700], ["d", 600]];
    expect([...resumed.values].sort()).toEqual(expected);
    expect([...solveMaxMinField({ ...input, seeds }).values].sort()).toEqual(expected);
    expect([...prior.values].sort()).toEqual([["a", 300], ["b", 300]]);
    expect([...prior.workQueue]).toEqual([]);
  });

  it("rejects a trusted prior whose bound top disagrees with the call", () => {
    const input: MaxMinInput = {
      nodeIds: ["a"], bottom: 0, top: 1000, seeds: new Map([["a", 900]]), transitions: []
    };
    const prior = solveMaxMinField(input);
    expect(prior.values.get("a")).toBe(900);
    expect(() => solveMaxMinField({ ...input, top: 100, seeds: new Map(), priorValues: prior.values }))
      .toThrow(RangeError);
    const resumed = solveMaxMinField({ ...input, seeds: new Map(), priorValues: prior.values });
    expect(resumed.values.get("a")).toBe(900);
    expect(resumed.values).toBe(prior.values);
  });

  it.each([NaN, -1, 1001])("rejects grade %s in the solver and maintainer", grade => {
    const input: MaxMinInput = { nodeIds: ["a", "b"], bottom: 0, top: 1000, seeds: new Map(), transitions: [] };
    const seeds = new Map([["a", grade]]);
    const maintainer = new MonotonicHypergraphMaintainer(input);
    expect(() => solveMaxMinField({ ...input, seeds })).toThrow(/max-min grade/u);
    expect(() => maintainer.raiseSeed("a", grade)).toThrow(/max-min grade/u);
    const transitions = [{ from: "a", to: "b", strength: grade }];
    expect(() => solveMaxMinField({ ...input, transitions })).toThrow(/max-min grade/u);
    expect(() => solveMaxMinField({ ...input, preparedGraph: extendMaxMinGraph(undefined, input.nodeIds, transitions) }))
      .toThrow(/max-min grade/u);
  });

  it("matches independent path enumeration across interruption widths without mutating prior pages", () => {
    for (let variant = 0; variant < 64; variant += 1) {
      const input = finiteGraph(variant);
      const oracle = [...enumerateMaxMinField(input)].sort();
      const preparedGraph = extendMaxMinGraph(undefined, input.nodeIds, input.transitions);
      for (const width of [1, 3]) {
        let solved = solveMaxMinField({ ...input, preparedGraph, workLimit: width });
        let pages = 0;
        while (!solved.complete && pages < 1000) {
          const prior = solved;
          const priorValues = [...prior.values];
          const priorQueue = [...prior.workQueue];
          solved = solveMaxMinField({ ...input, preparedGraph, seeds: new Map(),
            priorValues: prior.values, workQueue: prior.workQueue, workLimit: width });
          expect(solved.steps).toBeLessThanOrEqual(width);
          expect([...prior.values]).toEqual(priorValues);
          expect([...prior.workQueue]).toEqual(priorQueue);
          pages += 1;
        }
        expect(solved.complete).toBe(true);
        expect([...solved.values].sort()).toEqual(oracle);
      }
    }
  });

  it("visits at most one outgoing edge under one unit even for a wide prepared frontier", () => {
    const input: MaxMinInput = { nodeIds: Array.from({ length: 101 }, (_, index) => `n${index}`),
      seeds: new Map([["n0", 0]]), bottom: 0, top: 1000,
      transitions: Array.from({ length: 100 }, (_, index) => ({ from: "n0", to: `n${index + 1}`, strength: 1000 })) };
    const preparedGraph = extendMaxMinGraph(undefined, input.nodeIds, input.transitions);
    const solved = solveMaxMinField({ ...input, preparedGraph, workLimit: 1 });
    expect(solved.values.size).toBe(2);
    expect(solved.values.get("n1")).toBe(0);
    expect(solved.complete).toBe(false);
    expect(solved.steps).toBe(1);
  });
});

function finiteGraph(variant: number): MaxMinInput {
  const nodeIds = ["a", "b", "c", "d", "e"];
  const grades = [0, 200, 500, 800, 1000];
  return { nodeIds, bottom: 0, top: 1000,
    seeds: variant % 7 === 0 ? new Map() : new Map([["a", grades[variant % grades.length]!], ["c", grades[(variant + 2) % grades.length]!]]),
    transitions: nodeIds.flatMap((from, fromIndex) => nodeIds.flatMap((to, toIndex) =>
      ((variant * 17 + fromIndex * 11 + toIndex * 7) % 8) < 3
        ? [{ from, to, strength: grades[(variant + fromIndex + toIndex) % grades.length]! }] : [])) };
}
