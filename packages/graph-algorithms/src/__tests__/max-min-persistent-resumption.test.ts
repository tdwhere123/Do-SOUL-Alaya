import { describe, expect, it } from "vitest";
import { extendMaxMinGraph, solveMaxMinField, type MaxMinInput } from "../max-min-field.js";
import { enumerateMaxMinField } from "./max-min-enumerate.js";

describe("persistent max-min resumption", () => {
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
