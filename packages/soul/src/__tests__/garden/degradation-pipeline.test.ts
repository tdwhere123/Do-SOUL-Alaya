import { describe, expect, it } from "vitest";
import {
  ControlPlaneObjectKind,
  ObjectKind,
  RetentionPolicy,
  ScopeClass,
  type ContextLens,
  type ContextLensEntry,
  type ProjectionEntry,
  type WorkingProjection
} from "@do-soul/alaya-protocol";
import { DegradationPipeline } from "../../garden/degradation-pipeline.js";

const RUNTIME_ID = "00000000-0000-4000-8000-000000000001";
const EXPIRES_AT = "2026-03-25T12:30:00.000Z";

describe("DegradationPipeline", () => {
  it("returns degraded false when the projection is already within budget", () => {
    const pipeline = new DegradationPipeline();
    const params = createAssessParams({
      entries: [createEntry({ object_id: "memory-1" })],
      projectionEntries: [createProjectionEntry("memory-1", ObjectKind.MEMORY_ENTRY, 12)],
      totalTokens: 12,
      budgetLimit: 20
    });

    const result = pipeline.assess(params);

    expect(result.degraded).toBe(false);
    expect(result.finalLens).toEqual(params.contextLens);
    expect(result.stepsApplied).toEqual([]);
    expect(result.tokensAfter).toBe(12);
    expect(result.stillOverBudget).toBe(false);
  });

  it("downgrades full_eligible entries to excerpt and stops once the budget is satisfied", () => {
    const pipeline = new DegradationPipeline();
    const result = pipeline.assess(
      createAssessParams({
        entries: [createEntry({ object_id: "memory-1", manifestation: "full_eligible" })],
        projectionEntries: [createProjectionEntry("memory-1", ObjectKind.MEMORY_ENTRY, 20)],
        totalTokens: 20,
        budgetLimit: 10
      })
    );

    expect(result.stepsApplied).toEqual([
      expect.objectContaining({
        kind: "manifestation_downgrade_excerpt",
        object_ids_affected: ["memory-1"],
        tokens_freed: 13
      })
    ]);
    expect(result.finalLens.lens_entries[0]?.manifestation).toBe("excerpt");
    expect(result.tokensAfter).toBe(7);
    expect(result.stillOverBudget).toBe(false);
  });

  it("continues from excerpt to hint when excerpt is still over budget", () => {
    const pipeline = new DegradationPipeline();
    const result = pipeline.assess(
      createAssessParams({
        entries: [createEntry({ object_id: "memory-1", manifestation: "full_eligible" })],
        projectionEntries: [createProjectionEntry("memory-1", ObjectKind.MEMORY_ENTRY, 40)],
        totalTokens: 40,
        budgetLimit: 3
      })
    );

    expect(result.stepsApplied.map((step) => step.kind)).toEqual([
      "manifestation_downgrade_excerpt",
      "manifestation_downgrade_hint"
    ]);
    expect(result.finalLens.lens_entries[0]?.manifestation).toBe("hint");
    expect(result.tokensAfter).toBe(2);
    expect(result.droppedObjectIds).toEqual([]);
  });

  it("removes handoff and gap entries when manifestation downgrades are insufficient", () => {
    const pipeline = new DegradationPipeline();
    const result = pipeline.assess(
      createAssessParams({
        entries: [
          createProtectedTaskSurfaceEntry(),
          createEntry({ object_id: "handoff-1", object_kind: ControlPlaneObjectKind.HANDOFF_RECORD, manifestation: "hint" }),
          createEntry({ object_id: "gap-1", object_kind: ControlPlaneObjectKind.GAP_RECORD, manifestation: "hint" })
        ],
        projectionEntries: [
          createProjectionEntry("surface-1", ControlPlaneObjectKind.TASK_OBJECT_SURFACE, 8),
          createProjectionEntry("handoff-1", ControlPlaneObjectKind.HANDOFF_RECORD, 18),
          createProjectionEntry("gap-1", ControlPlaneObjectKind.GAP_RECORD, 14)
        ],
        totalTokens: 40,
        budgetLimit: 10
      })
    );

    expect(result.stepsApplied).toEqual([
      expect.objectContaining({
        kind: "handoff_pointer_ify",
        object_ids_affected: ["handoff-1", "gap-1"],
        tokens_freed: 32
      })
    ]);
    expect(result.finalLens.lens_entries.map((entry) => entry.object_id)).toEqual(["surface-1"]);
  });

  it("drops synthesis, then claim forms, then global entries in order", () => {
    const pipeline = new DegradationPipeline();
    const result = pipeline.assess(
      createAssessParams({
        entries: [
          createProtectedTaskSurfaceEntry(),
          createEntry({ object_id: "synthesis-1", object_kind: ObjectKind.SYNTHESIS_CAPSULE, manifestation: "hint" }),
          createEntry({ object_id: "claim-1", object_kind: ObjectKind.CLAIM_FORM, manifestation: "hint" }),
          createEntry({
            object_id: "global-1",
            manifestation: "hint",
            scope_class: ScopeClass.GLOBAL_DOMAIN
          })
        ],
        projectionEntries: [
          createProjectionEntry("surface-1", ControlPlaneObjectKind.TASK_OBJECT_SURFACE, 10),
          createProjectionEntry("synthesis-1", ObjectKind.SYNTHESIS_CAPSULE, 30),
          createProjectionEntry("claim-1", ObjectKind.CLAIM_FORM, 12),
          createProjectionEntry("global-1", ObjectKind.MEMORY_ENTRY, 9)
        ],
        totalTokens: 61,
        budgetLimit: 10
      })
    );

    expect(result.stepsApplied.map((step) => step.kind)).toEqual([
      "synthesis_ref",
      "preferred_claim_trim",
      "soft_global_clean"
    ]);
    expect(result.finalLens.lens_entries.map((entry) => entry.object_id)).toEqual(["surface-1"]);
    expect(result.droppedObjectIds).toEqual(["synthesis-1", "claim-1", "global-1"]);
    expect(result.stillOverBudget).toBe(false);
  });


  it("preferred_claim_trim keeps full_eligible strict claims while trimming downgraded preferred claims", () => {
    const pipeline = new DegradationPipeline();
    const result = pipeline.assess(
      createAssessParams({
        entries: [
          createProtectedTaskSurfaceEntry(),
          createEntry({
            object_id: "claim-full-strict",
            object_kind: ObjectKind.CLAIM_FORM,
            manifestation: "full_eligible",
            relevance_score: 0.7,
            source_enforcement: "strict",
            scope_class: ScopeClass.PROJECT
          }),
          createEntry({
            object_id: "claim-hint",
            object_kind: ObjectKind.CLAIM_FORM,
            manifestation: "hint",
            relevance_score: 0.6
          })
        ],
        projectionEntries: [
          createProjectionEntry("surface-1", ControlPlaneObjectKind.TASK_OBJECT_SURFACE, 10),
          createProjectionEntry("claim-full-strict", ObjectKind.CLAIM_FORM, 12),
          createProjectionEntry("claim-hint", ObjectKind.CLAIM_FORM, 9)
        ],
        totalTokens: 31,
        budgetLimit: 15
      })
    );

    expect(result.stepsApplied.map((step) => step.kind)).toEqual(["preferred_claim_trim"]);
    expect(result.finalLens.lens_entries.map((entry) => entry.object_id)).toEqual([
      "surface-1",
      "claim-full-strict"
    ]);
    expect(result.finalLens.lens_entries[1]?.manifestation).toBe("full_eligible");
    expect(result.droppedObjectIds).toEqual(["claim-hint"]);
    expect(result.stillOverBudget).toBe(true);
  });

  it("never touches protected entries and reports stillOverBudget when only protected entries remain", () => {
    const pipeline = new DegradationPipeline();
    const result = pipeline.assess(
      createAssessParams({
        entries: [
          createProtectedTaskSurfaceEntry(),
          createEntry({
            object_id: "override-1",
            object_kind: ControlPlaneObjectKind.SESSION_OVERRIDE,
            manifestation: "full_eligible"
          }),
          createEntry({
            object_id: "claim-strict",
            object_kind: ObjectKind.CLAIM_FORM,
            relevance_score: 1,
            manifestation: "full_eligible",
            source_enforcement: "strict",
            scope_class: ScopeClass.PROJECT
          }),
          createEntry({
            object_id: "global-1",
            manifestation: "full_eligible",
            scope_class: ScopeClass.GLOBAL_DOMAIN
          })
        ],
        projectionEntries: [
          createProjectionEntry("surface-1", ControlPlaneObjectKind.TASK_OBJECT_SURFACE, 10),
          createProjectionEntry("override-1", ControlPlaneObjectKind.SESSION_OVERRIDE, 11),
          createProjectionEntry("claim-strict", ObjectKind.CLAIM_FORM, 13),
          createProjectionEntry("global-1", ObjectKind.MEMORY_ENTRY, 20)
        ],
        totalTokens: 54,
        budgetLimit: 20
      })
    );

    expect(result.protectedObjectIds).toEqual(expect.arrayContaining(["surface-1", "override-1", "claim-strict"]));
    expect(result.finalLens.lens_entries.map((entry) => entry.object_id)).toEqual([
      "surface-1",
      "override-1",
      "claim-strict"
    ]);
    expect(result.droppedObjectIds).toContain("global-1");
    expect(result.droppedObjectIds).not.toContain("claim-strict");
    expect(result.stillOverBudget).toBe(true);
  });

  it("applies every eligible entry in a step before moving on", () => {
    const pipeline = new DegradationPipeline();
    const result = pipeline.assess(
      createAssessParams({
        entries: [
          createEntry({ object_id: "memory-1", manifestation: "full_eligible" }),
          createEntry({ object_id: "memory-2", manifestation: "full_eligible" }),
          createEntry({ object_id: "claim-1", object_kind: ObjectKind.CLAIM_FORM, manifestation: "excerpt" })
        ],
        projectionEntries: [
          createProjectionEntry("memory-1", ObjectKind.MEMORY_ENTRY, 18),
          createProjectionEntry("memory-2", ObjectKind.MEMORY_ENTRY, 18),
          createProjectionEntry("claim-1", ObjectKind.CLAIM_FORM, 8)
        ],
        totalTokens: 44,
        budgetLimit: 10
      })
    );

    expect(result.stepsApplied[0]).toEqual(
      expect.objectContaining({
        kind: "manifestation_downgrade_excerpt",
        object_ids_affected: ["memory-1", "memory-2"]
      })
    );
    expect(result.stepsApplied[1]).toEqual(
      expect.objectContaining({
        kind: "manifestation_downgrade_hint",
        object_ids_affected: ["memory-1", "memory-2", "claim-1"]
      })
    );
    expect(result.tokensAfter).toBe(3);
  });
});

function createAssessParams(input: {
  entries: readonly ContextLensEntry[];
  projectionEntries: readonly ProjectionEntry[];
  totalTokens: number;
  budgetLimit: number;
}) {
  const contextLens = createContextLens(input.entries);
  const workingProjection = createWorkingProjection(input.projectionEntries, input.totalTokens);

  return {
    contextLens,
    workingProjection,
    budgetLimit: input.budgetLimit,
    runId: "run-1",
    workspaceId: "workspace-1"
  };
}

function createContextLens(entries: readonly ContextLensEntry[]): ContextLens {
  return {
    runtime_id: RUNTIME_ID,
    object_kind: ControlPlaneObjectKind.CONTEXT_LENS,
    task_surface_ref: "surface-1",
    expires_at: EXPIRES_AT,
    derived_from: "surface-1",
    retention_policy: RetentionPolicy.SESSION_ONLY,
    lens_entries: Object.freeze([...entries]),
    not_a_priority_source: true
  };
}

function createWorkingProjection(entries: readonly ProjectionEntry[], totalTokens: number): WorkingProjection {
  return {
    runtime_id: "00000000-0000-4000-8000-000000000002",
    object_kind: ControlPlaneObjectKind.WORKING_PROJECTION,
    task_surface_ref: "surface-1",
    expires_at: EXPIRES_AT,
    derived_from: RUNTIME_ID,
    retention_policy: RetentionPolicy.SESSION_ONLY,
    entries: Object.freeze([...entries]),
    total_token_estimate: totalTokens,
    recall_policy_ref: null
  };
}

function createEntry(overrides: Partial<ContextLensEntry> & Pick<ContextLensEntry, "object_id">): ContextLensEntry {
  return {
    object_id: overrides.object_id,
    object_kind: overrides.object_kind ?? ObjectKind.MEMORY_ENTRY,
    relevance_score: overrides.relevance_score ?? 0.7,
    manifestation: overrides.manifestation ?? "excerpt",
    scope_class: overrides.scope_class,
    source_enforcement: overrides.source_enforcement
  };
}

function createProtectedTaskSurfaceEntry(): ContextLensEntry {
  return {
    object_id: "surface-1",
    object_kind: ControlPlaneObjectKind.TASK_OBJECT_SURFACE,
    relevance_score: 1,
    manifestation: "full_eligible"
  };
}

function createProjectionEntry(objectId: string, objectKind: string, tokenEstimate: number): ProjectionEntry {
  return {
    object_id: objectId,
    object_kind: objectKind,
    content_snapshot: objectKind + ":" + objectId,
    token_estimate: tokenEstimate
  };
}
