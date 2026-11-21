import {
  resetSchedulers,
  currentScheduler,
  getService,
  type CapturedScheduler
} from "./runtime-scheduler-mock-fixture.js";
import { createGardenRuntime } from "../../garden/runtime/runtime.js";
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import {
  GardenRole,
  GardenTaskKind,
  GardenTier,
  type GardenTaskDescriptor
} from "@do-soul/alaya-protocol";
import { EmbeddingBackfillPartialFailureError } from "@do-soul/alaya-core";
import { createRuntimeInput } from "./runtime-fixture.js";
import { StorageError } from "@do-soul/alaya-storage";


describe("garden runtime targeted embedding backfill pass", () => {
  beforeEach(() => {
    resetSchedulers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function seedQueueTask(
      scheduler: CapturedScheduler,
      taskKind: GardenTaskDescriptor["task_kind"],
      taskId: string,
      workspaceId = "workspace-1"
    ): void {
      scheduler.queue.push({
        task_id: taskId,
        task_kind: taskKind,
        required_tier: GardenTier.TIER_2,
        workspace_id: workspaceId,
        run_id: null,
        target_object_refs: [workspaceId],
        priority: 10,
        created_at: "2026-06-01T00:00:00.000Z"
      } as GardenTaskDescriptor);
    }

  
  it("dispatches only EMBEDDING_BACKFILL and never touches other Librarian kinds already queued", async () => {
    const embeddingBackfillHandler = {
      handle: vi.fn(async () => ({
        outcome: "completed" as const, errorMessage: null,
        objectsAffected: ["memory-1", "memory-2"],
        auditEntries: ["embedding_upserted:memory-1", "embedding_upserted:memory-2"]
      }))
    };
    const runtime = createGardenRuntime(
      createRuntimeInput({
        embeddingBackfillHandler
      })
    );
    const scheduler = currentScheduler();

    seedQueueTask(scheduler, GardenTaskKind.BULK_ENRICH, "task-bulk-enrich");
    seedQueueTask(scheduler, GardenTaskKind.MERGE_PROPOSAL, "task-merge");
    seedQueueTask(scheduler, GardenTaskKind.PATH_PLASTICITY_UPDATE, "task-plasticity");
    seedQueueTask(scheduler, GardenTaskKind.PATH_GRAPH_SNAPSHOT, "task-snapshot");
    seedQueueTask(scheduler, GardenTaskKind.CONSOLIDATION_CYCLE, "task-consolidation");

    await runtime.runEmbeddingBackfillPass("workspace-1", "cache_only");

    expect(embeddingBackfillHandler.handle).toHaveBeenCalledTimes(1);
    expect(embeddingBackfillHandler.handle).toHaveBeenCalledWith(
      expect.objectContaining({ workspace_id: "workspace-1" })
    );

    expect(scheduler.completions).toHaveLength(1);
    expect(scheduler.completions[0]).toEqual(
      expect.objectContaining({
        task_kind: GardenTaskKind.EMBEDDING_BACKFILL,
        role: GardenRole.LIBRARIAN,
        tier: GardenTier.TIER_2,
        success: true
      })
    );

    const remainingKinds = scheduler.queue.map((task) => task.task_kind).sort();
    expect(remainingKinds).toEqual(
      [
        GardenTaskKind.BULK_ENRICH,
        GardenTaskKind.CONSOLIDATION_CYCLE,
        GardenTaskKind.MERGE_PROPOSAL,
        GardenTaskKind.PATH_GRAPH_SNAPSHOT,
        GardenTaskKind.PATH_PLASTICITY_UPDATE
      ].sort()
    );

    expect(runtime.getStatus().last_pass_at).toBeNull();
  });

  it("drains only the requested workspace's EMBEDDING_BACKFILL and leaves another workspace's same-kind task queued", async () => {
    const embeddingBackfillHandler = {
      handle: vi.fn(async (task: { workspace_id: string }) => ({
        outcome: "completed" as const, errorMessage: null,
        objectsAffected: [`memory-${task.workspace_id}`],
        auditEntries: [`embedding_upserted:memory-${task.workspace_id}`]
      }))
    };
    const runtime = createGardenRuntime(
      createRuntimeInput({
        embeddingBackfillHandler
      })
    );
    const scheduler = currentScheduler();

    seedQueueTask(scheduler, GardenTaskKind.EMBEDDING_BACKFILL, "task-backfill-B", "workspace-B");

    await runtime.runEmbeddingBackfillPass("workspace-A");

    expect(embeddingBackfillHandler.handle).toHaveBeenCalledTimes(1);
    expect(embeddingBackfillHandler.handle).toHaveBeenCalledWith(
      expect.objectContaining({ workspace_id: "workspace-A" })
    );

    expect(scheduler.completions).toHaveLength(1);
    expect(scheduler.completions[0]).toEqual(
      expect.objectContaining({
        task_kind: GardenTaskKind.EMBEDDING_BACKFILL,
        workspace_id: "workspace-A",
        success: true
      })
    );

    const remaining = scheduler.queue.filter(
      (task) => task.task_kind === GardenTaskKind.EMBEDDING_BACKFILL
    );
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.workspace_id).toBe("workspace-B");
  });

  it("drains an existing same-workspace EMBEDDING_BACKFILL without enqueueing a duplicate", async () => {
    const embeddingBackfillHandler = {
      handle: vi.fn(async (task: { workspace_id: string }) => ({
        outcome: "completed" as const, errorMessage: null,
        objectsAffected: [`memory-${task.workspace_id}`],
        auditEntries: [`embedding_upserted:memory-${task.workspace_id}`]
      }))
    };
    const runtime = createGardenRuntime(
      createRuntimeInput({
        embeddingBackfillHandler
      })
    );
    const scheduler = currentScheduler();
    seedQueueTask(scheduler, GardenTaskKind.EMBEDDING_BACKFILL, "task-existing", "workspace-A");

    await runtime.runEmbeddingBackfillPass("workspace-A");

    expect(embeddingBackfillHandler.handle).toHaveBeenCalledTimes(1);
    expect(embeddingBackfillHandler.handle).toHaveBeenCalledWith(
      expect.objectContaining({ task_id: "task-existing", workspace_id: "workspace-A" })
    );
    expect(scheduler.completions).toHaveLength(1);
    expect(scheduler.completions[0]).toEqual(
      expect.objectContaining({
        task_id: "task-existing",
        task_kind: GardenTaskKind.EMBEDDING_BACKFILL,
        workspace_id: "workspace-A",
        success: true
      })
    );
    expect(scheduler.queue.filter((task) => task.workspace_id === "workspace-A")).toEqual([]);
  });

  it("surfaces provider-unavailable audit reasons to targeted warmup callers", async () => {
    const embeddingBackfillHandler = {
      handle: vi.fn(async () => ({
        outcome: "failed" as const, errorMessage: "embedding_backfill_skipped:provider_unavailable",
        objectsAffected: [],
        auditEntries: ["embedding_backfill_skipped:provider_unavailable"]
      }))
    };
    const runtime = createGardenRuntime(
      createRuntimeInput({
        embeddingBackfillHandler
      })
    );
    const scheduler = currentScheduler();

    await expect(runtime.runEmbeddingBackfillPass("workspace-1")).rejects.toThrow(
      "embedding_backfill_skipped:provider_unavailable"
    );
    expect(scheduler.completions).toHaveLength(1);
    expect(scheduler.completions[0]).toEqual(
      expect.objectContaining({
        success: false,
        outcome: "failed",
        audit_entries: ["embedding_backfill_skipped:provider_unavailable"]
      })
    );
  });

  it("logs a bounded secret-safe causal chain and the failing backfill phase", async () => {
    const warn = vi.fn();
    const cause = Object.assign(
      new Error("sqlite write failed at /home/alice/private.db token=super-secret"),
      { code: "SQLITE_CONSTRAINT" }
    );
    const error = new Error("Failed to append event log entry.", { cause });
    const runtime = createGardenRuntime({
      ...createRuntimeInput({
        embeddingBackfillHandler: { handle: vi.fn(async () => { throw error; }) }
      }),
      warn
    });

    await expect(runtime.runEmbeddingBackfillPass("workspace-1")).rejects.toThrow(
      "Failed to append event log entry."
    );

    expect(warn).toHaveBeenCalledWith(
      "embedding backfill task failed; continuing Garden background pass",
      expect.objectContaining({
        workspace_id: "workspace-1",
        phase: "backfill",
        error: {
          name: "Error",
          code: null,
          message: "Failed to append event log entry.",
          cause_chain: [{
            name: "Error",
            code: "SQLITE_CONSTRAINT",
            message: expect.not.stringMatching(/alice|private\.db|super-secret/u)
          }]
        }
      })
    );
    const completion = currentScheduler().completions.at(-1);
    expect(completion?.error_message).not.toMatch(/alice|private\.db|super-secret/u);
  });
  it("fails before configured formation when a durable checkpoint is unavailable", async () => {
    const warn = vi.fn();
    const runtime = createGardenRuntime({
      ...createRuntimeInput({
        embeddingBackfillHandler: {
          handle: vi.fn(async () => ({
            outcome: "completed" as const, errorMessage: null,
            objectsAffected: ["memory-1", "memory-2"],
            auditEntries: []
          }))
        }
      }),
      answersWithEdgeProducerPort: {
        prepareForBackfill: vi.fn(async () => { throw new Error("must not prepare without a checkpoint"); })
      },
      warn
    });
    const scheduler = currentScheduler();
    const reportCompletion = scheduler.reportCompletion.bind(scheduler);
    const sqliteBusy = Object.assign(new Error("database is locked"), {
      code: "SQLITE_BUSY"
    });
    vi.spyOn(scheduler, "reportCompletion")
      .mockRejectedValueOnce(
        new StorageError("QUERY_FAILED", "Failed to append event log entry.", sqliteBusy)
      )
      .mockImplementation(reportCompletion);

    await expect(runtime.runEmbeddingBackfillPass("workspace-1")).rejects.toThrow(/checkpoint is not configured/);

    expect(warn.mock.calls.map((call) => call[1]?.phase)).toEqual(["backfill", "completion"]);
    expect(scheduler.completions).toContainEqual(expect.objectContaining({
      outcome: "failed", success: false, error_message: "Garden embedding follow-up checkpoint is not configured."
    }));
  });

  it("fails loud without rewriting the work outcome when completion retries exhaust", async () => {
    const warn = vi.fn();
    const runtime = createGardenRuntime({
      ...createRuntimeInput({
        embeddingBackfillHandler: {
          handle: vi.fn(async () => ({ outcome: "completed" as const, errorMessage: null,
            objectsAffected: ["memory-1"], auditEntries: [] }))
        }
      }),
      warn
    });
    const scheduler = currentScheduler();
    vi.spyOn(scheduler, "reportCompletion").mockRejectedValue(
      Object.assign(new Error("database is busy"), { code: "SQLITE_BUSY" })
    );

    await expect(runtime.runEmbeddingBackfillPass("workspace-1")).rejects.toThrow(
      /completion persistence failed/u
    );
    expect(warn).not.toHaveBeenCalledWith(
      "embedding backfill task failed; continuing Garden background pass",
      expect.anything()
    );
  });

  
  it("surfaces item-level provider failure reasons to targeted warmup callers", async () => {
    const embeddingBackfillHandler = {
      handle: vi.fn(async () => ({
        outcome: "failed" as const, errorMessage: "embedding_failed:provider:memory-bad:provider rejected input",
        objectsAffected: [],
        auditEntries: ["embedding_failed:provider:memory-bad:provider rejected input"]
      }))
    };
    const runtime = createGardenRuntime(
      createRuntimeInput({
        embeddingBackfillHandler
      })
    );
    const scheduler = currentScheduler();

    await expect(runtime.runEmbeddingBackfillPass("workspace-1")).rejects.toThrow(
      "embedding_failed:provider:memory-bad:provider rejected input"
    );
    expect(scheduler.completions).toHaveLength(1);
    expect(scheduler.completions[0]).toEqual(
      expect.objectContaining({
        success: false,
        outcome: "failed",
        audit_entries: ["embedding_failed:provider:memory-bad:provider rejected input"]
      })
    );
  });

  it("includes partial durable side effects in failed EMBEDDING_BACKFILL completions", async () => {
    const partialFailure = new EmbeddingBackfillPartialFailureError({
      workspaceId: "workspace-1",
      failedObjectId: "memory-failed",
      message: "sqlite write failed",
      objectsAffected: ["memory-ok"],
      auditEntries: [
        "embedding_upserted:memory-ok",
        "embedding_failed:persistence:memory-failed:sqlite write failed"
      ],
      cause: new Error("sqlite write failed")
    });
    const embeddingBackfillHandler = {
      handle: vi.fn(async () => {
        throw partialFailure;
      })
    };
    const runtime = createGardenRuntime(
      createRuntimeInput({
        embeddingBackfillHandler
      })
    );
    const scheduler = currentScheduler();

    await expect(runtime.runEmbeddingBackfillPass("workspace-1")).rejects.toThrow("sqlite write failed");

    expect(scheduler.completions).toHaveLength(1);
    expect(scheduler.completions[0]).toEqual(
      expect.objectContaining({
        task_kind: GardenTaskKind.EMBEDDING_BACKFILL,
        success: false,
        objects_affected: ["memory-ok"],
        audit_entries: [
          "embedding_upserted:memory-ok",
          "embedding_failed:persistence:memory-failed:sqlite write failed"
        ],
        error_message: "embedding_backfill_failed:persistence:memory-failed:sqlite write failed"
      })
    );
  });

  it("reports missing embedding backfill configuration to a targeted caller", async () => {
    const runtime = createGardenRuntime(createRuntimeInput());
    const scheduler = currentScheduler();

    await expect(runtime.runEmbeddingBackfillPass("workspace-1")).rejects.toThrow(/handler is not configured/);

    expect(scheduler.queue).toHaveLength(0);
    expect(scheduler.completions).toHaveLength(0);
    expect(runtime.getStatus().last_pass_at).toBeNull();
  });

  it("records and propagates a failed backfill completion", async () => {
    const embeddingBackfillHandler = {
      handle: vi.fn(async () => {
        throw new Error("embedding provider unreachable");
      })
    };
    const runtime = createGardenRuntime(
      createRuntimeInput({
        embeddingBackfillHandler
      })
    );
    const scheduler = currentScheduler();

    await expect(runtime.runEmbeddingBackfillPass("workspace-1")).rejects.toThrow(
      "embedding provider unreachable"
    );

    expect(embeddingBackfillHandler.handle).toHaveBeenCalledTimes(1);
    expect(scheduler.completions).toHaveLength(1);
    expect(scheduler.completions[0]).toEqual(
      expect.objectContaining({
        task_kind: GardenTaskKind.EMBEDDING_BACKFILL,
        success: false,
        error_message: "embedding provider unreachable"
      })
    );
    expect(runtime.getStatus().last_pass_at).toBeNull();
  });

  it("stops at eight backfill dispatches with requeued work retained", async () => {
    const handle = vi.fn(async (task: GardenTaskDescriptor) => {
      currentScheduler().queue.push({ ...task, task_id: `${task.task_id}-next` });
      return { outcome: "skipped" as const, errorMessage: null, objectsAffected: [], auditEntries: [] };
    });
    const runtime = createGardenRuntime(createRuntimeInput({ embeddingBackfillHandler: { handle } }));
    await runtime.runEmbeddingBackfillPass("workspace-1");
    expect(handle).toHaveBeenCalledTimes(8);
    expect(currentScheduler().completions).toHaveLength(8);
    expect(currentScheduler().queue).toHaveLength(1);
  });

  it("allows a later backfill after enqueue fails", async () => {
    const handle = vi.fn(async () => ({ outcome: "skipped" as const, errorMessage: null, objectsAffected: [], auditEntries: [] }));
    const runtime = createGardenRuntime(createRuntimeInput({ embeddingBackfillHandler: { handle } }));
    const scheduler = currentScheduler();
    vi.spyOn(scheduler, "enqueue").mockImplementationOnce(() => { throw new Error("queue unavailable"); });
    await expect(runtime.runEmbeddingBackfillPass("workspace-1")).rejects.toThrow("queue unavailable");
    await runtime.runEmbeddingBackfillPass("workspace-1");
    expect(handle).toHaveBeenCalledTimes(1);
  });
});
