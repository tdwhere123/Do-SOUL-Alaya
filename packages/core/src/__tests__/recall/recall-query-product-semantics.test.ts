import { describe, expect, it } from "vitest";
import { buildExpandedKeywordQuery } from "../../recall/coarse-filter/coarse-candidates.js";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import { deriveQuerySoughtFacets } from "../../recall/query/query-facet-router.js";

describe("recall query product semantics", () => {
  it("treats relative dates as default query semantics", () => {
    expect(compileRecallQueryProbes("What changed five days ago?").date_terms)
      .toContain("five days ago");
    expect(compileRecallQueryProbes("Who joined last Saturday?").date_terms)
      .toContain("last Saturday");
  });

  it("routes relationship concepts through facets without lexical family fitting", () => {
    const probes = compileRecallQueryProbes("Which relative joined the sibling graduation?");
    const expandedQuery = buildExpandedKeywordQuery(probes) ?? "";
    expect(deriveQuerySoughtFacets(probes)).toContain("relationship_person");
    expect(expandedQuery.split(" ")).not.toEqual(expect.arrayContaining([
      "parent", "parents", "brother", "sister", "spouse", "wife"
    ]));
  });

  it("does not interpret a business partner as a personal relationship", () => {
    const probes = compileRecallQueryProbes("Which business partner owns the integration?");
    expect(deriveQuerySoughtFacets(probes)).not.toContain("relationship_person");
  });

  it("keeps noun suffixes and irregular plurals free of fabricated stems", () => {
    expect(compileRecallQueryProbes("sibling ceiling family").expanded_terms)
      .toEqual(expect.arrayContaining(["siblings", "families"]));
    expect(compileRecallQueryProbes("sibling ceiling family").expanded_terms)
      .toEqual(expect.not.arrayContaining(["sibl", "sible", "ceil", "ceile", "familys"]));
  });
});
