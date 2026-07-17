import { describe, expect, it } from "vitest";

import {
  DiagnosticFloodEdgeTraceV1Schema,
  DiagnosticFloodPotentialSchema
} from "../../../longmemeval/diagnostics/schema/diagnostics-schema.js";

const legacyPotential = {
  R_obj: 0.2,
  Slice: 1,
  A_path: 0.4,
  B_evidence: 0.5,
  E_direct: 0.6,
  omega: 1,
  Flood: 0.2,
  lambda: 0.15,
  beta: 0,
  final_score: 0.23,
  slice_status: "active",
  path_status: "active",
  evidence_status: "active",
  e_direct_status: "inactive:beta_disabled",
  fuel_verified: true
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
