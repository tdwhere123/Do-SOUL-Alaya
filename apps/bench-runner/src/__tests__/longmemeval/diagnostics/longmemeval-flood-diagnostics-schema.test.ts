import { describe, expect, it } from "vitest";

import {
  DiagnosticFloodEdgeTraceV1Schema,
  DiagnosticFloodPotentialSchema
} from "../../../bench/diagnostics/schema/diagnostics-schema.js";

const legacyPotential = {
  R_obj: 0.2,
  Slice: 1,
  A_path: 0.4,
  B_evidence: 0.5,
  E_direct: 0.6,
  omega: 1,
  Flood: 0.2,
  lambda: 0.15,
  beta: 1,
  final_score: 0.23,
  slice_status: "active",
  path_status: "active",
  evidence_status: "active",
  e_direct_status: "active",
  fuel_verified: true
} as const;

const winningTrace = {
  schema_version: 1,
  path_id: "path-overlay",
  relation_kind: "answers_with",
  seed_object_id: "seed",
  target_object_id: "target",
  input_potential: 0.6,
  edge_conductance: 0.5,
  slice_compatibility: "slice_match",
  raw_transfer: 0.3,
  capped_transfer: 0.3,
  decision: "transferred",
  reason: "transferred"
} as const;

const validH1Potential = {
  ...legacyPotential,
  final_score: 0.3,
  score_mode: "rrf_seeded_h1_max_product",
  h1_max_product: {
    schema_version: 1,
    seed_basis: "rrf_family_base",
    direct_potential: 0.2,
    strongest_transfer: 0.3,
    winner: "edge",
    winning_edge_trace: winningTrace,
    frontier_admitted: false,
    transition_counts: {
      evaluated_edge_count: 1,
      seed_overlap_edge_count: 1,
      transferred_edge_count: 1,
      rejected_edge_count: 0,
      reason_counts: {
        transferred: 1,
        capped: 0,
        self_loop: 0,
        missing_edge_provenance: 0,
        missing_or_zero_input: 0,
        non_positive_conductance: 0,
        no_slice_match: 0
      }
    }
  },
  h1_overlay: {
    schema_version: 1,
    baseline_score: 0.23,
    edge_score: 0.3,
    final_score: 0.3,
    delta: 0.07,
    applied: true,
    winner: "edge",
    winning_edge_trace: winningTrace
  }
} as const;

describe("LongMemEval flood diagnostics schemas", () => {
  it("keeps pre-trace flood artifacts valid without inventing trace fields", () => {
    const parsed = DiagnosticFloodPotentialSchema.parse(legacyPotential);

    expect(parsed.edge_traces).toBeUndefined();
    expect(parsed.edge_trace_truncated_count).toBeUndefined();
  });

  it("rejects unknown flood-potential fields instead of silently stripping them", () => {
    expect(() => DiagnosticFloodPotentialSchema.parse({
      ...legacyPotential,
      unexpected_trace_contract: true
    })).toThrow();
  });

  it("accepts the explicit H1 delivery overlay contract", () => {
    const parsed = DiagnosticFloodPotentialSchema.parse(validH1Potential);

    expect(parsed.h1_overlay).toMatchObject({
      baseline_score: 0.23,
      applied: true,
      winner: "edge"
    });
  });

  it("rejects contradictory H1 delivery overlay evidence", () => {
    expect(() => DiagnosticFloodPotentialSchema.parse({
      ...validH1Potential,
      h1_overlay: {
        ...validH1Potential.h1_overlay,
        winning_edge_trace: null
      }
    })).toThrow();
    expect(() => DiagnosticFloodPotentialSchema.parse({
      ...validH1Potential,
      final_score: 0.29
    })).toThrow();
    expect(() => DiagnosticFloodPotentialSchema.parse({
      ...validH1Potential,
      h1_max_product: undefined
    })).toThrow();
    expect(() => DiagnosticFloodPotentialSchema.parse({
      ...validH1Potential,
      h1_overlay: {
        ...validH1Potential.h1_overlay,
        winning_edge_trace: {
          ...winningTrace,
          path_id: "different-path"
        }
      }
    })).toThrow();
  });

  it("keeps versioned edge traces strict", () => {
    expect(() => DiagnosticFloodEdgeTraceV1Schema.parse({
      schema_version: 1,
      path_id: "path-a",
      relation_kind: "answers_with",
      seed_object_id: "seed",
      target_object_id: "target",
      input_potential: 0.4,
      edge_conductance: 0.5,
      slice_compatibility: "slice_match",
      raw_transfer: 0.2,
      capped_transfer: 0.2,
      decision: "transferred",
      reason: "transferred",
      unexpected: true
    })).toThrow();
  });

  it("accepts the typed missing-provenance rejection reason", () => {
    expect(DiagnosticFloodEdgeTraceV1Schema.parse({
      schema_version: 1,
      path_id: "unknown:seed->target",
      relation_kind: "answers_with",
      seed_object_id: "seed",
      target_object_id: "target",
      input_potential: 0.4,
      edge_conductance: 0.5,
      slice_compatibility: "not_evaluated",
      raw_transfer: 0.2,
      capped_transfer: 0,
      decision: "rejected",
      reason: "missing_edge_provenance"
    }).reason).toBe("missing_edge_provenance");
  });

  it.each([
    "missing_source_key",
    "missing_target_key",
    "missing_source_and_target_key"
  ] as const)("accepts additive projection reason %s", (sliceCompatibility) => {
    expect(DiagnosticFloodEdgeTraceV1Schema.parse({
      schema_version: 1,
      path_id: "path-a",
      relation_kind: "answers_with",
      seed_object_id: "seed",
      target_object_id: "target",
      input_potential: 0.4,
      edge_conductance: 0.5,
      slice_compatibility: sliceCompatibility,
      raw_transfer: 0.2,
      capped_transfer: 0.2,
      decision: "transferred",
      reason: "transferred"
    }).slice_compatibility).toBe(sliceCompatibility);
  });
});
