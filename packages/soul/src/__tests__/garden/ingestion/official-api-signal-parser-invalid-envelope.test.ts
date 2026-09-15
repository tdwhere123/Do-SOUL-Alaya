import { describe, expect, it } from "vitest";
import { identityObservationEqualityKey } from "@do-soul/alaya-protocol";
import { parseOfficialApiSignals } from "../../../garden/ingestion/compute-provider.js";
import { withOpenSemanticFactorGraph } from "./compute-provider-fixtures.js";

describe("parseOfficialApiSignals invalid envelope rejection", () => {
  it("throws when signals is not an array", () => {
    expect(() => parseOfficialApiSignals(JSON.stringify({ signals: "not-an-array" }))).toThrow(
      /signals array missing/u
    );
  });

  it("throws when the envelope omits signals", () => {
    expect(() => parseOfficialApiSignals(JSON.stringify({ oops: [] }))).toThrow(
      /signals array missing/u
    );
  });

  it("throws when the parsed top-level value is not an object", () => {
    expect(() => parseOfficialApiSignals(JSON.stringify(["not", "an", "envelope"]))).toThrow(
      /signals array missing/u
    );
  });

  it("admits a valid candidate core while recording a missing graph projection", () => {
    expect(parseOfficialApiSignals(JSON.stringify({ signals: [{
      confidence: 0.8,
      matched_text: "private source text"
    }] }))).toMatchObject([{
      matched_text: "private source text",
      semantic_factor_graph_projection: {
        status: "unavailable",
        reason: "semantic_factor_graph_missing"
      }
    }]);
  });

  it("records an invalid graph projection while rejecting an invalid candidate core", () => {
    const otherwiseValid = withOpenSemanticFactorGraph({
      confidence: 0.8,
      matched_text: "source text"
    });
    expect(parseOfficialApiSignals(JSON.stringify({ signals: [{
      ...otherwiseValid,
      semantic_factor_graph: {}
    }] }))).toMatchObject([{
      matched_text: "source text",
      semantic_factor_graph_projection: {
        status: "rejected",
        reason: "semantic_factor_graph_invalid_shape"
      }
    }]);
    expect(() => parseOfficialApiSignals(JSON.stringify({ signals: [{
      ...otherwiseValid,
      matched_text: undefined
    }] }))).toThrow(/signal_entry_invalid:1/u);
  });

  it("reports which semantic graph collection violates its cardinality", () => {
    const otherwiseValid = withOpenSemanticFactorGraph({
      confidence: 0.8,
      matched_text: "source text"
    });
    expect(parseOfficialApiSignals(JSON.stringify({ signals: [{
      ...otherwiseValid,
      semantic_factor_graph: {
        ...otherwiseValid.semantic_factor_graph,
        factors: [],
        propositions: []
      }
    }] }))).toMatchObject([{
      semantic_factor_graph_projection: {
        status: "rejected",
        reason: "semantic_factor_graph_invalid_propositions_too_few"
      }
    }]);
  });

  it("keeps the base graph when kind_projection is missing or invalid", () => {
    const otherwiseValid = withOpenSemanticFactorGraph({
      confidence: 0.8,
      matched_text: "I use Spotify"
    });
    expect(parseOfficialApiSignals(JSON.stringify({
      signals: [{ ...otherwiseValid, kind_projection: { factor_id: "spotify" } }]
    }))[0]).not.toHaveProperty("kind_projection");
    expect(parseOfficialApiSignals(JSON.stringify({
      signals: [{
        ...otherwiseValid,
        kind_projection: { factor_id: "spotify", kind_values: ["Music Streaming Service"] }
      }]
    }))).toMatchObject([{
      matched_text: "I use Spotify",
      kind_projection: {
        factor_id: "spotify",
        kind_values: ["music streaming service"]
      }
    }]);
  });

  it("keeps independently grounded mentions when topology has an unrelated illegal factor", () => {
    const source = "I used Atlas for research.";
    const legal = withOpenSemanticFactorGraph({
      object_kind: "activity",
      confidence: 0.9,
      matched_text: source
    }).semantic_factor_graph;
    const [draft] = parseOfficialApiSignals(JSON.stringify({
      signals: [{
        object_kind: "activity",
        confidence: 0.9,
        matched_text: source,
        semantic_factor_graph: {
          ...legal,
          factors: [
            { factor_id: "actor", surface: "I", semantic_identity: "i" },
            { factor_id: "predicate", surface: "used", semantic_identity: "use" },
            { factor_id: "object", surface: "Atlas", semantic_identity: "atlas" },
            { factor_id: "bad", surface: "research", semantic_identity: "NOT-CANONICAL" }
          ]
        }
      }]
    }));
    expect(draft?.semantic_factor_graph).toBeUndefined();
    expect(draft?.semantic_factor_graph_projection).toMatchObject({ status: "rejected" });
    expect(draft?.identity_observation?.producer).toBe("official-api-identity-observation-v1");
    expect(draft?.identity_observation?.mentions.map((mention) => mention.surface))
      .toEqual(["I", "used", "Atlas", "research"]);
    expect(draft?.identity_observation?.mentions.find((mention) => mention.surface === "research")
      ?.proposed_semantic_identity).toBeUndefined();
  });

  it("does not treat a matching quote with the wrong lemma as semantic equality", () => {
    const [draft] = parseOfficialApiSignals(JSON.stringify({
      signals: [{
        object_kind: "activity",
        confidence: 1,
        matched_text: "I use MySQL.",
        identity_observation: {
          contract_version: 1,
          producer: "official-api-identity-observation-v1",
          mentions: [{ surface: "MySQL", proposed_semantic_identity: "postgresql" }]
        }
      }]
    }));
    const mention = draft?.identity_observation?.mentions[0];
    expect(mention).toMatchObject({ surface: "MySQL", proposed_semantic_identity: "postgresql" });
    expect(mention?.proposed_semantic_identity).not.toBe("mysql");
    expect(mention?.surface).not.toBe(mention?.proposed_semantic_identity);
    expect(identityObservationEqualityKey(mention!))
      .not.toBe(identityObservationEqualityKey({ surface: "postgresql" }));
  });

  it("does not treat NFKC lemma success as object equality", () => {
    const [draft] = parseOfficialApiSignals(JSON.stringify({
      signals: [{
        object_kind: "activity",
        confidence: 1,
        matched_text: "I use MySQL.",
        identity_observation: {
          contract_version: 1,
          producer: "official-api-identity-observation-v1",
          mentions: [{ surface: "MySQL", proposed_semantic_identity: "mysql" }]
        }
      }]
    }));
    const mention = draft?.identity_observation?.mentions[0];
    expect(mention).toMatchObject({ surface: "MySQL", proposed_semantic_identity: "mysql" });
    expect("mysql".normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase()).toBe("mysql");
    expect(mention?.surface).not.toBe(mention?.proposed_semantic_identity);
    expect(identityObservationEqualityKey(mention!))
      .not.toBe(identityObservationEqualityKey({ surface: "mysql" }));
    expect(identityObservationEqualityKey(mention!))
      .toBe(identityObservationEqualityKey({ surface: "MySQL", source_occurrence: 0 }));
  });
});
