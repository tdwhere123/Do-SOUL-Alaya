import { describe, expect, it } from "vitest";

import type {
  RecallQueryDemand,
  RecallQueryDemandAtom
} from "../../../recall/query/recall-query-demand.js";
import { projectFactFrameSemanticFactors } from
  "../../../recall/field/fact-frame-semantic-factors.js";
import {
  materializeAttributedQueryFacilityDemand,
  verifyAttributedQueryFacilityDemand
} from "../../../recall/field/query-facility-demand.js";

describe("typed query facility demand", () => {
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

  it("projects source-bound Fact Frame slots into typed demand factors", () => {
    const receipt = materializeAttributedQueryFacilityDemand({
      query_demand: demand([
        atom("lexical_term:staging", "lexical_term", "staging", "supporting"),
        atom("lexical_term:deploy", "lexical_term", "deploy", "supporting")
      ]),
      weights: unitWeights(),
      semantic_factors: projectFactFrameSemanticFactors([
        { role: "subject", text: "staging" },
        { role: "relation", text: "deploy" }
      ], 0)
    });

    expect(receipt.demand_atoms.map(({ kind, value, attribution_kind }) =>
      [kind, value, attribution_kind])).toEqual([
      ["entity", "staging", "typed_fact_frame"],
      ["relation", "deploy", "typed_fact_frame"]
    ]);
    expect(receipt.demand_atoms.every(({ semantic_factor }) =>
      semantic_factor !== undefined)).toBe(true);
    expect(() => verifyAttributedQueryFacilityDemand(receipt)).not.toThrow();
  });

  it("keeps factor identity stable when capture order is canonicalized", () => {
    const query = demand([
      atom("lexical_term:staging", "lexical_term", "staging", "supporting"),
      atom("lexical_term:deploy", "lexical_term", "deploy", "supporting")
    ]);
    const factors = projectFactFrameSemanticFactors([
      { role: "subject", text: "staging" },
      { role: "relation", text: "deploy" }
    ], 0);
    const forward = materializeAttributedQueryFacilityDemand({
      query_demand: query,
      weights: unitWeights(),
      semantic_factors: factors
    });
    const reverse = materializeAttributedQueryFacilityDemand({
      query_demand: query,
      weights: unitWeights(),
      semantic_factors: [...factors].reverse()
    });

    expect(reverse.demand_digest).toBe(forward.demand_digest);
    expect(reverse.demand_atoms).toEqual(forward.demand_atoms);
  });

  it("fails closed when a sealed factor no longer agrees with its demand kind", () => {
    const receipt = materializeAttributedQueryFacilityDemand({
      query_demand: demand([
        atom("lexical_term:deploy", "lexical_term", "deploy", "supporting")
      ]),
      weights: unitWeights(),
      semantic_factors: projectFactFrameSemanticFactors([
        { role: "relation", text: "deploy" }
      ], 0)
    });

    expect(() => verifyAttributedQueryFacilityDemand({
      ...receipt,
      demand_atoms: receipt.demand_atoms.map((atom) => atom.attribution_kind === "typed_fact_frame"
        ? { ...atom, kind: "entity" as const }
        : atom)
    } as typeof receipt)).toThrow(/semantic factor|digest/u);
  });

  it("rejects receipt content changed after its digest was sealed", () => {
    const receipt = materializeAttributedQueryFacilityDemand({
      query_demand: demand([
        atom("object_id:memory-a", "object_id", "memory-a", "core")
      ]),
      weights: unitWeights()
    });

    expect(() => verifyAttributedQueryFacilityDemand({
      ...receipt,
      query_demand_digest: `sha256:${"f".repeat(64)}`
    } as typeof receipt)).toThrow(/digest/u);
  });
});

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
