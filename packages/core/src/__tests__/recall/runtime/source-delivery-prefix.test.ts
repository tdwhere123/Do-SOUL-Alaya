import { describe, expect, it } from "vitest";
import { sourceDeliveryPrefix } from "../../../recall/runtime/source-delivery-prefix.js";
import { sourceSemanticLibraryRawPreview } from "../../../recall/runtime/source-semantic-library-recall.js";

const fit = (text: string, cap: number, ends?: readonly number[]) =>
  sourceDeliveryPrefix(text, prefix => Buffer.byteLength(prefix) <= cap, ends);

describe("recorded source delivery prefixes", () => {
  it("uses the largest fitting recorded end and preserves UTF-8 fallback", () => {
    const text = "é\n猫\nlast message";
    expect(fit(text, 11, [3, 7, 19])).toBe("é\n猫\n");
    expect(fit(text, 2, [3, 7, 19])).toBe("é");
    expect(fit(text, 5, [])).toBe("é\n");
    expect(fit(text, 5)).toBe("é\n");
    expect(fit("a😀b", 4)).toBe("a");
    expect(fit("a😀b", 5)).toBe("a😀");
    expect(fit(text, 0, [3])).toBe("");
  });

  it("does not substitute finer ends when the selected coarse unit has no fitting end", () => {
    // The producer selected message ends; the line end at byte 3 is not supplied.
    expect(fit("aa\nbbb\ncc", 5, [7, 9])).toBe("aa\nbb");
  });

  it("keeps the library share while reusing the same literal alignment policy", () => {
    const text = `${"a".repeat(900)}\n${"b".repeat(1000)}\n`;
    expect(sourceSemanticLibraryRawPreview(text, 5, { status: "available", spans: [
      { purpose: "line", end_offset: 901 }, { purpose: "line", end_offset: 1902 }
    ] })).toBe(`${"a".repeat(900)}\n`);
    expect(sourceSemanticLibraryRawPreview(text, 5)).toHaveLength(1600);
  });

  it("preserves every prefix-contained authored evidence interval at each fixed budget", () => {
    // Authored source messages and evidence intervals are generated independently
    // of the fitter. Exhaustive small caps exercise budget transfer and zero fit.
    const variants = [["a", "猫", "bb"], ["é", "😀", "c"], ["abcd", "e", "fg"]];
    for (const messages of variants) {
      const units = [messages, [...messages].reverse(), ["long", ...messages]];
      const sources = units.map(parts => {
        let end = 0;
        const evidence = parts.map(part => {
          const start = end;
          end += Buffer.byteLength(`${part}\n`);
          return { start, end };
        });
        return { text: parts.map(part => `${part}\n`).join(""), evidence, size: end };
      });
      const total = sources.reduce((sum, source) => sum + source.size, 0);
      for (let cap = 1; cap <= total; cap++) for (let budget = 0; budget <= total; budget++) {
        let plainRemaining = budget, alignedRemaining = budget;
        for (const source of sources) {
          // Reference prefix consumes complete code points independently of the fitter.
          const plainLimit = Math.min(cap, plainRemaining);
          let plainEnd = 0;
          for (const codePoint of source.text) {
            const bytes = Buffer.byteLength(codePoint);
            if (plainEnd + bytes > plainLimit) break;
            plainEnd += bytes;
          }
          const alignedEnd = Buffer.byteLength(fit(source.text, Math.min(cap, alignedRemaining),
            source.evidence.map(interval => interval.end)));
          for (const interval of source.evidence) {
            if (interval.end <= plainEnd) expect(alignedEnd).toBeGreaterThanOrEqual(interval.end);
          }
          plainRemaining -= plainEnd;
          alignedRemaining -= alignedEnd;
        }
      }
    }
  });

  it("does not claim nested visibility across independently repacked budgets", () => {
    const pack = (budget: number) => {
      const first = fit("abcdefghij", budget, [5, 10]);
      return fit("xy", budget - first.length, [2]);
    };
    expect(pack(7)).toBe("xy");
    expect(pack(10)).toBe("");
    expect(pack(12)).toBe("xy");
  });
});
