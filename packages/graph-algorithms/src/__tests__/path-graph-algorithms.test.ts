import { describe, expect, it } from "vitest";
import {
  countStronglyConnectedComponents,
  extractTemporalTerms,
  parseAbsoluteTemporalWindow,
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

  it("parses word-number offsets and relative weekdays", () => {
    expect(parseRelativeTemporalTerm("tonight")).toEqual({
      kind: "offset",
      unit: "day",
      amount: 0
    });
    expect(parseRelativeTemporalTerm("one week ago")).toEqual({
      kind: "offset",
      unit: "week",
      amount: -1
    });
    expect(parseRelativeTemporalTerm("five days ago")).toEqual({
      kind: "offset",
      unit: "day",
      amount: -5
    });
    expect(parseRelativeTemporalTerm("twelve months ago")).toEqual({
      kind: "offset",
      unit: "month",
      amount: -12
    });
    expect(parseRelativeTemporalTerm("last Saturday")).toEqual({
      kind: "weekday",
      weekday: "saturday",
      weekOffset: -1
    });
    expect(parseRelativeTemporalTerm("this Monday")).toEqual({
      kind: "weekday",
      weekday: "monday",
      weekOffset: 0
    });
    expect(parseRelativeTemporalTerm("next Sunday")).toEqual({
      kind: "weekday",
      weekday: "sunday",
      weekOffset: 1
    });
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

  it("resolves relative weekdays from a fixed anchor", () => {
    const term = parseRelativeTemporalTerm("last Saturday");
    if (term === null) {
      throw new Error("expected relative weekday to parse");
    }
    expect(resolveRelativeTemporalWindow(term, Date.parse("2026-08-22T08:01:00.000Z"))).toEqual({
      startMs: Date.parse("2026-08-15T00:00:00.000Z"),
      endMs: Date.parse("2026-08-15T23:59:59.999Z"),
      precision: "day"
    });
    expect(resolveRelativeTemporalWindow(term, Date.parse("2026-08-23T08:01:00.000Z"))).toEqual({
      startMs: Date.parse("2026-08-22T00:00:00.000Z"),
      endMs: Date.parse("2026-08-22T23:59:59.999Z"),
      precision: "day"
    });
  });

  it("resolves weekdays in the caller's fixed-offset civil calendar", () => {
    const term = parseRelativeTemporalTerm("last Saturday");
    if (term === null) throw new Error("expected relative weekday to parse");
    const offsetMinutes = 8 * 60;
    expect(resolveRelativeTemporalWindow(
      term,
      Date.parse("2026-08-23T00:30:00+08:00"),
      offsetMinutes
    )).toEqual({
      startMs: Date.parse("2026-08-22T00:00:00+08:00"),
      endMs: Date.parse("2026-08-23T00:00:00+08:00") - 1,
      precision: "day"
    });
  });

  it("anchors this and next winter correctly during January", () => {
    const anchor = Date.parse("2026-01-15T12:00:00Z");
    const current = parseRelativeTemporalTerm("this winter");
    const next = parseRelativeTemporalTerm("next winter");
    if (current === null || next === null) throw new Error("expected winter terms");
    expect(resolveRelativeTemporalWindow(current, anchor).startMs)
      .toBe(Date.parse("2025-12-01T00:00:00Z"));
    expect(resolveRelativeTemporalWindow(next, anchor).startMs)
      .toBe(Date.parse("2026-12-01T00:00:00Z"));
  });
});

describe("absolute calendar expressions", () => {
  it("extracts and preserves English month, bare year, and Chinese year precision", () => {
    expect(extractTemporalTerms("March 2024 plans and 2025年总结")).toEqual([
      "March 2024",
      "2025年"
    ]);
    expect(parseAbsoluteTemporalWindow("March 2024")).toEqual({
      startMs: Date.UTC(2024, 2, 1),
      endMs: Date.UTC(2024, 3, 1) - 1,
      precision: "month"
    });
    expect(parseAbsoluteTemporalWindow("2024")).toEqual({
      startMs: Date.UTC(2024, 0, 1),
      endMs: Date.UTC(2025, 0, 1) - 1,
      precision: "year"
    });
    expect(parseAbsoluteTemporalWindow("2025年")).toEqual({
      startMs: Date.UTC(2025, 0, 1),
      endMs: Date.UTC(2026, 0, 1) - 1,
      precision: "year"
    });
  });

  it("does not split a precise date into an extra bare-year term", () => {
    expect(extractTemporalTerms("on 2024-03-15 and in Apr 2025")).toEqual([
      "2024-03-15",
      "Apr 2025"
    ]);
  });

  it("does not interpret identifier segments as bare years", () => {
    expect(extractTemporalTerms("memory 11111111-1111-4111-8111-111111111111")).toEqual([]);
  });

  it("rejects month precision outside the supported year range", () => {
    expect(parseAbsoluteTemporalWindow("0099-05")).toBeNull();
    expect(parseAbsoluteTemporalWindow("0099年5月")).toBeNull();
    expect(parseAbsoluteTemporalWindow("May 0099")).toBeNull();
  });
});
