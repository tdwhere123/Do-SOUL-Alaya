import { describe, expect, it } from "vitest";
import { parseOfficialApiSignals } from "../../garden/compute-provider.js";
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
});
