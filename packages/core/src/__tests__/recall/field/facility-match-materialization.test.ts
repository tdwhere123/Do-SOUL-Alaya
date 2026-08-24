import { describe, expect, it } from "vitest";

import type { CandidateCoverageReceipt } from
  "../../../recall/delivery/fine-assessment-selection/coverage-atoms.js";
import { materializeAttributedFacilityMatches } from
  "../../../recall/field/facility/match-materialization.js";
import { regularRelationInflectionEquivalent } from
  "../../../recall/field/facility/relation-inflection-alignment.js";
import {
  ATTRIBUTED_QUERY_FACILITY_DEMAND_OPERATOR_ID,
  materializeAttributedQueryFacilityDemand,
  type AttributedQueryFacilityDemandReceipt
} from "../../../recall/field/query-facility-demand.js";
import { projectFactFrameSemanticFactors } from
  "../../../recall/field/fact-frame-semantic-factors.js";
import { digestRecallFieldIdentity } from
  "../../../recall/field/field-identity.js";
import type { RecallQueryDemand } from
  "../../../recall/query/recall-query-demand.js";

describe("attributed facility match materialization", () => {
  it("bounds multi-token relation alignment at the field window", () => {
    expect(() => regularRelationInflectionEquivalent("a b", "b c")).not.toThrow();
    expect(regularRelationInflectionEquivalent("a b", "b c")).toBe(false);
  });

  it("binds demand only to source-exact slots present in a captured form", () => {
    const demand = queryDemand();
    const facilityDemand = materializeAttributedQueryFacilityDemand({
      query_demand: demand,
      weights: facilityWeights(),
      semantic_factors: projectFactFrameSemanticFactors([
        { role: "relation", text: "bought" },
        { role: "qualifier", text: "IKEA" }
      ], 0)
    });

    const matches = materializeAttributedFacilityMatches({
      demand: facilityDemand,
      candidates: [{
        candidate_key: "candidate-a",
        object_id: "memory-a",
        coverage: coverageReceipt()
      }]
    }).get("candidate-a")!;

    expect(matches).toEqual([
      expect.objectContaining({
        demand_atom_id: "facility:entity:frame:0:slot:1:qualifier:ikea",
        coverage_atom_id: "fact:evidence-a:7",
        projection_form_keys: [
          "complete",
          "leave_one_slot_out:1:relation"
        ]
      }),
      expect.objectContaining({
        demand_atom_id: "facility:independent_evidence:evidence_ref:evidence-a",
        coverage_atom_id: "evidence:evidence-a",
        projection_form_keys: []
      }),
      expect.objectContaining({
        demand_atom_id: "facility:logical_object:object_id:memory-a",
        coverage_atom_id: "object:workspace:memory-a",
        projection_form_keys: []
      }),
      expect.objectContaining({
        demand_atom_id: "facility:relation:frame:0:slot:0:relation:bought",
        coverage_atom_id: "fact:evidence-a:7",
        projection_form_keys: ["complete"]
      })
    ]);
  });

  it("does not promote substring or omitted-slot matches", () => {
    const demand = queryDemand(["graduate", "bought"]);
    const facilityDemand = materializeAttributedQueryFacilityDemand({
      query_demand: demand,
      weights: facilityWeights(),
      semantic_factors: projectFactFrameSemanticFactors([
        { role: "subject", text: "graduate" },
        { role: "relation", text: "bought" }
      ], 0)
    });
    const coverage = coverageReceipt({ onlyRelationOmitted: true });

    const matches = materializeAttributedFacilityMatches({
      demand: facilityDemand,
      candidates: [{ candidate_key: "candidate-a", object_id: "other", coverage }]
    }).get("candidate-a")!;

    expect(matches.filter((match) =>
      match.demand_atom_id.includes(":entity:") ||
      match.demand_atom_id.includes(":relation:")
    )).toEqual([]);
  });

  it("uses regular plural alignment only with a captured porter lane", () => {
    const demand = queryDemand(["trips"]);
    const facilityDemand = materializeAttributedQueryFacilityDemand({
      query_demand: demand,
      weights: facilityWeights(),
      semantic_factors: projectFactFrameSemanticFactors([
        { role: "value", text: "trips" }
      ], 0)
    });
    const candidate = (matchedFtsLanes: readonly ("porter" | "trigram")[]) => ({
      candidate_key: "candidate-a",
      object_id: "other",
      coverage: coverageReceipt({
        onlyRelationOmitted: true,
        valueText: "a solo camping trip to Yosemite",
        matchedFtsLanes
      })
    });

    const porter = materializeAttributedFacilityMatches({
      demand: facilityDemand,
      candidates: [candidate(["porter"])]
    }).get("candidate-a")!;
    const noPorter = materializeAttributedFacilityMatches({
      demand: facilityDemand,
      candidates: [candidate(["trigram"])]
    }).get("candidate-a")!;

    expect(porter).toContainEqual(expect.objectContaining({
      demand_atom_id: "facility:entity:frame:0:slot:0:value:trips",
      coverage_atom_id: "fact:evidence-a:7",
      alignment_operator_id: "porter_regular_plural_v1"
    }));
    expect(noPorter.some((match) =>
      match.demand_atom_id === "facility:entity:frame:0:slot:0:value:trips"
    )).toBe(false);
  });

  it("fails closed when a multi-token Porter demand starts at an incomplete suffix", () => {
    const demand = queryDemand(["camp trips"]);
    const facilityDemand = materializeAttributedQueryFacilityDemand({
      query_demand: demand,
      weights: facilityWeights(),
      semantic_factors: projectFactFrameSemanticFactors([
        { role: "value", text: "camp trips" }
      ], 0)
    });

    const matches = materializeAttributedFacilityMatches({
      demand: facilityDemand,
      candidates: [{
        candidate_key: "candidate-a",
        object_id: "other",
        coverage: coverageReceipt({
          onlyRelationOmitted: true,
          valueText: "solo camp",
          matchedFtsLanes: ["porter"]
        })
      }]
    }).get("candidate-a")!;

    expect(matches.some(({ demand_atom_id: id }) =>
      id === "facility:entity:frame:0:slot:0:value:camp trips"
    )).toBe(false);
  });

  it.each([
    ["watch", "watched"],
    ["watch", "watches"],
    ["graduate", "graduated"],
    ["use", "used"],
    ["try", "tried"],
    ["listen", "listening"]
  ])("aligns source-exact relation inflection %s with %s only through porter evidence", (
    queryRelation,
    capturedRelation
  ) => {
    const demand = queryDemand([queryRelation]);
    const facilityDemand = materializeAttributedQueryFacilityDemand({
      query_demand: demand,
      weights: facilityWeights(),
      semantic_factors: projectFactFrameSemanticFactors([
        { role: "relation", text: queryRelation }
      ], 0)
    });
    const candidate = (matchedFtsLanes: readonly ("porter" | "trigram")[]) => ({
      candidate_key: "candidate-a",
      object_id: "other",
      coverage: coverageReceipt({ relationText: capturedRelation, matchedFtsLanes })
    });

    const porter = materializeAttributedFacilityMatches({
      demand: facilityDemand,
      candidates: [candidate(["porter"])]
    }).get("candidate-a")!;
    const noPorter = materializeAttributedFacilityMatches({
      demand: facilityDemand,
      candidates: [candidate(["trigram"])]
    }).get("candidate-a")!;

    expect(porter).toContainEqual(expect.objectContaining({
      demand_atom_id: `facility:relation:frame:0:slot:0:relation:${queryRelation}`,
      alignment_operator_id: "porter_regular_relation_inflection_v1"
    }));
    expect(noPorter.some((match) =>
      match.demand_atom_id === `facility:relation:frame:0:slot:0:relation:${queryRelation}`
    )).toBe(false);
  });

  it("uses the same source-bound factor identity for query and candidate slots", () => {
    const semanticFactors = projectFactFrameSemanticFactors([
      { role: "relation", text: "watch" },
      { role: "subject", text: "I" },
      { role: "value", text: "a degree" }
    ], 0);
    const facilityDemand = materializeAttributedQueryFacilityDemand({
      query_demand: queryDemand(),
      weights: facilityWeights(),
      semantic_factors: semanticFactors
    });
    const matches = materializeAttributedFacilityMatches({
      demand: facilityDemand,
      candidates: [{
        candidate_key: "candidate-a",
        object_id: "other",
        coverage: coverageReceipt({ relationText: "watched", matchedFtsLanes: ["porter"] })
      }]
    }).get("candidate-a")!;

    expect(matches).toContainEqual(expect.objectContaining({
      demand_atom_id: "facility:relation:frame:0:slot:0:relation:watch",
      alignment_operator_id: "porter_regular_relation_inflection_v1"
    }));
    expect(facilityDemand.demand_atoms.every((atom) =>
      atom.attribution_kind === "typed_fact_frame" ||
      atom.attribution_kind === "typed_query_atom"
    )).toBe(true);
  });

  it("fails closed when a typed query atom is missing a semantic factor", () => {
    const demand = legacyDemandReceipt();
    const matches = materializeAttributedFacilityMatches({
      demand,
      candidates: [{
        candidate_key: "candidate-a",
        object_id: "other",
        coverage: coverageReceipt({ subjectText: "legacy" })
      }]
    }).get("candidate-a")!;

    expect(matches).toEqual([]);
  });

  it("gates independent_evidence demand on evidence identity, not semantic strength", () => {
    const facilityDemand = materializeAttributedQueryFacilityDemand({
      query_demand: queryDemand(),
      weights: facilityWeights()
    });
    const matchesFor = (evidenceObjectId: string) =>
      materializeAttributedFacilityMatches({
        demand: facilityDemand,
        candidates: [{
          candidate_key: "candidate-a",
          object_id: "other",
          coverage: semanticEvidenceCoverage(evidenceObjectId, 0.95)
        }]
      }).get("candidate-a")!.filter((match) =>
        match.demand_atom_id.includes(":independent_evidence:")
      );

    expect(matchesFor("evidence-b")).toEqual([]);
    expect(matchesFor("evidence-a")).toEqual([
      expect.objectContaining({
        demand_atom_id: "facility:independent_evidence:evidence_ref:evidence-a",
        alignment_operator_id: "identity_v1",
        match_strength: 0.95
      })
    ]);
  });
});

function queryDemand(extraTerms: readonly string[] = []): Readonly<RecallQueryDemand> {
  const values = ["bought", "ikea", ...extraTerms];
  return Object.freeze({
    schema_version: 1,
    atoms: Object.freeze([
      ...[...new Set(values)].map((value) => Object.freeze({
        id: `lexical_term:${value}`,
        kind: "lexical_term" as const,
        value,
        priority: "supporting" as const
      })),
      Object.freeze({
        id: "object_id:memory-a",
        kind: "object_id" as const,
        value: "memory-a",
        priority: "core" as const
      }),
      Object.freeze({
        id: "evidence_ref:evidence-a",
        kind: "evidence_ref" as const,
        value: "evidence-a",
        priority: "core" as const
      })
    ])
  });
}

function facilityWeights() {
  return Object.freeze({
    entity: 1,
    relation: 1,
    time: 1,
    logical_object: 1,
    independent_evidence: 1
  });
}

function coverageReceipt(
  options: Readonly<{
    readonly subjectText?: string;
    readonly onlyRelationOmitted?: boolean;
    readonly valueText?: string;
    readonly relationText?: string;
    readonly matchedFtsLanes?: readonly ("porter" | "trigram")[];
  }> = {}
): Readonly<CandidateCoverageReceipt> {
  const forms = options.onlyRelationOmitted
    ? [{
        kind: "leave_one_slot_out" as const,
        omitted_slot: { slot_index: 1, role: "relation" as const }
      }]
    : [
        { kind: "complete" as const },
        {
          kind: "leave_one_slot_out" as const,
          omitted_slot: { slot_index: 1, role: "relation" as const }
        }
      ];
  return Object.freeze({
    schema_version: 1,
    operator_id: "attributed_coverage_atoms_v1",
    candidate_key: "candidate-a",
    activation: Object.freeze({
      schema_version: 1,
      operator_id: "candidate_semantic_max_v1",
      state: "absent",
      score: null,
      winner: null,
      observations: Object.freeze([]),
      missing_channel_policy: "no_op"
    }),
    evidence_semantic_completeness: "not_observed",
    projection_match_count: 1,
    atoms: Object.freeze([
      Object.freeze({
        atom_id: "object:workspace:memory-a",
        kind: "logical_object" as const,
        strength: 1,
        independence_key: "object:workspace:memory-a",
        evidence_object_id: null,
        document_identity: null,
        projection: null,
        demand_roles: Object.freeze([]),
        observation_channels: Object.freeze([])
      }),
      Object.freeze({
        atom_id: "evidence:evidence-a",
        kind: "independent_evidence" as const,
        strength: 0.8,
        independence_key: "evidence:evidence-a",
        evidence_object_id: "evidence-a",
        document_identity: null,
        projection: null,
        demand_roles: Object.freeze([]),
        observation_channels: Object.freeze(["evidence_fts" as const])
      }),
      Object.freeze({
        atom_id: "fact:evidence-a:7",
        kind: "fact_projection" as const,
        strength: 0.8,
        independence_key: "evidence:evidence-a",
        evidence_object_id: "evidence-a",
        document_identity: "fact_key:7",
        projection: Object.freeze({
          projection_id: 7,
          projection_kind: "fact_key" as const,
          matched_fact_key_forms: Object.freeze(forms),
          fact_slots: Object.freeze([
            Object.freeze({
              role: "subject" as const,
              text: options.subjectText ?? "I"
            }),
            Object.freeze({
              role: "relation" as const,
              text: options.relationText ?? "bought"
            }),
            Object.freeze({
              role: "value" as const,
              text: options.valueText ?? "an undergraduate degree"
            }),
            Object.freeze({ role: "qualifier" as const, text: "from IKEA" })
          ])
        }),
        demand_roles: Object.freeze(["complete", "relation"] as const),
        observation_channels: Object.freeze(["evidence_fts" as const]),
        matched_fts_lanes: Object.freeze([...(options.matchedFtsLanes ?? [])])
      })
    ])
  });
}

function semanticEvidenceCoverage(
  evidenceObjectId: string,
  strength: number
): Readonly<CandidateCoverageReceipt> {
  return Object.freeze({
    schema_version: 1,
    operator_id: "attributed_coverage_atoms_v1",
    candidate_key: "candidate-a",
    activation: Object.freeze({
      schema_version: 1,
      operator_id: "candidate_semantic_max_v1",
      state: "absent",
      score: null,
      winner: null,
      observations: Object.freeze([]),
      missing_channel_policy: "no_op"
    }),
    evidence_semantic_completeness: "complete",
    projection_match_count: 0,
    atoms: Object.freeze([
      Object.freeze({
        atom_id: `evidence:${evidenceObjectId}`,
        kind: "independent_evidence" as const,
        strength,
        independence_key: `evidence:${evidenceObjectId}`,
        evidence_object_id: evidenceObjectId,
        document_identity: null,
        projection: null,
        demand_roles: Object.freeze([]),
        observation_channels: Object.freeze(["evidence_semantic" as const])
      })
    ])
  });
}

function legacyDemandReceipt(): Readonly<AttributedQueryFacilityDemandReceipt> {
  const demand_atoms = Object.freeze([
    Object.freeze({
      demand_atom_id: "facility:entity:legacy",
      kind: "entity" as const,
      weight: 1,
      value: "legacy",
      source_query_atom_id: "legacy",
      attribution_kind: "typed_query_atom" as const
    })
  ]);
  const body = Object.freeze({
    schema_version: 1 as const,
    operator_id: ATTRIBUTED_QUERY_FACILITY_DEMAND_OPERATOR_ID,
    query_demand_digest: digestRecallFieldIdentity({ query_demand: "legacy" }),
    semantic_factor_digest: null,
    weight_configuration_digest: digestRecallFieldIdentity(facilityWeights()),
    demand_atoms
  });
  return Object.freeze({
    ...body,
    demand_digest: digestRecallFieldIdentity(body)
  });
}
