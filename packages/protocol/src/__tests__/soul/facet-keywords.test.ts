import { describe, expect, it } from "vitest";
import { deriveFacetsFromText } from "../../soul/facet-keywords.js";
import { FACET_VOCABULARY } from "../../soul/memory-entry.js";

describe("deriveFacetsFromText", () => {
  it("maps occupation keywords to occupation_work", () => {
    expect(deriveFacetsFromText("Where does she work?")).toContain("occupation_work");
  });

  it("derives multiple facets from one text", () => {
    const facets = deriveFacetsFromText("She prefers spicy food at her favorite restaurant.");
    expect(facets).toContain("preference_like");
    expect(facets).toContain("food_dining");
  });

  it("returns only ids present in FACET_VOCABULARY", () => {
    const facets = deriveFacetsFromText("job school live event when prefer own friend health money");
    expect(facets.length).toBeGreaterThan(0);
    for (const facet of facets) {
      expect(FACET_VOCABULARY).toContain(facet);
    }
  });

  it("returns empty for text with no facet keywords", () => {
    expect(deriveFacetsFromText("xyzzy qux blorp")).toEqual([]);
  });

  it("returns empty for empty text", () => {
    expect(deriveFacetsFromText("")).toEqual([]);
  });
});
