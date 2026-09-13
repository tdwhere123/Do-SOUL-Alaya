import { describe, expect, it } from "vitest";
import { canonicalJson } from "@do-soul/alaya-protocol";
import { stableStringify } from "../../shared/stable-stringify.js";

describe("stableStringify", () => {
  it("canonicalizes composed and decomposed object keys independent of insertion order", () => {
    const composed = "\u00e9";
    const decomposed = "e\u0301";
    expect(composed).not.toBe(decomposed);

    const forward = { [composed]: 1, [decomposed]: 2 };
    const reverse = { [decomposed]: 2, [composed]: 1 };

    expect(stableStringify(forward)).toBe(stableStringify(reverse));
    expect(stableStringify(forward)).toBe(
      `{${JSON.stringify(decomposed)}:2,${JSON.stringify(composed)}:1}`
    );
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
      `{${JSON.stringify(decomposed)}:{${JSON.stringify(decomposed)}:4,${JSON.stringify(composed)}:3},${JSON.stringify(composed)}:{${JSON.stringify(decomposed)}:2,${JSON.stringify(composed)}:1}}`
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
      `[{${JSON.stringify(decomposed)}:2,${JSON.stringify(composed)}:1},{"a":2,"z":1}]`
    );
  });

  it("matches protocol canonicalJson for mixed-case and empty keys", () => {
    const value = { a: 1, B: 2, "": 0 };
    expect(stableStringify(value)).toBe(canonicalJson(value));
    expect(stableStringify(value)).toBe('{"":0,"B":2,"a":1}');
  });
});
