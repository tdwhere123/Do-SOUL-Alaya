import { describe, expect, it } from "vitest";
import {
  ActivationCandidateSchema,
  ForgetDisposition,
  GardenClaimTaskResponseSchema,
  GardenPendingTaskSnapshotSchema,
  GardenTaskDescriptorSchema,
  ManifestationBudgetConfigSchema,
  MemoryEntrySchema,
  PathRelationSchema,
  SoulContextObjectIdentitySchema,
  SoulMemorySearchRequestSchema,
  WorkspaceSchema
} from "../../index.js";
import {
  ConversationRequestSchema,
  EngineMessageSchema,
  EnginePortMessageSchema
} from "../../engine/engine-port.js";

const validTimestamp = "2026-06-18T00:00:00.000Z";

const workspace = {
  workspace_id: "workspace-1",
  name: "Local workspace",
  root_path: "/tmp/workspace",
  workspace_kind: "local_repo",
  repo_path: "/tmp/workspace",
  default_engine_binding: null,
  workspace_state: "active",
  created_at: validTimestamp,
  archived_at: null
} as const;

const memoryEntry = {
  object_id: "memory-1",
  object_kind: "memory_entry",
  schema_version: 1,
  created_at: validTimestamp,
  updated_at: validTimestamp,
  created_by: "user",
  lifecycle_state: "active",
  dimension: "fact",
  source_kind: "user",
  formation_kind: "explicit",
  scope_class: "project",
  content: "A durable fact.",
  domain_tags: ["audit"],
  evidence_refs: ["evidence-1"],
  workspace_id: "workspace-1",
  run_id: "run-1",
  surface_id: null,
  storage_tier: "hot",
  activation_score: 0.5,
  retention_score: 0.5,
  manifestation_state: "full_eligible",
  retention_state: "working",
  decay_profile: "normal",
  confidence: 0.8,
  last_used_at: null,
  last_hit_at: null,
  reinforcement_count: 0,
  contradiction_count: 0,
  superseded_by: null
} as const;

const pathRelation = {
  path_id: "path-1",
  workspace_id: "workspace-1",
  anchors: {
    source_anchor: { kind: "object", object_id: "memory-1" },
    target_anchor: { kind: "object", object_id: "memory-2" }
  },
  constitution: {
    relation_kind: "custom_relation_kind",
    why_this_relation_exists: ["test"]
  },
  effect_vector: {
    salience: 0.5,
    recall_bias: -0.4,
    verification_bias: 0.2,
    unfinishedness_bias: 0.1,
    default_manifestation_preference: "stance_bias"
  },
  plasticity_state: {
    strength: 1.5,
    direction_bias: "source_to_target",
    stability_class: "normal",
    support_events_count: 1,
    contradiction_events_count: 0
  },
  lifecycle: {
    status: "active",
    retirement_rule: "manual"
  },
  legitimacy: {
    evidence_basis: ["evidence-1"],
    governance_class: "recall_allowed"
  },
  created_at: validTimestamp,
  updated_at: validTimestamp
} as const;

describe("protocol boundary audit contracts", () => {
  it("rejects unknown fields on public object schemas instead of stripping them", () => {
    expect(WorkspaceSchema.safeParse({ ...workspace, injected: true }).success).toBe(false);
    expect(EnginePortMessageSchema.safeParse({ role: "user", content: "hi", injected: true }).success).toBe(false);
    expect(EngineMessageSchema.safeParse({ role: "assistant", content: "hi", message_id: "m1", injected: true }).success).toBe(false);
    expect(MemoryEntrySchema.safeParse({ ...memoryEntry, injected: true }).success).toBe(false);
  });

  it("bounds public string fields that can cross package or MCP boundaries", () => {
    expect(WorkspaceSchema.safeParse({ ...workspace, name: "x".repeat(257) }).success).toBe(false);
    expect(WorkspaceSchema.safeParse({ ...workspace, root_path: "x".repeat(4097) }).success).toBe(false);
    expect(EnginePortMessageSchema.safeParse({ role: "user", content: "x".repeat(65_537) }).success).toBe(false);
    expect(EngineMessageSchema.safeParse({ role: "assistant", content: "x".repeat(65_537), message_id: "m1" }).success).toBe(false);
  });

  it("keeps open vocabulary fields open while bounding their size", () => {
    expect(PathRelationSchema.parse(pathRelation).constitution.relation_kind).toBe("custom_relation_kind");
    expect(
      PathRelationSchema.safeParse({
        ...pathRelation,
        constitution: {
          ...pathRelation.constitution,
          relation_kind: "x".repeat(1025)
        }
      }).success
    ).toBe(false);
    expect(SoulContextObjectIdentitySchema.parse({ object_id: "memory-1", object_kind: "future_kind" }).object_kind).toBe("future_kind");
  });

  it("rejects semantic cross-field mismatches at the protocol boundary", () => {
    expect(
      MemoryEntrySchema.safeParse({
        ...memoryEntry,
        forget_disposition: ForgetDisposition.COMPRESSED,
        forget_disposition_ref: null
      }).success
    ).toBe(false);
    expect(
      MemoryEntrySchema.safeParse({
        ...memoryEntry,
        forget_disposition: ForgetDisposition.JUDGED_USELESS,
        forget_disposition_ref: "capsule-1"
      }).success
    ).toBe(false);
    expect(
      SoulMemorySearchRequestSchema.safeParse({
        query: "what did I say",
        scope_class: "project",
        dimension: null,
        domain_tags: null,
        max_results: 10,
        since: "2026-06-19T00:00:00.000Z",
        until: "2026-06-18T00:00:00.000Z"
      }).success
    ).toBe(false);
  });

  it("rejects non-finite and out-of-range numeric contract values", () => {
    expect(PathRelationSchema.parse(pathRelation).effect_vector.recall_bias).toBe(-0.4);
    expect(
      PathRelationSchema.safeParse({
        ...pathRelation,
        effect_vector: { ...pathRelation.effect_vector, recall_bias: -1.1 }
      }).success
    ).toBe(false);
    expect(
      PathRelationSchema.safeParse({
        ...pathRelation,
        effect_vector: { ...pathRelation.effect_vector, salience: Number.POSITIVE_INFINITY }
      }).success
    ).toBe(false);
    expect(
      PathRelationSchema.safeParse({
        ...pathRelation,
        plasticity_state: { ...pathRelation.plasticity_state, strength: Number.NaN }
      }).success
    ).toBe(false);
    expect(
      ActivationCandidateSchema.safeParse({
        candidate_id: "candidate-1",
        workspace_id: "workspace-1",
        run_id: "run-1",
        source_path_id: "path-1",
        source_anchor: pathRelation.anchors.source_anchor,
        target_anchor: pathRelation.anchors.target_anchor,
        why_now: "now",
        effect_vector_snapshot: pathRelation.effect_vector,
        pressure: 1.1,
        confidence: 0.5,
        governance_ceiling: "hint_only",
        created_at: validTimestamp
      }).success
    ).toBe(false);
    expect(
      ManifestationBudgetConfigSchema.safeParse({
        workspace_id: "workspace-1",
        stance_bias_cap: 1,
        dialogue_nudge_cap: 1,
        lens_entry_cap: 1,
        escalation_policy: {
          nudge_min_pressure: 0.1,
          nudge_min_confidence: 0.2,
          lens_min_pressure: 0.3,
          lens_min_confidence: Number.POSITIVE_INFINITY,
          lens_requires_task_coupling: true,
          lens_requires_governance_ceiling: true
        },
        updated_at: validTimestamp
      }).success
    ).toBe(false);
  });

  it("bounds Garden task payload records instead of accepting arbitrary values", () => {
    expect(
      GardenPendingTaskSnapshotSchema.safeParse({
        task_id: "task-1",
        role: "host_worker",
        kind: "POST_TURN_EXTRACT",
        created_at: validTimestamp,
        payload: "not-an-object"
      }).success
    ).toBe(false);
    expect(
      GardenClaimTaskResponseSchema.safeParse({
        status: "claimed",
        task_id: "task-1",
        role: "host_worker",
        kind: "POST_TURN_EXTRACT",
        payload: { turn_digest: { text: "x".repeat(20_000) } }
      }).success
    ).toBe(false);
    expect(
      GardenTaskDescriptorSchema.safeParse({
        task_id: "task-1",
        task_kind: "post_turn_extract",
        required_tier: "tier_2",
        workspace_id: "workspace-1",
        run_id: "run-1",
        target_object_refs: [],
        priority: 1,
        created_at: validTimestamp,
        turn_digest: "not-an-object"
      }).success
    ).toBe(false);
  });

  it("rejects unknown fields on nested conversation request objects", () => {
    const request = {
      messages: [{ role: "user", content: "hi" }],
      systemPrompt: "system",
      contextLens: null,
      binding: {
        binding_id: "binding-1",
        provider: "openai",
        model: "model-1",
        api_key: "key-1",
        config: {}
      },
      runtime_context: {
        workspace_id: "workspace-1",
        run_id: "run-1",
        surface_id: null,
        user_message_id: "message-1",
        injected: true
      }
    } as const;

    expect(ConversationRequestSchema.safeParse(request).success).toBe(false);
  });
});
