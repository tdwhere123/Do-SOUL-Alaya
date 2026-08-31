import { describe, expect, it } from "vitest";
import { compareCodeUnits } from "@do-soul/alaya-protocol";
import { compareText, sameTextSet } from "../../shared/compare-text.js";

describe("compareText", () => {
  it("sorts Z before a by UTF-16 code unit", () => {
    expect(compareText("Z", "a")).toBeLessThan(0);
    expect(["a", "Z"].sort(compareText)).toEqual(["Z", "a"]);
  });

  it("sorts mem-1 before mem_1 by code unit, not locale", () => {
    expect(compareText("mem-1", "mem_1")).toBeLessThan(0);
    expect(["mem_1", "mem-1"].sort(compareText)).toEqual(["mem-1", "mem_1"]);
  });

  it("is the protocol code-unit comparator", () => {
    expect(compareText("Z", "a")).toBe(compareCodeUnits("Z", "a"));
    expect(compareText("mem-1", "mem_1")).toBe(compareCodeUnits("mem-1", "mem_1"));
    expect(compareText("foo", "Foo")).toBe(compareCodeUnits("foo", "Foo"));
  });
});

describe("sameTextSet", () => {
  it("treats composed and decomposed members as distinct and order independent", () => {
    const composed: string = "\u00e9";
    const decomposed: string = "e\u0301";
    expect(composed === decomposed).toBe(false);
    expect(composed.localeCompare(decomposed)).toBe(0);

    expect(sameTextSet([composed, decomposed], [decomposed, composed])).toBe(true);
    expect(sameTextSet([composed], [decomposed])).toBe(false);
    expect([...[composed, decomposed]].sort(compareText)).toEqual([decomposed, composed]);
  });
});
