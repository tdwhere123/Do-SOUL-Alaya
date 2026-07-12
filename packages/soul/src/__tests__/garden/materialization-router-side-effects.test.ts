import { describe, expect, it, vi } from "vitest";
import { MaterializationRouter } from "@do-soul/alaya-soul";
import {
  type EnqueueFn,
  type MockCreatedObjectWithEnrich,
  createDeps,
  createSignal
} from "./materialization-router-fixture.js";

describe("MaterializationRouter side effects and projections", () => {
  it("materializes memory_and_claim by creating evidence, memory, and claim objects", async () => {
    const deps = createDeps();
    const router = new MaterializationRouter(deps);

    const result = await router.materializeSignal(createSignal());

    expect(result).toMatchObject({
      signal_id: "signal-1",
      target_kind: "memory_and_claim",
      success: true
    });
    expect(result.created_objects).toEqual([
      { object_kind: "evidence_capsule", object_id: "evidence-1" },
      { object_kind: "memory_entry", object_id: "memory-1" },
      { object_kind: "claim_form", object_id: "claim-1" }
    ]);
    expect(deps.evidenceService.create).toHaveBeenCalledTimes(1);
    expect(deps.memoryService.create).toHaveBeenCalledTimes(1);
    expect(deps.claimService.create).toHaveBeenCalledTimes(1);

    const evidenceInput = deps.evidenceService.create.mock.calls[0]![0] as {
      readonly gist: string;
      readonly semantic_anchor: { readonly summary: string };
      readonly physical_anchor: { readonly artifact_ref: string } | null;
    };
    const memoryInput = deps.memoryService.create.mock.calls[0]![0] as {
      readonly content: string;
    };
    const claimInput = deps.claimService.create.mock.calls[0]![0] as {
      readonly proposition_digest: string;
    };

    expect(evidenceInput.gist).toBe("Never print secrets.");
    expect(evidenceInput.semantic_anchor.summary).toBe("Never print secrets.");
    expect(evidenceInput.physical_anchor?.artifact_ref).toBe("msg-1");
    expect(memoryInput.content).toBe("Never print secrets.");
    expect(claimInput.proposition_digest).toBe("Never print secrets.");
  });


  it("deletes already-created evidence when memory creation fails after evidence creation", async () => {
    const deps = createDeps();
    deps.memoryService.create.mockRejectedValueOnce(new Error("memory create failed"));
    const router = new MaterializationRouter(deps);

    const result = await router.materializeSignal(createSignal());

    expect(result).toMatchObject({
      signal_id: "signal-1",
      target_kind: "memory_and_claim",
      success: false,
      error: "memory create failed"
    });
    expect(result.created_objects).toEqual([]);
    expect(deps.evidenceService.create).toHaveBeenCalledTimes(1);
    expect(deps.evidenceService.deleteCreatedEvidence).toHaveBeenCalledWith("evidence-1");
    expect(deps.memoryService.create).toHaveBeenCalledTimes(1);
    expect(deps.claimService.create).not.toHaveBeenCalled();
  });

  it("keeps evidence visible in created_objects when compensation delete fails", async () => {
    const deps = createDeps();
    deps.memoryService.create.mockRejectedValueOnce(new Error("memory create failed"));
    deps.evidenceService.deleteCreatedEvidence.mockRejectedValueOnce(new Error("delete failed"));
    const router = new MaterializationRouter(deps);

    const result = await router.materializeSignal(createSignal());

    expect(result).toMatchObject({
      signal_id: "signal-1",
      target_kind: "memory_and_claim",
      success: false,
      error: "delete failed"
    });
    expect(result.created_objects).toEqual([
      { object_kind: "evidence_capsule", object_id: "evidence-1" }
    ]);
    expect(deps.evidenceService.deleteCreatedEvidence).toHaveBeenCalledWith("evidence-1");
    expect(deps.claimService.create).not.toHaveBeenCalled();
  });


  it("enqueues enrichment after memory_and_claim creates a memory entry (no inline enrichment)", async () => {
    const deps = createDeps();
    const enrichPendingPort = { enqueue: vi.fn<EnqueueFn>(() => undefined) };
    const router = new MaterializationRouter({ ...deps, enrichPendingPort });

    await router.materializeSignal(createSignal());

    expect(enrichPendingPort.enqueue).toHaveBeenCalledTimes(1);
    expect(enrichPendingPort.enqueue).toHaveBeenCalledWith({
      memoryId: "memory-1",
      workspaceId: "workspace-1",
      runId: "run-1",
      sourceSignalId: "signal-1"
    });
  });


  it("passes the enrichment intent on the create input so the marker commits atomically", async () => {
    const deps = createDeps();
    const enrichPendingPort = { enqueue: vi.fn<EnqueueFn>(() => undefined) };
    const router = new MaterializationRouter({ ...deps, enrichPendingPort });

    await router.materializeSignal(createSignal());

    const memoryInput = deps.memoryService.create.mock.calls[0]![0] as {
      readonly enqueueEnrichment?: { readonly runId: string | null; readonly sourceSignalId: string | null };
    };
    expect(memoryInput.enqueueEnrichment).toEqual({ runId: "run-1", sourceSignalId: "signal-1" });
  });

  it("passes temporal projection metadata into memory create input", async () => {
    const deps = createDeps();
    const router = new MaterializationRouter(deps);

    await router.materializeSignal(createSignal({
      raw_payload: {
        excerpt: "The deployment happened yesterday.",
        temporal_projection: {
          projection_schema_version: 1,
          event_time_start: "2026-03-19T00:00:00.000Z",
          event_time_end: "2026-03-20T00:00:00.000Z",
          valid_from: "2026-03-19T00:00:00.000Z",
          valid_to: "2026-03-20T00:00:00.000Z",
          time_precision: "day",
          time_source: "relative_resolved"
        }
      }
    }));

    const memoryInput = deps.memoryService.create.mock.calls[0]![0] as {
      readonly event_time_start?: string;
      readonly event_time_end?: string;
      readonly valid_from?: string;
      readonly valid_to?: string;
      readonly time_precision?: string;
      readonly time_source?: string;
      readonly projection_schema_version?: number;
    };
    expect(memoryInput).toMatchObject({
      projection_schema_version: 1,
      event_time_start: "2026-03-19T00:00:00.000Z",
      event_time_end: "2026-03-20T00:00:00.000Z",
      valid_from: "2026-03-19T00:00:00.000Z",
      valid_to: "2026-03-20T00:00:00.000Z",
      time_precision: "day",
      time_source: "relative_resolved"
    });
  });

  it("drops an invalid temporal projection atomically before memory create", async () => {
    const deps = createDeps();
    const router = new MaterializationRouter(deps);

    await router.materializeSignal(createSignal({
      raw_payload: {
        excerpt: "The impossible date was 2026-02-31.",
        temporal_projection: {
          projection_schema_version: 1,
          event_time_start: "2026-02-31",
          event_time_end: "2026-03-01",
          time_precision: "day",
          time_source: "explicit"
        }
      }
    }));

    const memoryInput = deps.memoryService.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(memoryInput.projection_schema_version).toBeUndefined();
    expect(memoryInput.event_time_start).toBeUndefined();
    expect(memoryInput.event_time_end).toBeUndefined();
    expect(memoryInput.time_precision).toBeUndefined();
    expect(memoryInput.time_source).toBeUndefined();
  });

  it("passes preference profile metadata into memory create input", async () => {
    const deps = createDeps();
    const router = new MaterializationRouter(deps);

    await router.materializeSignal(createSignal({
      signal_kind: "potential_preference",
      object_kind: "preference",
      raw_payload: {
        excerpt: "I prefer dark mode.",
        preference_profile: {
          projection_schema_version: 1,
          subject: "operator",
          predicate: "prefer",
          object: "dark mode",
          category: "theme",
          polarity: "positive"
        }
      }
    }));

    const memoryInput = deps.memoryService.create.mock.calls[0]![0] as {
      readonly preference_subject?: string;
      readonly preference_predicate?: string;
      readonly preference_object?: string;
      readonly preference_category?: string;
      readonly preference_polarity?: string;
      readonly projection_schema_version?: number;
    };
    expect(memoryInput).toMatchObject({
      projection_schema_version: 1,
      preference_subject: "operator",
      preference_predicate: "prefer",
      preference_object: "dark mode",
      preference_category: "theme",
      preference_polarity: "positive"
    });
  });


  it("skips the loud fallback enqueue when the create reported it enqueued atomically", async () => {
    const deps = createDeps();
    // The atomic-capable create commits the row + marker in one transaction and
    // reports enrichmentEnqueued: true, so the router must NOT enqueue again.
    deps.memoryService.create = vi.fn<(input: Record<string, unknown>) => Promise<MockCreatedObjectWithEnrich>>(
      async () => ({ object_kind: "memory_entry", object_id: "memory-1", enrichmentEnqueued: true })
    );
    const enrichPendingPort = { enqueue: vi.fn<EnqueueFn>(() => undefined) };
    const router = new MaterializationRouter({ ...deps, enrichPendingPort });

    const result = await router.materializeSignal(createSignal());

    expect(result.success).toBe(true);
    expect(enrichPendingPort.enqueue).not.toHaveBeenCalled();
  });
});
