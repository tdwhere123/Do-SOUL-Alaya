import { describe, expect, it, vi } from "vitest";

import type { EntityExtractionPort } from
  "../../../shared/entity-extraction-port.js";
import {
  captureRecallQueryEntities,
  produceEntityQueryFieldAttribution,
  verifyRecallQueryEntityExtractionCapture
} from "../../../recall/field/query-entity-attribution-producer.js";
import type {
  RecallQueryDemand,
  RecallQueryDemandAtom
} from "../../../recall/query/recall-query-demand.js";
import { materializeQueryFieldAttribution } from
  "../../../recall/supplements/query/query-field-attribution.js";

describe("query entity field attribution producer", () => {
  it("binds source-exact entity output to matching query atoms without relations", async () => {
    const queryText = "Deploy to Staging Cluster";
    const port: EntityExtractionPort = {
      operator_id: "test_entity_parser_v1",
      extract: vi.fn(async () => [{
        surface: "Staging Cluster",
        normalized: "staging cluster",
        kind: "proper_noun" as const,
        confidence: 0.9,
        source_offset: [10, 25] as const
      }])
    };
    const capture = await captureRecallQueryEntities({ query_text: queryText, port });
    const receipt = produceEntityQueryFieldAttribution({
      query_text: queryText,
      query_demand: demand([
        atom("phrase:staging cluster", "phrase", "staging cluster"),
        atom("lexical_term:deploy", "lexical_term", "deploy")
      ]),
      capture
    });

    expect(port.extract).toHaveBeenCalledOnce();
    expect(receipt?.schema_version).toBe(2);
    expect(receipt?.contributions[0]?.producer_operator_id)
      .toBe("test_entity_parser_v1");
    expect(receipt?.contributions[0]?.producer_capture_digest)
      .toBe(capture.capture_digest);
    expect(receipt?.contributions[0]?.attributions).toEqual([{
      query_atom_id: "phrase:staging cluster",
      role: "entity",
      source_spans: [[10, 25]]
    }]);
    expect(receipt?.attributions).toEqual([{
      query_atom_id: "phrase:staging cluster",
      role: "entity"
    }]);
    expect(receipt?.attributions.some(({ role }) => role === "relation")).toBe(false);
  });

  it("does not promote unidentified or non-source-exact output to typed demand", async () => {
    const capture = await captureRecallQueryEntities({
      query_text: "Deploy staging",
      port: {
        operator_id: "entity_parser_v1",
        extract: async () => [{
          surface: "staging",
          normalized: "staging",
          kind: "unknown",
          confidence: 0.4
        }]
      }
    });

    expect(capture.status).toBe("returned");
    const receipt = produceEntityQueryFieldAttribution({
      query_text: "Deploy staging",
      query_demand: demand([atom("lexical_term:staging", "lexical_term", "staging")]),
      capture
    });
    expect(receipt?.attributions).toEqual([]);
    expect(receipt?.contributions[0]?.attributions).toEqual([]);
  });

  it("routes the active entity contribution through the canonical aggregator", async () => {
    const queryText = "Deploy to Staging Cluster";
    const queryDemand = demand([
      atom("phrase:staging cluster", "phrase", "staging cluster")
    ]);
    const capture = await captureRecallQueryEntities({
      query_text: queryText,
      port: {
        operator_id: "test_entity_parser_v1",
        extract: async () => [{
          surface: "Staging Cluster",
          normalized: "staging cluster",
          kind: "proper_noun",
          confidence: 0.9,
          source_offset: [10, 25]
        }]
      }
    });

    const receipt = materializeQueryFieldAttribution({
      queryText,
      queryDemand,
      entityCapture: capture
    });

    expect(receipt?.schema_version).toBe(2);
    expect(receipt?.contributions).toHaveLength(1);
    expect(receipt?.attributions).toEqual([{
      query_atom_id: "phrase:staging cluster",
      role: "entity"
    }]);
  });

  it("distinguishes extractor failure from a successful empty result", async () => {
    const onFailure = vi.fn();
    const failed = await captureRecallQueryEntities({
      query_text: "query",
      port: {
        operator_id: "failing_entity_parser_v1",
        extract: async () => { throw new Error("offline"); }
      },
      on_failure: onFailure
    });
    const empty = await captureRecallQueryEntities({
      query_text: "query",
      port: {
        operator_id: "empty_entity_parser_v1",
        extract: async () => []
      }
    });

    expect(failed.status).toBe("unavailable");
    expect(empty.status).toBe("returned");
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it("rejects a capture changed after sealing", async () => {
    const capture = await captureRecallQueryEntities({ query_text: null });

    expect(() => verifyRecallQueryEntityExtractionCapture({
      ...capture,
      status: "returned"
    })).toThrow(/digest|candidate|producer identity/u);
  });

  it("rejects a returned capture without a producer identity", async () => {
    const capture = await captureRecallQueryEntities({
      query_text: "query",
      port: {
        operator_id: "entity_parser_v1",
        extract: async () => []
      }
    });

    expect(() => verifyRecallQueryEntityExtractionCapture({
      ...capture,
      producer_operator_id: null
    })).toThrow(/producer identity/u);
  });
});

function demand(atoms: readonly Readonly<RecallQueryDemandAtom>[]): RecallQueryDemand {
  return Object.freeze({ schema_version: 1, atoms: Object.freeze(atoms) });
}

function atom(
  id: string,
  kind: "phrase" | "lexical_term",
  value: string
): Readonly<RecallQueryDemandAtom> {
  return Object.freeze({ id, kind, value, priority: "supporting" });
}
