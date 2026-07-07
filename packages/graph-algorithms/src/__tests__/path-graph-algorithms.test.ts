import { describe, expect, it } from "vitest";
import {
  countStronglyConnectedComponents,
  parseRelativeTemporalTerm,
  resolveRelativeTemporalWindow
} from "../index.js";

describe("countStronglyConnectedComponents", () => {
  it("counts cyclic and isolated path graph components", () => {
    const adjacency = new Map<string, ReadonlySet<string>>([
      ["a", new Set(["b"])],
      ["b", new Set(["a"])],
      ["c", new Set(["d"])],
      ["d", new Set()],
      ["e", new Set()]
    ]);

    expect(countStronglyConnectedComponents(["a", "b", "c", "d", "e"], adjacency)).toBe(4);
  });
});

describe("relative temporal windows", () => {
  const anchorMs = Date.UTC(2026, 6, 7, 12);

  it("parses fixed and offset temporal terms", () => {
    expect(parseRelativeTemporalTerm(" 上周 ")).toEqual({
      kind: "offset",
      unit: "week",
      amount: -1
    });
    expect(parseRelativeTemporalTerm("3 months ago")).toEqual({
      kind: "offset",
      unit: "month",
      amount: -3
    });
    expect(parseRelativeTemporalTerm("next winter")).toEqual({
      kind: "season",
      season: "winter",
      yearOffset: 1
    });
    expect(parseRelativeTemporalTerm("not a temporal term")).toBeNull();
  });

  it("resolves month and season boundaries in UTC", () => {
    const monthTerm = parseRelativeTemporalTerm("last month");
    const seasonTerm = parseRelativeTemporalTerm("this summer");
    if (monthTerm === null || seasonTerm === null) {
      throw new Error("expected temporal terms to parse");
    }

    expect(resolveRelativeTemporalWindow(monthTerm, anchorMs)).toEqual({
      startMs: Date.UTC(2026, 5, 1),
      endMs: Date.UTC(2026, 6, 1) - 1,
      precision: "month"
    });
    expect(resolveRelativeTemporalWindow(seasonTerm, anchorMs)).toEqual({
      startMs: Date.UTC(2026, 5, 1),
      endMs: Date.UTC(2026, 8, 1) - 1,
      precision: "range"
    });
  });
});
