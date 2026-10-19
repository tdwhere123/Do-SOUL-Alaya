import { describe, expect, it } from "vitest";
import { indexSourceSemanticUnits, type SourceSemanticSourceUnit } from "../../../garden/ingestion/official-api/source-semantic-units.js";

const MAX_UNITS_PER_RANGE = 4;

/** Consecutive same-role runs of at most four units, as contiguous exact ranges of the source. */
function contiguousRanges(units: readonly SourceSemanticSourceUnit[]) {
  const ranges: SourceSemanticSourceUnit[][] = [];
  for (const unit of units) {
    const last = ranges.at(-1);
    if (last === undefined || last[0]!.source_role !== unit.source_role || last.length === MAX_UNITS_PER_RANGE) ranges.push([unit]);
    else last.push(unit);
  }
  return ranges;
}

function spans(units: readonly Pick<SourceSemanticSourceUnit, "start" | "end">[], offset = 0) {
  return units.map((unit) => [unit.start + offset, unit.end + offset]);
}

/** Boundaries recomputed from only each range's own text, translated back to source offsets. */
function boundariesRecomputedPerRange(source: string) {
  const whole = indexSourceSemanticUnits(source, "assistant");
  return contiguousRanges(whole).map((range) => {
    const start = range[0]!.start;
    const recomputed = indexSourceSemanticUnits(source.slice(start, range.at(-1)!.end), range[0]!.source_role);
    return { expected: spans(range), actual: spans(recomputed, start) };
  });
}

describe("source semantic unit boundaries within contiguous source ranges", () => {
  it("places CRLF-separated units at hand-derived offsets", () => {
    const source = "Alpha opens.\r\nBeta closes.\r\nGamma waits.";
    expect(spans(indexSourceSemanticUnits(source, "assistant"))).toEqual([[0, 12], [14, 26], [28, 40]]);
    expect(boundariesRecomputedPerRange(source)).toEqual([{ expected: [[0, 12], [14, 26], [28, 40]], actual: [[0, 12], [14, 26], [28, 40]] }]);
  });

  it("counts non-BMP characters as two UTF-16 units in hand-derived offsets", () => {
    const source = "Moon 🌙 shines. 雨停了。";
    expect(spans(indexSourceSemanticUnits(source, "assistant"))).toEqual([[0, 15], [16, 20]]);
    expect(boundariesRecomputedPerRange(source)).toEqual([{ expected: [[0, 15], [16, 20]], actual: [[0, 15], [16, 20]] }]);
  });

  it.each([
    ["mixed line endings", "One.\nTwo.\r\nThree.\rFour.\n\r\nFive? Six!\r"],
    ["non-BMP and CJK", "The moon 🌙 shines. 雨停了。风吹来！𝒳 is a symbol. Café 😀 opens. 你好吗？Fine 🎉."],
    ["abbreviations and decimals", "Dr. Smith met Mr. Jones at 3.14 p.m. in the U.S. office. See e.g. Fig. 2 and approx. 5. Done. Version 1.2.3 shipped."],
    ["duplicate sentences", "Same sentence. Same sentence. Same sentence. Same sentence. Same sentence. Same sentence.\nSame sentence.\nSame sentence."],
    ["quoted role markers", "Assistant: Alpha ends. Beta ends. Gamma ends. Delta ends. User: quoted marker. Epsilon ends.\nZeta ends."]
  ])("recomputes identical boundaries inside every four-unit range for %s", (_name, source) => {
    const ranges = boundariesRecomputedPerRange(source);
    expect(ranges.length).toBeGreaterThan(1);
    for (const { expected, actual } of ranges) expect(actual).toEqual(expected);
  });

  it("does not reproduce a boundary whose classification looks behind into the preceding unit", () => {
    const source = "Done..Next one here.";
    expect(spans(indexSourceSemanticUnits(source, "assistant"))).toEqual([[0, 5], [5, 20]]);
    // The second range read alone splits its leading dot because the glued previous dot is outside the range.
    const alone = indexSourceSemanticUnits(source.slice(5), "assistant");
    expect(spans(alone, 5)).toEqual([[5, 6], [6, 20]]);
  });

  it("gives a quoted role marker at a range start the range-local default role", () => {
    const source = "Assistant: Alpha ends. Beta ends. Gamma ends. Delta ends. User: quoted marker. Epsilon ends.";
    const whole = indexSourceSemanticUnits(source);
    expect(whole.map((unit) => unit.source_role)).toEqual(Array(6).fill("assistant"));
    const second = contiguousRanges(whole)[1]!;
    const alone = indexSourceSemanticUnits(source.slice(second[0]!.start, second.at(-1)!.end));
    expect(alone.map((unit) => unit.source_role)).toEqual(["user", "user"]);
  });
});
