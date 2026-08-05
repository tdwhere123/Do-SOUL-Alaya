import { describe, expect, it } from "vitest";

import type {
  RecallQueryDemand,
  RecallQueryDemandAtom
} from "../../../recall/query/recall-query-demand.js";
import {
  aggregateRecallQueryFieldAttributionContributions,
  createRecallQueryFieldAttributionContribution,
  createRecallQueryFieldAttributionReceipt
} from "../../../recall/field/query-attribution/query-field-attribution.js";
import {
  materializeAttributedQueryFacilityDemand,
  verifyAttributedQueryFacilityDemand
} from "../../../recall/field/query-facility-demand.js";
import { digestRecallFieldIdentity } from
  "../../../recall/field/field-identity.js";

describe("attributed query facility demand", () => {
  it("maps only already-typed query identities without guessing lexical roles", () => {
    const query = demand([
      atom("temporal:2026-03-19", "temporal", "2026-03-19", "core"),
      atom("object_id:memory-a", "object_id", "memory-a", "core"),
      atom("evidence_ref:evidence-a", "evidence_ref", "evidence-a", "core"),
      atom("lexical_term:deploy", "lexical_term", "deploy", "supporting")
    ]);

    const receipt = materializeAttributedQueryFacilityDemand({
      query_demand: query,
      weights: unitWeights()
    });

    expect(receipt.demand_atoms.map(({ kind, value }) => [kind, value])).toEqual([
      ["independent_evidence", "evidence-a"],
      ["logical_object", "memory-a"],
      ["time", "2026-03-19"]
    ]);
    expect(receipt.demand_atoms.some(({ value }) => value === "deploy")).toBe(false);
    expect(() => verifyAttributedQueryFacilityDemand(receipt)).not.toThrow();
  });

  it("binds explicit entity and relation roles to one query and producer", () => {
    const query = demand([
      atom("lexical_term:staging", "lexical_term", "staging", "supporting"),
      atom("lexical_term:deploy", "lexical_term", "deploy", "supporting")
    ]);
    const attribution = createRecallQueryFieldAttributionReceipt({
      producer_operator_id: "verified_query_field_parser_v1",
      producer_capture_digest: captureDigest(),
      query_demand: query,
      attributions: [
        {
          query_atom_id: "lexical_term:staging",
          role: "entity",
          source_spans: [[0, 7]]
        },
        {
          query_atom_id: "lexical_term:deploy",
          role: "relation",
          source_spans: [[8, 14]]
        }
      ]
    });

    const receipt = materializeAttributedQueryFacilityDemand({
      query_demand: query,
      field_attribution: attribution,
      weights: unitWeights()
    });

    expect(receipt.field_attribution_digest).toBe(attribution.attribution_digest);
    expect(receipt.demand_atoms.map(({ kind, value, attribution_kind }) =>
      [kind, value, attribution_kind])).toEqual([
      ["relation", "deploy", "explicit_field_role"],
      ["entity", "staging", "explicit_field_role"]
    ]);
  });

  it("gives equivalent query and attribution permutations one identity", () => {
    const forwardQuery = demand([
      atom("lexical_term:staging", "lexical_term", "staging", "supporting"),
      atom("lexical_term:deploy", "lexical_term", "deploy", "supporting")
    ]);
    const reverseQuery = demand([...forwardQuery.atoms].reverse());
    const forward = attributedDemand(forwardQuery, [
      { query_atom_id: "lexical_term:staging", role: "entity" },
      { query_atom_id: "lexical_term:deploy", role: "relation" }
    ]);
    const reverse = attributedDemand(reverseQuery, [
      { query_atom_id: "lexical_term:deploy", role: "relation" },
      { query_atom_id: "lexical_term:staging", role: "entity" }
    ]);

    expect(reverse.demand_digest).toBe(forward.demand_digest);
    expect(reverse.demand_atoms).toEqual(forward.demand_atoms);
  });

  it("rejects an attribution receipt from a different query", () => {
    const source = demand([
      atom("lexical_term:deploy", "lexical_term", "deploy", "supporting")
    ]);
    const other = demand([
      atom("lexical_term:release", "lexical_term", "release", "supporting")
    ]);
    const attribution = createRecallQueryFieldAttributionReceipt({
      producer_operator_id: "verified_query_field_parser_v1",
      producer_capture_digest: captureDigest(),
      query_demand: source,
      attributions: [{
        query_atom_id: "lexical_term:deploy",
        role: "relation",
        source_spans: [[0, 6]]
      }]
    });

    expect(() => materializeAttributedQueryFacilityDemand({
      query_demand: other,
      field_attribution: attribution,
      weights: unitWeights()
    })).toThrow(/query digest/u);
  });

  it("rejects a sealed attribution that cites no atom in the bound query", () => {
    const query = demand([
      atom("lexical_term:deploy", "lexical_term", "deploy", "supporting")
    ]);
    const valid = createRecallQueryFieldAttributionReceipt({
      producer_operator_id: "verified_query_field_parser_v1",
      producer_capture_digest: captureDigest(),
      query_demand: query,
      attributions: [{
        query_atom_id: "lexical_term:deploy",
        role: "relation",
        source_spans: [[0, 6]]
      }]
    });
    const { attribution_digest: _digest, ...validBody } = valid;
    const forgedBody = {
      ...validBody,
      attributions: [{ query_atom_id: "lexical_term:release", role: "relation" as const }]
    };
    const forged = Object.freeze({
      ...forgedBody,
      attribution_digest: digestRecallFieldIdentity(forgedBody)
    });

    expect(() => materializeAttributedQueryFacilityDemand({
      query_demand: query,
      field_attribution: forged,
      weights: unitWeights()
    })).toThrow(/aggregation mismatch|cite a query atom/u);
  });

  it("aggregates producer contributions independent of order and duplicates", () => {
    const query = demand([
      atom("lexical_term:staging", "lexical_term", "staging", "supporting"),
      atom("lexical_term:deploy", "lexical_term", "deploy", "supporting")
    ]);
    const entity = contribution(query, "entity_parser_v1", [
      { query_atom_id: "lexical_term:staging", role: "entity" }
    ]);
    const relation = contribution(query, "relation_parser_v1", [
      { query_atom_id: "lexical_term:deploy", role: "relation" }
    ]);
    const forward = aggregateRecallQueryFieldAttributionContributions({
      query_demand: query,
      contributions: [entity, relation, entity]
    });
    const reverse = aggregateRecallQueryFieldAttributionContributions({
      query_demand: query,
      contributions: [relation, entity]
    });

    expect(forward.contributions).toHaveLength(2);
    expect(forward.attributions).toEqual([
      { query_atom_id: "lexical_term:deploy", role: "relation" },
      { query_atom_id: "lexical_term:staging", role: "entity" }
    ]);
    expect(reverse).toEqual(forward);
  });

  it("fails closed only the atom with conflicting producer roles", () => {
    const query = demand([
      atom("lexical_term:deploy", "lexical_term", "deploy", "supporting"),
      atom("lexical_term:staging", "lexical_term", "staging", "supporting")
    ]);
    const entity = contribution(query, "entity_parser_v1", [
      { query_atom_id: "lexical_term:deploy", role: "entity" },
      { query_atom_id: "lexical_term:staging", role: "entity" }
    ]);
    const relation = contribution(query, "relation_parser_v1", [
      { query_atom_id: "lexical_term:deploy", role: "relation" }
    ]);

    const receipt = aggregateRecallQueryFieldAttributionContributions({
      query_demand: query,
      contributions: [entity, relation]
    });

    expect(receipt.contributions).toHaveLength(2);
    expect(receipt.attributions).toEqual([{
      query_atom_id: "lexical_term:staging",
      role: "entity"
    }]);
  });

  it("replays a legacy single-producer receipt without creating one", () => {
    const query = demand([
      atom("lexical_term:staging", "lexical_term", "staging", "supporting")
    ]);
    const body = {
      schema_version: 1 as const,
      operator_id: "query_field_attribution_receipt_v1" as const,
      producer_operator_id: "legacy_entity_parser_v1",
      producer_capture_digest: captureDigest(),
      query_demand_digest: digestRecallFieldIdentity(query),
      attributions: [{
        query_atom_id: "lexical_term:staging",
        role: "entity" as const
      }]
    };
    const legacy = {
      ...body,
      attribution_digest: digestRecallFieldIdentity(body)
    };

    const receipt = materializeAttributedQueryFacilityDemand({
      query_demand: query,
      field_attribution: legacy,
      weights: unitWeights()
    });

    expect(receipt.demand_atoms).toEqual([expect.objectContaining({
      kind: "entity",
      value: "staging"
    })]);
    expect(createRecallQueryFieldAttributionReceipt({
      producer_operator_id: "current_entity_parser_v1",
      producer_capture_digest: captureDigest(),
      query_demand: query,
      attributions: []
    }).schema_version).toBe(2);
  });

  it("rejects receipt content changed after its digest was sealed", () => {
    const query = demand([
      atom("object_id:memory-a", "object_id", "memory-a", "core")
    ]);
    const receipt = materializeAttributedQueryFacilityDemand({
      query_demand: query,
      weights: unitWeights()
    });

    expect(() => verifyAttributedQueryFacilityDemand({
      ...receipt,
      query_demand_digest: `sha256:${"f".repeat(64)}`
    } as typeof receipt)).toThrow(/digest/u);
  });
});

function attributedDemand(
  query: Readonly<RecallQueryDemand>,
  attributions: readonly Readonly<{
    readonly query_atom_id: string;
    readonly role: "entity" | "relation";
  }>[]
) {
  return materializeAttributedQueryFacilityDemand({
    query_demand: query,
    field_attribution: createRecallQueryFieldAttributionReceipt({
      producer_operator_id: "verified_query_field_parser_v1",
      producer_capture_digest: captureDigest(),
      query_demand: query,
      attributions: withSourceSpans(attributions)
    }),
    weights: unitWeights()
  });
}

function demand(atoms: readonly Readonly<RecallQueryDemandAtom>[]): RecallQueryDemand {
  return Object.freeze({ schema_version: 1, atoms: Object.freeze(atoms) });
}

function atom(
  id: string,
  kind: RecallQueryDemandAtom["kind"],
  value: string,
  priority: RecallQueryDemandAtom["priority"]
): Readonly<RecallQueryDemandAtom> {
  return Object.freeze({ id, kind, value, priority });
}

function unitWeights() {
  return {
    entity: 1,
    relation: 1,
    time: 1,
    logical_object: 1,
    independent_evidence: 1
  } as const;
}

function captureDigest() {
  return digestRecallFieldIdentity({ producer: "verified_query_field_parser_v1" });
}

function contribution(
  query: Readonly<RecallQueryDemand>,
  producer: string,
  attributions: readonly Readonly<{
    readonly query_atom_id: string;
    readonly role: "entity" | "relation";
  }>[]
) {
  return createRecallQueryFieldAttributionContribution({
    producer_operator_id: producer,
    producer_capture_digest: digestRecallFieldIdentity({ producer }),
    query_demand: query,
    attributions: withSourceSpans(attributions)
  });
}

function withSourceSpans(
  attributions: readonly Readonly<{
    readonly query_atom_id: string;
    readonly role: "entity" | "relation";
  }>[]
) {
  const positions = new Map([...attributions]
    .sort((left, right) => left.query_atom_id.localeCompare(right.query_atom_id))
    .map((attribution, index) => [attribution.query_atom_id, index]));
  return attributions.map((attribution) => {
    const position = positions.get(attribution.query_atom_id)!;
    return {
      ...attribution,
      source_spans: [[position, position + 1]] as const
    };
  });
}
