import { describe, expect, it } from "vitest";
import { ASSOCIATION_DOMAIN_ID, type FacetVector } from "@do-soul/alaya-protocol";
import {
  evaluateFacetPredicate,
  evaluateSamePathPredicate
} from "../../../../recall/conditional-field/engine/facet-predicates.js";
import {
  evaluateFacetPredicate as evaluateFacetPredicateFromIndex,
  evaluateSamePathPredicate as evaluateSamePathPredicateFromIndex
} from "../../../../recall/conditional-field/index/project-accepting-index.js";
import {
  evaluateFacetPredicate as evaluateFacetPredicateFromReference,
  evaluateSamePathPredicate as evaluateSamePathPredicateFromReference
} from "../../../../recall/conditional-field/reference/accepting-projection.js";
import {
  interpretationCoverage,
  interpretationCoverageFor,
  interpretationCoverageOf
} from "../../../../recall/conditional-field/engine/interpretation-coverage.js";
import { interpretationCoverageFor as interpretationCoverageForFromReference } from
  "../../../../recall/conditional-field/reference/interpret-query.js";
import {
  interpretationCoverage as interpretationCoverageFromIndex,
  interpretationCoverageOf as interpretationCoverageOfFromIndex
} from "../../../../recall/conditional-field/index/completeness.js";

describe("facet predicate and interpretation coverage authority", () => {
  it("re-exports the same facet predicate implementation from engine, reference, and index", () => {
    expect(evaluateFacetPredicateFromReference).toBe(evaluateFacetPredicate);
    expect(evaluateFacetPredicateFromIndex).toBe(evaluateFacetPredicate);
    expect(evaluateSamePathPredicateFromReference).toBe(evaluateSamePathPredicate);
    expect(evaluateSamePathPredicateFromIndex).toBe(evaluateSamePathPredicate);
  });

  it("re-exports the same interpretation coverage implementation from engine, reference, and index", () => {
    expect(interpretationCoverageForFromReference).toBe(interpretationCoverageFor);
    expect(interpretationCoverageFromIndex).toBe(interpretationCoverage);
    expect(interpretationCoverageOfFromIndex).toBe(interpretationCoverageOf);
  });

  it("treats unbound holes as open when that flag is passed in", () => {
    const named = [
      { obligation_id: "ob-x", domain_id: ASSOCIATION_DOMAIN_ID },
      { obligation_id: "ob-y", domain_id: ASSOCIATION_DOMAIN_ID }
    ] as const;
    const vectors: FacetVector[] = [
      { schema_version: 1, path_id: "p1", obligations: named, coordinates: [900, 200] },
      { schema_version: 1, path_id: "p2", obligations: named, coordinates: [200, 900] }
    ];
    expect(evaluateFacetPredicate("same_path", vectors, 800)).toBe(false);
    expect(evaluateFacetPredicate("independent", vectors, 800)).toBe(true);
    expect(interpretationCoverage("resolved", true)).toBe("open");
    expect(interpretationCoverage("resolved", false)).toBe("complete");
    expect(interpretationCoverageFor("resolved", {
      holes: [{ schema_version: 1, hole_id: "h", status: "open", variable: "x" }]
    })).toBe("open");
    expect(interpretationCoverageOf("resolved")).toBe("complete");
  });
});
