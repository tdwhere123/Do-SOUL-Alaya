import { describe, expect, it } from "vitest";
import type { BenchSignalSeedInput } from "../../../harness/daemon.js";
import { isGoldAuthorityFieldKey } from "../../../harness/seeding/compile-gold-fields.js";
import { attachCompileSourceGrounding } from "../../../harness/seeding/source-grounding.js";

describe("compile source-bound semantic factor fields", () => {
  it("keeps a source-bound OSF graph only when grounding succeeds", () => {
    const assertion = "I redeemed a coupon last Sunday";
    const turnContent =
      "User: I redeemed a coupon last Sunday, which surprised me because I had forgotten it.\n" +
      "Assistant: Nice find.";
    const payload = attachCompileSourceGrounding(
      { matched_text: assertion, semantic_factor_graph: sourceGraph(assertion) },
      signalInput(turnContent, assertion)
    );

    expect(payload.source_grounding).toMatchObject({ status: "grounded" });
    expect(payload.semantic_factor_graph).toMatchObject({ source_kind: "evidence" });
    expect(payload).not.toHaveProperty("semantic_factor_graph_projection");
  });

  it("fails closed for graphless, unbound, identity, and rejected-grounding OSF payloads", () => {
    const assertion = "I prefer dark mode.";
    const turnContent = `User: ${assertion}\nAssistant: Noted.`;
    const graphless = attachCompileSourceGrounding(
      { matched_text: assertion },
      signalInput(turnContent, assertion)
    );
    expect(graphless.source_grounding).toMatchObject({ status: "grounded" });
    expect(graphless).not.toHaveProperty("semantic_factor_graph");
    expect(graphless.semantic_factor_graph_projection).toEqual({
      status: "unavailable",
      reason: "semantic_factor_graph_missing"
    });

    const valid = sourceGraph(assertion);
    const unbound = attachCompileSourceGrounding(
      {
        matched_text: assertion,
        semantic_factor_graph: {
          ...valid,
          factors: [
            ...valid.factors,
            { factor_id: "unused", surface: "mode", semantic_identity: "mode" }
          ]
        }
      },
      signalInput(turnContent, assertion)
    );
    expect(unbound).not.toHaveProperty("semantic_factor_graph");
    expect(unbound.semantic_factor_graph_projection).toEqual({
      status: "rejected",
      reason: "semantic_factor_graph_invalid_unbound"
    });

    const identity = attachCompileSourceGrounding(
      {
        matched_text: assertion,
        semantic_factor_graph: {
          ...valid,
          factors: valid.factors.map((factor) => ({
            ...factor,
            semantic_identity: "Prefer"
          }))
        }
      },
      signalInput(turnContent, assertion)
    );
    expect(identity).not.toHaveProperty("semantic_factor_graph");
    expect(identity.semantic_factor_graph_projection).toEqual({
      status: "rejected",
      reason: "semantic_factor_graph_invalid_identity"
    });

    const rejected = attachCompileSourceGrounding(
      {
        matched_text: "not present in the turn",
        semantic_factor_graph: valid,
        gold_semantic_factor_graph: valid,
        gold_osf_ids: ["gold-1"]
      },
      signalInput(turnContent, assertion)
    );
    expect(rejected.source_grounding).toMatchObject({ status: "rejected" });
    expect(rejected).not.toHaveProperty("semantic_factor_graph");
    expect(rejected.semantic_factor_graph_projection).toMatchObject({
      status: "rejected"
    });
    expect(hasGoldPrefixedKey(rejected)).toBe(false);
  });

  it("does not rebuild an OSF graph from gold-shaped compile fields", () => {
    const assertion = "I prefer dark mode.";
    const turnContent = `User: ${assertion}\nAssistant: Noted.`;
    const payload = attachCompileSourceGrounding(
      {
        matched_text: assertion,
        gold_semantic_factor_graph: sourceGraph(assertion),
        gold_osf_ids: ["gold-1"],
        gold_answer: assertion
      },
      signalInput(turnContent, assertion)
    );

    expect(payload.source_grounding).toMatchObject({ status: "grounded" });
    expect(payload).not.toHaveProperty("semantic_factor_graph");
    expect(payload.semantic_factor_graph_projection).toEqual({
      status: "unavailable",
      reason: "semantic_factor_graph_missing"
    });
    expect(hasGoldPrefixedKey(payload)).toBe(false);
  });
});

function hasGoldPrefixedKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasGoldPrefixedKey);
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(([key, child]) =>
    isGoldAuthorityFieldKey(key) || hasGoldPrefixedKey(child));
}

function signalInput(turnContent: string, matchedText: string): BenchSignalSeedInput {
  return {
    signalKind: "potential_claim",
    objectKind: "activity",
    confidence: 0.9,
    distilledFact: matchedText,
    turnContent,
    matchedText,
    evidenceRef: "message-1",
    turnSeedIndex: 0,
    extractionProvider: "official_api_compile"
  };
}

function sourceGraph(surface: string) {
  const semanticIdentity = surface.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
  return {
    schema_version: 2 as const,
    source_kind: "evidence" as const,
    factors: [{
      factor_id: "fact",
      surface,
      semantic_identity: semanticIdentity
    }],
    variables: [],
    result_variable_ids: [],
    propositions: [{
      proposition_id: "fact-proposition",
      predicate_factor_id: "fact",
      arguments: [{
        position: 0,
        binding_identity: "fact",
        reference_kind: "factor" as const,
        reference_id: "fact"
      }]
    }]
  };
}
