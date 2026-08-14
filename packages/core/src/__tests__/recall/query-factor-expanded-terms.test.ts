import { describe, expect, it } from "vitest";
import type { OpenSemanticFactorFormationCapture } from "@do-soul/alaya-protocol";
import { materializeOpenSemanticFactorFormation } from
  "../../semantic/open-semantic-factor-formation.js";
import { buildExpandedKeywordQuery } from
  "../../recall/coarse-filter/coarse-candidates.js";
import { compileRecallQueryProbes } from
  "../../recall/query/recall-query-probes.js";
import { extendQueryProbesWithOpenSemanticFactors } from
  "../../recall/query/query-factor-expanded-terms.js";

describe("query-factor expanded terms", () => {
  it("adds formed query-factor identities that the surface query does not already carry", () => {
    const queryText = "How many cuisines have I learned to cook or tried out?";
    const probes = extendQueryProbesWithOpenSemanticFactors(
      compileRecallQueryProbes(queryText),
      formedQueryCapture(queryText, [
        ["learn.to.cook", "learned to cook", "learn to cook"],
        ["try.out", "tried out", "try out"]
      ])
    );

    expect(probes.lexical_terms).not.toEqual(expect.arrayContaining(["learn to cook"]));
    expect(probes.expanded_terms).toEqual(expect.arrayContaining(["learn to cook", "try out"]));
    expect(buildExpandedKeywordQuery(probes)?.split(/\s+/u)).toEqual(
      expect.arrayContaining(["learn", "cook"])
    );
  });

  it("leaves probes unchanged when query factors are absent", () => {
    const queryText = "How many cuisines have I tried?";
    const baseline = compileRecallQueryProbes(queryText);
    const unavailable = materializeOpenSemanticFactorFormation({
      source_kind: "query",
      source_text: queryText
    });

    expect(extendQueryProbesWithOpenSemanticFactors(baseline, unavailable))
      .toEqual(baseline);
    expect(extendQueryProbesWithOpenSemanticFactors(baseline, undefined))
      .toEqual(baseline);
  });

  it("keeps CJK query-factor identities that whitespace tokenizers would miss", () => {
    const queryText = "Where did I go in February?";
    const probes = extendQueryProbesWithOpenSemanticFactors(
      compileRecallQueryProbes(queryText),
      formedQueryCapture(queryText, [["visit.month", "February", "2月"]])
    );

    expect(probes.expanded_terms).toContain("2月");
    expect(buildExpandedKeywordQuery(probes)?.split(/\s+/u)).toContain("2月");
  });

  it("keeps query-factor extras inside the existing expanded-term FTS bound", () => {
    const extras = Array.from({ length: 20 }, (_, index) => `osfterm${index}`);
    const probes = extendQueryProbesWithOpenSemanticFactors(
      compileRecallQueryProbes("tried"),
      stubFormedCapture(extras)
    );
    const ftsTerms = new Set((buildExpandedKeywordQuery(probes) ?? "").split(/\s+/u));
    const admitted = extras.filter((identity) => ftsTerms.has(identity));

    expect(probes.expanded_terms.slice(0, 16)).toEqual(extras.slice(0, 16));
    expect(admitted).toHaveLength(16);
  });
});

function formedQueryCapture(
  sourceText: string,
  factors: ReadonlyArray<readonly [string, string, string]>
) {
  return materializeOpenSemanticFactorFormation({
    source_kind: "query",
    source_text: sourceText,
    proposal: {
      schema_version: 1,
      producer_operator_id: "open-factor-test-producer-v1",
      source_text: sourceText,
      graph: {
        schema_version: 1,
        source_kind: "query",
        factors: factors.map(([factorId, surface, identity]) => ({
          factor_id: factorId,
          surface,
          semantic_identity: identity
        })),
        variables: [{ variable_id: "answer", surface: sourceText.slice(0, 3).trim() || "how" }],
        result_variable_ids: ["answer"],
        propositions: [{
          proposition_id: "query",
          predicate_factor_id: factors[0]![0],
          arguments: [
            {
              position: 0,
              binding_identity: "agent",
              reference_kind: "variable",
              reference_id: "answer"
            },
            ...factors.slice(1).map(([factorId], index) => ({
              position: index + 1,
              binding_identity: `argument-${index + 1}`,
              reference_kind: "factor" as const,
              reference_id: factorId
            }))
          ]
        }]
      }
    }
  });
}

function stubFormedCapture(
  identities: readonly string[]
): OpenSemanticFactorFormationCapture {
  return {
    status: "formed",
    graph: {
      factors: identities.map((identity, index) => ({
        factor_id: `factor.${index}`,
        surface: identity,
        semantic_identity: identity
      }))
    }
  } as OpenSemanticFactorFormationCapture;
}
