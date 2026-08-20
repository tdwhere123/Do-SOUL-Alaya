import { describe, expect, it } from "vitest";
import type { OpenSemanticFactorFormationCapture } from "@do-soul/alaya-protocol";
import { materializeOpenSemanticFactorFormation } from
  "../../semantic/open-semantic-factor-formation.js";
import { buildExpandedKeywordQuery } from
  "../../recall/coarse-filter/coarse-candidates.js";
import { compileRecallQueryProbes } from
  "../../recall/query/recall-query-probes.js";
import {
  extendQueryProbesWithOpenSemanticFactors,
  queryFactorFtsExtraEligibility
} from
  "../../recall/query/query-factor-expanded-terms.js";
import { materializeOpenSemanticFactorCompatibilityTrace } from
  "../../recall/field/open-semantic-factors/compatibility-trace.js";
import { materializeOpenSemanticFactorComposition } from
  "../../recall/field/open-semantic-factors/composition.js";

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
    expect(probes.expanded_terms).toEqual(expect.arrayContaining(["learn cook", "try out"]));
    expect(probes.expanded_terms).not.toContain("learn to cook");
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
    const noise = ["be", "i", "was", "in", "to", "me"];
    const probes = extendQueryProbesWithOpenSemanticFactors(
      compileRecallQueryProbes("tried"),
      stubFormedCapture([...noise, ...extras])
    );
    const ftsTerms = new Set((buildExpandedKeywordQuery(probes) ?? "").split(/\s+/u));
    const admitted = extras.filter((identity) => ftsTerms.has(identity));

    expect(probes.expanded_terms).not.toEqual(expect.arrayContaining(noise));
    expect(probes.expanded_terms.slice(0, 16)).toEqual(extras.slice(0, 16));
    expect(admitted).toHaveLength(16);
  });

  it("drops copular identities from the cached Japan query compilation", () => {
    const queryText = "How long was I in Japan for?";
    const probes = extendQueryProbesWithOpenSemanticFactors(
      compileRecallQueryProbes(queryText),
      formedQueryCapture(queryText, [
        ["copula.be", "was", "be"],
        ["agent.i", "I", "i"],
        ["loc.in.japan", "in Japan", "in japan"]
      ])
    );

    expect(probes.expanded_terms).not.toEqual(expect.arrayContaining(["be", "i", "was"]));
    expect(probes.expanded_terms).not.toContain("in japan");
  });

  it("keeps qualifying phrase tokens after dropping stop tokens", () => {
    const probes = extendQueryProbesWithOpenSemanticFactors(
      compileRecallQueryProbes("How long was the trip?"),
      stubFormedCapture(["in japan"])
    );

    expect(probes.expanded_terms).toContain("japan");
    expect(probes.expanded_terms).not.toContain("in japan");
    expect(buildExpandedKeywordQuery(probes)?.split(/\s+/u)).toContain("japan");
    expect(buildExpandedKeywordQuery(probes)?.split(/\s+/u)).not.toContain("in");
  });

  it("keeps formed extras eligible after composition no_match on both diagnostic arms", () => {
    const queryText = "How long is my daily commute to work?";
    const formed = formedQueryCapture(queryText, [
      ["copula.be", "is", "be"],
      ["subject.commute", "my daily commute to work", "daily commute"]
    ]);
    const disjoint = materializeOpenSemanticFactorFormation({
      source_kind: "evidence",
      source_text: "Alice likes tea.",
      proposal: {
        schema_version: 1,
        producer_operator_id: "open-factor-test-producer-v1",
        source_text: "Alice likes tea.",
        graph: {
          schema_version: 2,
          source_kind: "evidence",
          factors: [
            { factor_id: "alice", surface: "Alice", semantic_identity: "alice" },
            { factor_id: "likes", surface: "likes", semantic_identity: "like" },
            { factor_id: "tea", surface: "tea", semantic_identity: "tea" }
          ],
          variables: [],
          result_variable_ids: [],
          propositions: [{
            proposition_id: "likes-tea",
            predicate_factor_id: "likes",
            arguments: [
              {
                position: 0,
                binding_identity: "agent",
                reference_kind: "factor",
                reference_id: "alice"
              },
              {
                position: 1,
                binding_identity: "object",
                reference_kind: "factor",
                reference_id: "tea"
              }
            ]
          }]
        }
      }
    });
    const composition = materializeOpenSemanticFactorComposition({
      trace: materializeOpenSemanticFactorCompatibilityTrace({
        query_capture: formed,
        evidence_formations: { disjoint }
      }),
      query_capture: formed
    });
    const treatment = extendQueryProbesWithOpenSemanticFactors(
      compileRecallQueryProbes(queryText), formed
    );
    const control = extendQueryProbesWithOpenSemanticFactors(
      compileRecallQueryProbes(queryText), undefined
    );

    expect(composition.status).toBe("no_match");
    expect(queryFactorFtsExtraEligibility(formed)).toBe("formed");
    expect(queryFactorFtsExtraEligibility(undefined)).toBe("not_formed");
    expect(treatment.expanded_terms).toEqual(expect.arrayContaining(["daily commute"]));
    expect(control.expanded_terms).not.toContain("daily commute");
    const added = treatment.expanded_terms.filter((term) =>
      !control.expanded_terms.includes(term));
    expect({
      treatment_formation: formed.status,
      treatment_composition: composition.status,
      added_expanded_terms: added
    }).toMatchObject({
      treatment_formation: "formed",
      treatment_composition: "no_match",
      added_expanded_terms: expect.arrayContaining(["daily commute"])
    });
  });

  it.each([
    "rejected",
    "unavailable",
    "ineligible"
  ] as const)("does not admit extras from a %s capture", (status) => {
    const queryText = "How long is my daily commute to work?";
    const capture = status === "ineligible"
      ? materializeOpenSemanticFactorFormation({ source_kind: "query", source_text: null })
      : status === "unavailable"
        ? materializeOpenSemanticFactorFormation({
          source_kind: "query",
          source_text: queryText
        })
        : materializeOpenSemanticFactorFormation({
          source_kind: "query",
          source_text: queryText,
          proposal: { schema_version: 1, producer_operator_id: "x", source_text: "other" }
        });
    expect(capture.status).toBe(status);
    expect(queryFactorFtsExtraEligibility(capture)).toBe("not_formed");
    expect(extendQueryProbesWithOpenSemanticFactors(
      compileRecallQueryProbes(queryText), capture
    )).toEqual(compileRecallQueryProbes(queryText));
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
        schema_version: 2,
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
