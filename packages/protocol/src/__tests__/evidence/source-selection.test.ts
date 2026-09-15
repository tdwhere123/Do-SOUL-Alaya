import { describe, expect, it } from "vitest";
import { findSourceTextOccurrence } from "../../evidence/source-selection.js";

describe("source text occurrence", () => {
  it("does not count overlapping matches", () => {
    expect(findSourceTextOccurrence("aaa", "aa", 0)).toEqual([0, 2]);
    expect(findSourceTextOccurrence("aaa", "aa", 1)).toBeNull();
  });

  it("advances ordinary repeated words by surface length", () => {
    const source = "I cook and I cook pasta.";
    expect(findSourceTextOccurrence(source, "cook", 0)).toEqual([2, 6]);
    expect(findSourceTextOccurrence(source, "cook", 1)).toEqual([13, 17]);
    expect(findSourceTextOccurrence(source, "cook", 2)).toBeNull();
  });

  it("uses UTF-16 offsets for CJK and emoji surfaces", () => {
    expect(findSourceTextOccurrence("学学", "学", 0)).toEqual([0, 1]);
    expect(findSourceTextOccurrence("学学", "学", 1)).toEqual([1, 2]);
    expect(findSourceTextOccurrence("😀😀", "😀", 0)).toEqual([0, 2]);
    expect(findSourceTextOccurrence("😀😀", "😀", 1)).toEqual([2, 4]);
    expect(findSourceTextOccurrence("😀😀", "😀", 2)).toBeNull();
  });
});
