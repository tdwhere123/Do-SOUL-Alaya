import { describe, expect, it } from "vitest";
import { buildExpandedKeywordQuery } from "../../recall/coarse-filter/coarse-candidates.js";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";

describe("recall query product semantics", () => {
  it("treats relative dates as default query semantics", () => {
    expect(compileRecallQueryProbes("What changed five days ago?").date_terms)
      .toContain("five days ago");
    expect(compileRecallQueryProbes("Who joined last Saturday?").date_terms)
      .toContain("last Saturday");
  });

  it("routes relationship concepts as lexical demand, not closed-vocab facet slice keys", () => {
    const probes = compileRecallQueryProbes("Which relative joined the sibling graduation?");
    const expandedQuery = buildExpandedKeywordQuery(probes) ?? "";
    expect(probes.lexical_terms).toEqual(expect.arrayContaining(["relative", "sibling"]));
    expect(expandedQuery.split(" ")).not.toEqual(expect.arrayContaining([
      "parent", "parents", "brother", "sister", "spouse", "wife"
    ]));
  });

  it("does not interpret a business partner as a personal relationship synonym", () => {
    const probes = compileRecallQueryProbes("Which business partner owns the integration?");
    expect(probes.lexical_terms).toEqual(expect.arrayContaining(["partner"]));
    expect(probes.expanded_terms).not.toEqual(expect.arrayContaining(["relative", "sibling"]));
  });

  it("keeps noun suffixes and irregular plurals free of fabricated stems", () => {
    expect(compileRecallQueryProbes("sibling ceiling family").expanded_terms)
      .toEqual(expect.arrayContaining(["siblings", "families"]));
    expect(compileRecallQueryProbes("sibling ceiling family").expanded_terms)
      .toEqual(expect.not.arrayContaining(["sibl", "sible", "ceil", "ceile", "familys"]));
  });
});
