import { describe, expect, it } from "vitest";
import { stableStringify } from "../../shared/stable-stringify.js";

describe("stableStringify", () => {
  it("canonicalizes composed and decomposed object keys independent of insertion order", () => {
    const composed = "\u00e9";
    const decomposed = "e\u0301";
    expect(composed).not.toBe(decomposed);

    const forward = { [composed]: 1, [decomposed]: 2 };
    const reverse = { [decomposed]: 2, [composed]: 1 };

    expect(stableStringify(forward)).toBe(stableStringify(reverse));
    expect(stableStringify(forward)).toBe(`{${decomposed}:2,${composed}:1}`);
  });

  it("canonicalizes nested objects independently", () => {
    const composed = "\u00e9";
    const decomposed = "e\u0301";
    const forward = {
      [composed]: { [composed]: 1, [decomposed]: 2 },
      [decomposed]: { [composed]: 3, [decomposed]: 4 }
    };
    const reverse = {
      [decomposed]: { [decomposed]: 4, [composed]: 3 },
      [composed]: { [decomposed]: 2, [composed]: 1 }
    };

    expect(stableStringify(forward)).toBe(stableStringify(reverse));
    expect(stableStringify(forward)).toBe(
      `{${decomposed}:{${decomposed}:4,${composed}:3},${composed}:{${decomposed}:2,${composed}:1}}`
    );
  });

  it("preserves array element order", () => {
    const composed = "\u00e9";
    const decomposed = "e\u0301";

    expect(stableStringify(["Z", "a"])).toBe('["Z","a"]');
    expect(stableStringify([composed, decomposed])).toBe(
      `[${JSON.stringify(composed)},${JSON.stringify(decomposed)}]`
    );
    expect(stableStringify([{ [composed]: 1, [decomposed]: 2 }, { z: 1, a: 2 }])).toBe(
      `[{${decomposed}:2,${composed}:1},{a:2,z:1}]`
    );
  });
});
