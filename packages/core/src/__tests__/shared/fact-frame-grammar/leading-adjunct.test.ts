import { describe, expect, it } from "vitest";
import { skipLeadingAdjunctSpan } from
  "../../../shared/fact-frame-grammar/leading-adjunct.js";
import { tokenizeFactFrameSource } from
  "../../../shared/fact-frame-grammar/source-text.js";

const SUBJECTS = new Set(["i", "you", "he", "she", "it", "we", "they"]);

function isSubjectStart(
  tokens: ReturnType<typeof tokenizeFactFrameSource>,
  index: number
): boolean {
  const token = tokens[index];
  if (token === undefined) return false;
  if (SUBJECTS.has(token.normalized)) return true;
  const apostrophe = token.text.search(/['\u2019]/u);
  if (apostrophe <= 0) return false;
  return SUBJECTS.has(token.text.slice(0, apostrophe).toLowerCase());
}

function subjectIndex(source: string): number {
  const tokens = tokenizeFactFrameSource(source);
  return skipLeadingAdjunctSpan(
    tokens,
    (index) => isSubjectStart(tokens, index)
  );
}

describe("skipLeadingAdjunctSpan", () => {
  it("locates a pronoun subject after a single prepositional adjunct", () => {
    const source = "By the way, I took my niece to the museum";
    const tokens = tokenizeFactFrameSource(source);
    expect(tokens[subjectIndex(source)]?.normalized).toBe("i");
  });

  it("does not walk through a nested after-clause to a later pronoun", () => {
    const source = "By the way, after I visited the museum, I ate lunch.";
    expect(subjectIndex(source)).toBe(0);
  });

  it("does not walk through an interrogative after an adjunct", () => {
    const source = "By the way, do you know of any good resources";
    expect(subjectIndex(source)).toBe(0);
  });

  it("fails closed at a finite clause inside the span rather than latching a later pronoun", () => {
    const source =
      "By the way, The Book of Mormon is another musical theater soundtrack I've been listening to on my daily commute";
    expect(subjectIndex(source)).toBe(0);
  });

  it("does not treat a CJK topic as an adjunct before an English subject", () => {
    expect(subjectIndex("博物馆 I visited the Louvre yesterday.")).toBe(0);
    expect(subjectIndex("对了 I took my niece to the museum.")).toBe(0);
  });

  it("keeps walking through a following PP until the matrix subject", () => {
    const source = "By the way on Tuesday I went to the museum";
    const tokens = tokenizeFactFrameSource(source);
    expect(tokens[subjectIndex(source)]?.normalized).toBe("i");
  });
});
