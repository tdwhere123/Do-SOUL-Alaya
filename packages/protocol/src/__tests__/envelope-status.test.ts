import { describe, expect, it } from "vitest";
import {
  AuditTrailSchema,
  CandidateMemorySignalSchema,
  CompositeObjectStatusSchema,
  ControlPlaneEnvelopeSchema,
  ControlPlaneObjectKind,
  ObjectKind,
  PersistentObjectEnvelopeSchema,
  SignalKind,
  SignalSource,
  SignalState,
  isValidLifecycleTransition
} from "../index.js";

const validTimestamp = "2026-03-20T00:00:00.000Z";

describe("PersistentObjectEnvelopeSchema", () => {
  it("accepts a complete persistent envelope", () => {
    const value = {
      object_id: "5c6b478a-3839-4a9b-833f-af22192c33c7",
      object_kind: ObjectKind.MEMORY_ENTRY,
      schema_version: 1,
      created_at: validTimestamp,
      updated_at: validTimestamp,
      created_by: "user",
      lifecycle_state: "draft"
    } as const;

    expect(PersistentObjectEnvelopeSchema.parse(value)).toEqual(value);
  });
});

describe("ControlPlaneEnvelopeSchema", () => {
  it("accepts a control-plane envelope", () => {
    const value = {
      runtime_id: "cfecb83f-7a62-4601-b80b-0a8b1e3730bd",
      object_kind: ControlPlaneObjectKind.WORKING_PROJECTION,
      task_surface_ref: "surface://task/main",
      expires_at: validTimestamp,
      derived_from: "5c6b478a-3839-4a9b-833f-af22192c33c7",
      retention_policy: "run_scoped"
    } as const;

    expect(ControlPlaneEnvelopeSchema.parse(value)).toEqual(value);
  });
});

describe("isValidLifecycleTransition", () => {
  const validTransitions = [
    ["draft", "active"],
    ["active", "dormant"],
    ["active", "archived"],
    ["active", "tombstone"],
    ["dormant", "active"],
    ["dormant", "archived"],
    ["dormant", "tombstone"],
    ["archived", "tombstone"]
  ] as const;

  const invalidTransitions = [
    ["draft", "draft"],
    ["draft", "dormant"],
    ["draft", "archived"],
    ["draft", "tombstone"],
    ["active", "draft"],
    ["active", "active"],
    ["dormant", "draft"],
    ["dormant", "dormant"],
    ["archived", "draft"],
    ["archived", "active"],
    ["archived", "dormant"],
    ["archived", "archived"],
    ["tombstone", "draft"],
    ["tombstone", "active"],
    ["tombstone", "dormant"],
    ["tombstone", "archived"],
    ["tombstone", "tombstone"]
  ] as const;

  it.each(validTransitions)("accepts %s -> %s", (from, to) => {
    expect(isValidLifecycleTransition(from, to)).toBe(true);
  });

  it.each(invalidTransitions)("rejects %s -> %s", (from, to) => {
    expect(isValidLifecycleTransition(from, to)).toBe(false);
  });
});

describe("CompositeObjectStatusSchema", () => {
  it("accepts all status layers populated", () => {
    const value = {
      lifecycle: "active",
      evidence_health: "verified",
      governance_role: "winner",
      interaction_cue: "blocking"
    } as const;

    expect(CompositeObjectStatusSchema.parse(value)).toEqual(value);
  });

  it("accepts nullable non-lifecycle layers", () => {
    const value = {
      lifecycle: "dormant",
      evidence_health: null,
      governance_role: null,
      interaction_cue: null
    } as const;

    expect(CompositeObjectStatusSchema.parse(value)).toEqual(value);
  });
});

describe("AuditTrailSchema", () => {
  it("accepts a non-empty events array", () => {
    const value = {
      events: [
        {
          event_type: "created",
          occurred_at: validTimestamp,
          actor: "system",
          detail: { reason: "bootstrap" }
        }
      ]
    } as const;

    expect(AuditTrailSchema.parse(value)).toEqual(value);
  });

  it("rejects an empty events array", () => {
    expect(() =>
      AuditTrailSchema.parse({
        events: []
      })
    ).toThrow();
  });
});

describe("enum completeness", () => {
  it("exports the full persistent object kind set", () => {
    expect(Object.values(ObjectKind)).toEqual([
      "evidence_capsule",
      "memory_entry",
      "synthesis_capsule",
      "claim_form",
      "green_status",
      "slot",
      "surface_identity",
      "surface_anchor",
      "surface_binding",
      "conflict_matrix_edge",
      "cross_cutting_permission",
      "project_mapping_anchor",
      "memory_graph_edge",
      "path_relation"
    ]);
  });

  it("exports the full control-plane object kind set", () => {
    expect(Object.values(ControlPlaneObjectKind)).toEqual([
      "task_object_surface",
      "recall_policy",
      "context_lens",
      "working_projection",
      "verification_result",
      "governance_lease",
      "budget_bankruptcy_state",
      "bankruptcy_dossier",
      "proposal",
      "session_override",
      "promotion_gate",
      "handoff_record",
      "gap_record",
      "orphan_radar",
      "activation_candidate"
    ]);
  });
});

describe("CandidateMemorySignalSchema", () => {
  it("includes signal_state on the public signal shape", () => {
    const value = {
      signal_id: "signal-1",
      workspace_id: "workspace-1",
      run_id: "run-1",
      surface_id: null,
      source: SignalSource.MODEL_TOOL,
      signal_kind: SignalKind.POTENTIAL_SYNTHESIS,
      signal_state: SignalState.EMITTED,
      object_kind: "working_note",
      scope_hint: null,
      domain_tags: ["repo", "planning"],
      confidence: 0.75,
      evidence_refs: ["message-1", "message-2"],
      source_memory_refs: [],
      supersedes_refs: [],
      exception_to_refs: [],
      contradicts_refs: [],
      incompatible_with_refs: [],
      raw_payload: {
        summary: "Potential synthesis candidate",
        message_ids: ["message-1", "message-2"]
      },
      created_at: validTimestamp
    } as const;

    expect(CandidateMemorySignalSchema.parse(value)).toEqual(value);
  });
});
