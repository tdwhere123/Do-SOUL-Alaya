import { describe, expect, it } from "vitest";
import {
  parseRelativeTemporalTerm,
  resolveRelativeTemporalWindow
} from "../../soul/temporal-window.js";

describe("parseRelativeTemporalTerm", () => {
  it("maps fixed phrases (case/whitespace-insensitive, EN + CJK) to canonical offsets", () => {
    expect(parseRelativeTemporalTerm("  LAST   week ")).toEqual({ kind: "offset", unit: "week", amount: -1 });
    expect(parseRelativeTemporalTerm("上个月")).toEqual({ kind: "offset", unit: "month", amount: -1 });
    expect(parseRelativeTemporalTerm("yesterday")).toEqual({ kind: "offset", unit: "day", amount: -1 });
  });

  it("maps 'N units ago' (EN + CJK) to negative offsets", () => {
    expect(parseRelativeTemporalTerm("3 days ago")).toEqual({ kind: "offset", unit: "day", amount: -3 });
    expect(parseRelativeTemporalTerm("2 weeks ago")).toEqual({ kind: "offset", unit: "week", amount: -2 });
    expect(parseRelativeTemporalTerm("3天前")).toEqual({ kind: "offset", unit: "day", amount: -3 });
  });

  it("maps seasons to a season term with a year offset", () => {
    expect(parseRelativeTemporalTerm("last summer")).toEqual({ kind: "season", season: "summer", yearOffset: -1 });
    expect(parseRelativeTemporalTerm("this winter")).toEqual({ kind: "season", season: "winter", yearOffset: 0 });
  });

  it("returns null for unmapped or absolute terms", () => {
    expect(parseRelativeTemporalTerm("tonight")).toBeNull();
    expect(parseRelativeTemporalTerm("2023-05")).toBeNull();
  });
});

describe("resolveRelativeTemporalWindow", () => {
  // 2023-05-17 is a Wednesday; its Monday-anchored week starts 2023-05-15.
  const anchorMs = Date.UTC(2023, 4, 17, 8, 30);

  it("resolves a Monday-anchored week range", () => {
    expect(resolveRelativeTemporalWindow({ kind: "offset", unit: "week", amount: -1 }, anchorMs)).toEqual({
      startMs: Date.UTC(2023, 4, 8),
      endMs: Date.UTC(2023, 4, 15) - 1,
      precision: "range"
    });
  });

  it("resolves a season range crossing the year boundary (winter Dec–Feb)", () => {
    expect(resolveRelativeTemporalWindow({ kind: "season", season: "winter", yearOffset: 0 }, anchorMs)).toEqual({
      startMs: Date.UTC(2023, 11, 1),
      endMs: Date.UTC(2024, 2, 1) - 1,
      precision: "range"
    });
  });

  it("resolves a prior-year season for 'last summer'", () => {
    expect(resolveRelativeTemporalWindow({ kind: "season", season: "summer", yearOffset: -1 }, anchorMs)).toEqual({
      startMs: Date.UTC(2022, 5, 1),
      endMs: Date.UTC(2022, 8, 1) - 1,
      precision: "range"
    });
  });
});
