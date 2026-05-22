import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  GardenEventType,
  GardenRole,
  GardenTaskKind,
  GardenTier,
  RunMode,
  RunState,
  WorkspaceKind,
  WorkspaceState,
  parseGardenEventPayload,
  type GardenRoleValue,
  type GardenTaskDescriptor,
  type GardenTaskKindValue,
  type CandidateMemorySignal,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import { EventPublisher, SignalService } from "@do-soul/alaya-core";
import {
  initDatabase,
  SqliteEventLogRepo,
  SqliteGardenTaskRepo,
  SqliteRunRepo,
  SqliteSignalRepo,
  SqliteWorkspaceRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { createAlayaMcpServer } from "../mcp-server.js";
import {
  createMcpMemoryToolHandler,
  type McpMemoryToolCallContext,
  type McpMemoryToolHandlerDependencies
} from "../mcp-memory-tool-handler.js";

const harnesses = new Set<GardenMcpHarness>();

afterEach(async () => {
  for (const harness of harnesses) {
    await harness.close();
  }
  harnesses.clear();
});

describe("Garden MCP tools", () => {
  it("list returns pending only", async () => {
    const harness = await createGardenMcpHarness();
    harness.enqueueTask("task-pending");
    harness.enqueueTask("task-claimed");
    harness.gardenTaskRepo.claimAtomic("task-claimed", "worker-a", "2026-05-07T00:00:01.000Z");
    harness.enqueueTask("task-completed");
    harness.gardenTaskRepo.claimAtomic("task-completed", "worker-a", "2026-05-07T00:00:02.000Z");
    await harness.gardenTaskRepo.completeWithEvents(
      "task-completed",
      { status: "completed", completed_at: "2026-05-07T00:00:03.000Z" },
      [],
      "worker-a"
    );

    const response = await harness.callTool<GardenListPendingTasksResponse>(
      "garden.list_pending_tasks",
      { limit: 10 }
    );

    expect(response.tasks.map((task) => task.task_id)).toEqual(["task-pending"]);
    expect(response.tasks[0]).not.toHaveProperty("claimed_at");
    expect(response.tasks[0]).not.toHaveProperty("claimed_by");
  });

  it("list respects workspace boundary", async () => {
    const harness = await createGardenMcpHarness();
    harness.enqueueTask("task-workspace-a", { workspace_id: "workspace-a" });
    harness.setContext({ workspaceId: "workspace-b" });

    const response = await harness.callTool<GardenListPendingTasksResponse>(
      "garden.list_pending_tasks",
      { limit: 10 }
    );

    expect(response.tasks).toEqual([]);
  });

  it("claim happy path echoes the task payload", async () => {
    const harness = await createGardenMcpHarness();
    harness.enqueueTask("task-claim", {
      payload: createTaskDescriptor({
        task_id: "task-claim",
        target_object_refs: ["memory-claim"]
      })
    });

    const listed = await harness.callTool<GardenListPendingTasksResponse>(
      "garden.list_pending_tasks",
      { limit: 10 }
    );
    expect(listed.tasks.map((task) => task.task_id)).toContain("task-claim");

    const response = await harness.callTool<GardenClaimTaskResponse>(
      "garden.claim_task",
      { task_id: "task-claim" }
    );

    expect(response).toMatchObject({
      status: "claimed",
      task_id: "task-claim",
      role: GardenRole.JANITOR,
      kind: GardenTaskKind.TTL_CLEANUP
    });
    expect(response.payload).toMatchObject({
      task_id: "task-claim",
      target_object_refs: ["memory-claim"]
    });
  });

  it("claim already-claimed returns the current task snapshot to the same claimant", async () => {
    const harness = await createGardenMcpHarness();
    harness.enqueueTask("task-already-claimed");

    await harness.callTool<GardenClaimTaskResponse>(
      "garden.claim_task",
      { task_id: "task-already-claimed" }
    );
    const response = await harness.callTool<GardenClaimTaskResponse>(
      "garden.claim_task",
      { task_id: "task-already-claimed" }
    );

    expect(response).toMatchObject({
      status: "already_claimed",
      task_id: "task-already-claimed",
      role: GardenRole.JANITOR,
      kind: GardenTaskKind.TTL_CLEANUP
    });
  });

  it("claim already-claimed hides the payload from a different same-workspace claimant", async () => {
    const harness = await createGardenMcpHarness();
    harness.enqueueTask("task-same-workspace-other-claimant", {
      payload: createTaskDescriptor({
        task_id: "task-same-workspace-other-claimant",
        target_object_refs: ["private-memory-ref"]
      })
    });

    await harness.callTool<GardenClaimTaskResponse>(
      "garden.claim_task",
      { task_id: "task-same-workspace-other-claimant" }
    );
    harness.setContext({ agentTarget: "claude-code" });

    const response = await harness.callTool<GardenClaimTaskResponse>(
      "garden.claim_task",
      { task_id: "task-same-workspace-other-claimant" }
    );

    expect(response).toEqual({
      status: "already_claimed",
      task_id: "task-same-workspace-other-claimant",
      role: "unknown",
      kind: "unknown",
      payload: null
    });
    expect(harness.getGardenTask("task-same-workspace-other-claimant")).toMatchObject({
      status: "claimed",
      claimed_by: "garden-worker"
    });
  });

  it("claim cross-workspace returns already_claimed without leaking the foreign payload", async () => {
    const harness = await createGardenMcpHarness();
    harness.enqueueTask("task-foreign", {
      workspace_id: "workspace-a",
      payload: createTaskDescriptor({
        task_id: "task-foreign",
        workspace_id: "workspace-a",
        target_object_refs: ["secret-foreign-memory"]
      })
    });
    harness.setContext({ workspaceId: "workspace-b" });

    const response = await harness.callTool<GardenClaimTaskResponse>(
      "garden.claim_task",
      { task_id: "task-foreign" }
    );

    expect(response).toEqual({
      status: "already_claimed",
      task_id: "task-foreign",
      role: "unknown",
      kind: "unknown",
      payload: null
    });
    expect(harness.getGardenTask("task-foreign").status).toBe("pending");
  });

  it("complete with candidate_signals appends Garden completion and records signals through the review queue", async () => {
    const harness = await createGardenMcpHarness();
    harness.enqueueTask("task-complete-signals", {
      role: GardenRole.LIBRARIAN,
      kind: GardenTaskKind.PATH_PLASTICITY_UPDATE,
      payload: createTaskDescriptor({
        task_id: "task-complete-signals",
        task_kind: GardenTaskKind.PATH_PLASTICITY_UPDATE,
        required_tier: GardenTier.TIER_2
      })
    });
    await harness.callTool<GardenClaimTaskResponse>(
      "garden.claim_task",
      { task_id: "task-complete-signals" }
    );
    const response = await harness.callTool<GardenCompleteTaskResponse>(
      "garden.complete_task",
      {
        task_id: "task-complete-signals",
        status: "completed",
        result_envelope: {
          candidate_signals: [
            {
              signal_kind: "potential_preference",
              object_kind: "memory_entry",
              scope_hint: "project",
              domain_tags: ["garden"],
              confidence: 0.9,
              evidence_refs: ["memory-1"],
              raw_payload: { observation: "Host worker extracted a reusable preference." }
            }
          ],
          notes: "Host worker completed extraction."
        }
      }
    );

    expect(response).toEqual({
      task_id: "task-complete-signals",
      status: "completed",
      events_appended: 1
    });
    const completedEvents = await harness.eventLogRepo.queryByType(
      GardenEventType.SOUL_GARDEN_TASK_COMPLETED
    );
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0]?.payload_json).toMatchObject({
      task_id: "task-complete-signals",
      success: true,
      candidate_signals_count: 1
    });
    const emittedIds = (
      completedEvents[0]?.payload_json as { objects_affected?: readonly string[] }
    )?.objects_affected;
    expect(emittedIds).toBeDefined();
    expect(emittedIds).toHaveLength(1);
    const emittedId = emittedIds![0]!;
    await expect(harness.signalRepo.getById(emittedId)).resolves.toMatchObject({
      signal_id: emittedId,
      workspace_id: "workspace-a",
      source: "garden_compile"
    });
  });

  it("complete with status failed stores last_error_text", async () => {
    const harness = await createGardenMcpHarness();
    harness.enqueueTask("task-failed");
    await harness.callTool<GardenClaimTaskResponse>(
      "garden.claim_task",
      { task_id: "task-failed" }
    );

    const response = await harness.callTool<GardenCompleteTaskResponse>(
      "garden.complete_task",
      {
        task_id: "task-failed",
        status: "failed",
        last_error_text: "host extraction timed out"
      }
    );

    expect(response).toEqual({
      task_id: "task-failed",
      status: "failed",
      events_appended: 1
    });
    expect(harness.getGardenTask("task-failed")).toMatchObject({
      status: "failed",
      last_error_text: "host extraction timed out"
    });
  });

  it("rejects complete_task on a pending task without persisting any signal", async () => {
    const harness = await createGardenMcpHarness();
    harness.enqueueTask("task-not-claimed");
    let captured: unknown;
    try {
      await harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", {
        task_id: "task-not-claimed",
        status: "completed",
        result_envelope: {
          candidate_signals: [
            {
              signal_kind: "potential_preference",
              object_kind: "memory_entry",
              scope_hint: "project",
              domain_tags: ["garden"],
              confidence: 0.9,
              evidence_refs: ["memory-1"],
              raw_payload: { observation: "host worker would have extracted a preference" }
            }
          ]
        }
      });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeDefined();
    const signalRows = (
      harness.database.connection
        .prepare("SELECT COUNT(*) AS n FROM signals")
        .get() as { readonly n: number }
    ).n;
    expect(signalRows).toBe(0);
    expect(harness.getGardenTask("task-not-claimed")).toMatchObject({ status: "pending" });
  });

  it("rejects complete_task from an agent target other than the claimant", async () => {
    const harness = await createGardenMcpHarness();
    harness.enqueueTask("task-cross-claim");
    await harness.callTool<GardenClaimTaskResponse>(
      "garden.claim_task",
      { task_id: "task-cross-claim" }
    );
    harness.setContext({ agentTarget: "claude-code" });
    let captured: unknown;
    try {
      await harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", {
        task_id: "task-cross-claim",
        status: "completed"
      });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeDefined();
    expect(harness.getGardenTask("task-cross-claim")).toMatchObject({ status: "claimed" });
  });

  it("rejects complete_task from a stale claimant after GC reclaim and new claim", async () => {
    const harness = await createGardenMcpHarness();
    harness.enqueueTask("task-reclaimed");
    expect(
      harness.gardenTaskRepo.claimAtomic("task-reclaimed", "garden-worker", "2026-05-07T00:00:00.000Z")
    ).toBe("claimed");
    const abandoned = harness.gardenTaskRepo.peekAbandonedClaims(
      "2026-05-07T00:20:00.000Z",
      5 * 60 * 1000
    );
    await harness.gardenTaskRepo.gcAbandonedClaims(
      abandoned.map((row) => ({
        task_id: row.id,
        claimed_by: row.claimed_by!,
        claimed_at: row.claimed_at!,
        event: {
          event_type: GardenEventType.SOUL_GARDEN_TASK_CLAIM_RECLAIMED,
          entity_type: "garden_task",
          entity_id: row.id,
          workspace_id: row.workspace_id,
          run_id: null,
          caused_by: "garden-mcp-tools-test",
          payload_json: parseGardenEventPayload(GardenEventType.SOUL_GARDEN_TASK_CLAIM_RECLAIMED, {
            task_id: row.id,
            task_kind: row.kind,
            role: row.role,
            tier: GardenTier.TIER_0,
            workspace_id: row.workspace_id,
            run_id: null,
            previous_claimed_by: row.claimed_by!,
            claimed_at: row.claimed_at!,
            stale_after_ms: 5 * 60 * 1000,
            occurred_at: "2026-05-07T00:20:00.000Z"
          })
        }
      }))
    );
    harness.setContext({ agentTarget: "claude-code" });
    await harness.callTool<GardenClaimTaskResponse>("garden.claim_task", { task_id: "task-reclaimed" });
    harness.setContext({ agentTarget: "garden-worker" });

    let captured: unknown;
    try {
      await harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", {
        task_id: "task-reclaimed",
        status: "completed",
        result_envelope: {
          candidate_signals: [
            {
              signal_kind: "potential_preference",
              object_kind: "memory_entry",
              scope_hint: "project",
              domain_tags: ["garden"],
              confidence: 0.9,
              evidence_refs: ["memory-1"],
              raw_payload: { observation: "stale worker result must not persist" }
            }
          ]
        }
      });
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeDefined();
    expect(harness.getGardenTask("task-reclaimed")).toMatchObject({
      status: "claimed",
      claimed_by: "claude-code"
    });
    const signalRows = (
      harness.database.connection
        .prepare("SELECT COUNT(*) AS n FROM signals")
        .get() as { readonly n: number }
    ).n;
    expect(signalRows).toBe(0);
  });

  it("renews the claim lease before candidate signal emission", async () => {
    let gcAttempted = false;
    const harness = await createGardenMcpHarness({
      receiveSignal: async (signal, context) => {
        gcAttempted = true;
        const abandoned = context.gardenTaskRepo.peekAbandonedClaims(
          "2026-05-07T00:20:00.000Z",
          10 * 60 * 1000
        );
        expect(abandoned).toEqual([]);
        expect(
          context.gardenTaskRepo.claimAtomic(
            "task-lease-race",
            "claude-code",
            "2026-05-07T00:20:01.000Z"
          )
        ).toBe("already-claimed");
        return await context.signalService.receiveSignal(signal);
      }
    });
    harness.enqueueTask("task-lease-race");
    expect(
      harness.gardenTaskRepo.claimAtomic("task-lease-race", "garden-worker", "2026-05-07T00:00:00.000Z")
    ).toBe("claimed");

    await expect(
      harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", {
        task_id: "task-lease-race",
        status: "completed",
        result_envelope: {
          candidate_signals: [
            {
              signal_kind: "potential_preference",
              object_kind: "memory_entry",
              scope_hint: "project",
              domain_tags: ["garden"],
              confidence: 0.9,
              evidence_refs: ["memory-1"],
              raw_payload: { observation: "host worker extracted a preference" }
            }
          ]
        }
      })
    ).resolves.toMatchObject({ task_id: "task-lease-race", status: "completed" });

    expect(gcAttempted).toBe(true);
    expect(harness.getGardenTask("task-lease-race")).toMatchObject({ status: "completed" });
    const signalRows = (
      harness.database.connection
        .prepare("SELECT COUNT(*) AS n FROM signals")
        .get() as { readonly n: number }
    ).n;
    expect(signalRows).toBe(1);
  });

  it("retries a partial complete_task after signal persistence without duplicating the signal", async () => {
    let failOnce = true;
    const harness = await createGardenMcpHarness({
      receiveSignal: async (signal, context) => {
        const received = await context.signalService.receiveSignal(signal);
        if (failOnce) {
          failOnce = false;
          throw new Error("simulated failure after signal persistence");
        }
        return received;
      }
    });
    harness.enqueueTask("task-partial-retry");
    await harness.callTool<GardenClaimTaskResponse>("garden.claim_task", {
      task_id: "task-partial-retry"
    });

    let firstFailure: unknown;
    try {
      await harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", {
        task_id: "task-partial-retry",
        status: "completed",
        result_envelope: {
          candidate_signals: [
            {
              signal_kind: "potential_preference",
              object_kind: "memory_entry",
              scope_hint: "project",
              domain_tags: ["garden"],
              confidence: 0.9,
              evidence_refs: ["memory-1"],
              raw_payload: { observation: "retry should reuse the deterministic Garden signal id" }
            }
          ]
        }
      });
    } catch (error) {
      firstFailure = error;
    }

    expect(firstFailure).toBeDefined();
    expect(harness.getGardenTask("task-partial-retry")).toMatchObject({
      status: "pending",
      claimed_by: null
    });
    let signalRows = (
      harness.database.connection
        .prepare("SELECT COUNT(*) AS n FROM signals")
        .get() as { readonly n: number }
    ).n;
    expect(signalRows).toBe(1);

    await harness.callTool<GardenClaimTaskResponse>("garden.claim_task", {
      task_id: "task-partial-retry"
    });
    await expect(
      harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", {
        task_id: "task-partial-retry",
        status: "completed",
        result_envelope: {
          candidate_signals: [
            {
              signal_kind: "potential_preference",
              object_kind: "memory_entry",
              scope_hint: "project",
              domain_tags: ["garden"],
              confidence: 0.9,
              evidence_refs: ["memory-1"],
              raw_payload: { observation: "retry should reuse the deterministic Garden signal id" }
            }
          ]
        }
      })
    ).resolves.toMatchObject({
      task_id: "task-partial-retry",
      status: "completed",
      events_appended: 1
    });

    signalRows = (
      harness.database.connection
        .prepare("SELECT COUNT(*) AS n FROM signals")
        .get() as { readonly n: number }
    ).n;
    expect(signalRows).toBe(1);
    const completedEvents = await harness.eventLogRepo.queryByType(
      GardenEventType.SOUL_GARDEN_TASK_COMPLETED
    );
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0]?.payload_json).toMatchObject({
      task_id: "task-partial-retry",
      candidate_signals_count: 1
    });
  });

  it("releases completion claim after completeWithEvents fails so the same signal can retry", async () => {
    let failCompleteOnce = true;
    const harness = await createGardenMcpHarness({
      completeWithEvents: async (taskId, result, events, claimedBy, original) => {
        if (failCompleteOnce) {
          failCompleteOnce = false;
          throw new Error("simulated completion persistence failure");
        }
        await original(taskId, result, events, claimedBy);
      }
    });
    harness.enqueueTask("task-complete-failure-retry");
    await harness.callTool<GardenClaimTaskResponse>("garden.claim_task", {
      task_id: "task-complete-failure-retry"
    });

    const completeArgs = {
      task_id: "task-complete-failure-retry",
      status: "completed",
      result_envelope: {
        candidate_signals: [
          {
            signal_kind: "potential_preference",
            object_kind: "memory_entry",
            scope_hint: "project",
            domain_tags: ["garden"],
            confidence: 0.9,
            evidence_refs: ["memory-1"],
            raw_payload: { observation: "retry after completeWithEvents failure" }
          }
        ]
      }
    } as const;

    await expect(
      harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", completeArgs)
    ).rejects.toThrow("Tool call failed for garden.complete_task");
    expect(harness.getGardenTask("task-complete-failure-retry")).toMatchObject({
      status: "pending",
      claimed_by: null
    });

    await harness.callTool<GardenClaimTaskResponse>("garden.claim_task", {
      task_id: "task-complete-failure-retry"
    });
    await expect(
      harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", completeArgs)
    ).resolves.toMatchObject({
      task_id: "task-complete-failure-retry",
      status: "completed"
    });
    const signalRows = (
      harness.database.connection
        .prepare("SELECT COUNT(*) AS n FROM signals")
        .get() as { readonly n: number }
    ).n;
    expect(signalRows).toBe(1);
  });

  it("rejects a shortened completion retry after a partial completion failure", async () => {
    let failCompleteOnce = true;
    const harness = await createGardenMcpHarness({
      completeWithEvents: async (taskId, result, events, claimedBy, original) => {
        if (failCompleteOnce) {
          failCompleteOnce = false;
          throw new Error("simulated completion persistence failure");
        }
        await original(taskId, result, events, claimedBy);
      }
    });
    harness.enqueueTask("task-shortened-envelope-retry");
    await harness.callTool<GardenClaimTaskResponse>("garden.claim_task", {
      task_id: "task-shortened-envelope-retry"
    });

    const twoSignalCompletion = {
      task_id: "task-shortened-envelope-retry",
      status: "completed",
      result_envelope: {
        candidate_signals: [
          {
            signal_kind: "potential_preference",
            object_kind: "memory_entry",
            scope_hint: "project",
            domain_tags: ["garden"],
            confidence: 0.9,
            evidence_refs: ["memory-1"],
            raw_payload: { observation: "first signal from original envelope" }
          },
          {
            signal_kind: "potential_claim",
            object_kind: "memory_entry",
            scope_hint: "project",
            domain_tags: ["garden"],
            confidence: 0.8,
            evidence_refs: ["memory-2"],
            raw_payload: { observation: "second signal from original envelope" }
          }
        ]
      }
    } as const;

    await expect(
      harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", twoSignalCompletion)
    ).rejects.toThrow("Tool call failed for garden.complete_task");
    expect(harness.getGardenTask("task-shortened-envelope-retry")).toMatchObject({
      status: "pending",
      claimed_by: null
    });
    expect(harness.gardenTaskRepo.findById("task-shortened-envelope-retry")?.completion_envelope_json)
      .toEqual(expect.stringContaining("\"candidate_signal_count\":2"));

    await harness.callTool<GardenClaimTaskResponse>("garden.claim_task", {
      task_id: "task-shortened-envelope-retry"
    });
    await expect(
      harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", {
        task_id: "task-shortened-envelope-retry",
        status: "completed",
        result_envelope: {
          candidate_signals: [twoSignalCompletion.result_envelope.candidate_signals[0]]
        }
      })
    ).rejects.toThrow("candidate_signals changed after a previous partial completion attempt");
    expect(harness.getGardenTask("task-shortened-envelope-retry")).toMatchObject({
      status: "claimed",
      claimed_by: "garden-worker"
    });

    await expect(
      harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", twoSignalCompletion)
    ).resolves.toMatchObject({
      task_id: "task-shortened-envelope-retry",
      status: "completed"
    });
    const completedEvents = await harness.eventLogRepo.queryByType(
      GardenEventType.SOUL_GARDEN_TASK_COMPLETED
    );
    expect(completedEvents[0]?.payload_json).toMatchObject({
      task_id: "task-shortened-envelope-retry",
      candidate_signals_count: 2
    });
  });

  it("rejects an omitted completion envelope retry after a partial completion failure", async () => {
    let failCompleteOnce = true;
    const harness = await createGardenMcpHarness({
      completeWithEvents: async (taskId, result, events, claimedBy, original) => {
        if (failCompleteOnce) {
          failCompleteOnce = false;
          throw new Error("simulated completion persistence failure");
        }
        await original(taskId, result, events, claimedBy);
      }
    });
    harness.enqueueTask("task-omitted-envelope-retry");
    await harness.callTool<GardenClaimTaskResponse>("garden.claim_task", {
      task_id: "task-omitted-envelope-retry"
    });

    const oneSignalCompletion = {
      task_id: "task-omitted-envelope-retry",
      status: "completed",
      result_envelope: {
        candidate_signals: [
          {
            signal_kind: "potential_preference",
            object_kind: "memory_entry",
            scope_hint: "project",
            domain_tags: ["garden"],
            confidence: 0.9,
            evidence_refs: ["memory-1"],
            raw_payload: { observation: "original envelope signal" }
          }
        ]
      }
    } as const;

    await expect(
      harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", oneSignalCompletion)
    ).rejects.toThrow("Tool call failed for garden.complete_task");

    await harness.callTool<GardenClaimTaskResponse>("garden.claim_task", {
      task_id: "task-omitted-envelope-retry"
    });
    await expect(
      harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", {
        task_id: "task-omitted-envelope-retry",
        status: "completed"
      })
    ).rejects.toThrow("candidate_signals changed after a previous partial completion attempt");

    await expect(
      harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", oneSignalCompletion)
    ).resolves.toMatchObject({
      task_id: "task-omitted-envelope-retry",
      status: "completed"
    });
  });

  it("rejects an empty completion envelope retry after a partial completion failure", async () => {
    let failCompleteOnce = true;
    const harness = await createGardenMcpHarness({
      completeWithEvents: async (taskId, result, events, claimedBy, original) => {
        if (failCompleteOnce) {
          failCompleteOnce = false;
          throw new Error("simulated completion persistence failure");
        }
        await original(taskId, result, events, claimedBy);
      }
    });
    harness.enqueueTask("task-empty-envelope-retry");
    await harness.callTool<GardenClaimTaskResponse>("garden.claim_task", {
      task_id: "task-empty-envelope-retry"
    });

    const oneSignalCompletion = {
      task_id: "task-empty-envelope-retry",
      status: "completed",
      result_envelope: {
        candidate_signals: [
          {
            signal_kind: "potential_preference",
            object_kind: "memory_entry",
            scope_hint: "project",
            domain_tags: ["garden"],
            confidence: 0.9,
            evidence_refs: ["memory-1"],
            raw_payload: { observation: "original envelope signal" }
          }
        ]
      }
    } as const;

    await expect(
      harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", oneSignalCompletion)
    ).rejects.toThrow("Tool call failed for garden.complete_task");

    await harness.callTool<GardenClaimTaskResponse>("garden.claim_task", {
      task_id: "task-empty-envelope-retry"
    });
    await expect(
      harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", {
        task_id: "task-empty-envelope-retry",
        status: "completed",
        result_envelope: {
          candidate_signals: []
        }
      })
    ).rejects.toThrow("candidate_signals changed after a previous partial completion attempt");

    await expect(
      harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", oneSignalCompletion)
    ).resolves.toMatchObject({
      task_id: "task-empty-envelope-retry",
      status: "completed"
    });
  });

  it("rejects an extended completion retry after a partial completion failure", async () => {
    let failCompleteOnce = true;
    const harness = await createGardenMcpHarness({
      completeWithEvents: async (taskId, result, events, claimedBy, original) => {
        if (failCompleteOnce) {
          failCompleteOnce = false;
          throw new Error("simulated completion persistence failure");
        }
        await original(taskId, result, events, claimedBy);
      }
    });
    harness.enqueueTask("task-extended-envelope-retry");
    await harness.callTool<GardenClaimTaskResponse>("garden.claim_task", {
      task_id: "task-extended-envelope-retry"
    });

    const firstSignal = {
      signal_kind: "potential_preference",
      object_kind: "memory_entry",
      scope_hint: "project",
      domain_tags: ["garden"],
      confidence: 0.9,
      evidence_refs: ["memory-1"],
      raw_payload: { observation: "only original signal" }
    } as const;
    const oneSignalCompletion = {
      task_id: "task-extended-envelope-retry",
      status: "completed",
      result_envelope: {
        candidate_signals: [firstSignal]
      }
    } as const;

    await expect(
      harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", oneSignalCompletion)
    ).rejects.toThrow("Tool call failed for garden.complete_task");

    await harness.callTool<GardenClaimTaskResponse>("garden.claim_task", {
      task_id: "task-extended-envelope-retry"
    });
    await expect(
      harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", {
        task_id: "task-extended-envelope-retry",
        status: "completed",
        result_envelope: {
          candidate_signals: [
            firstSignal,
            {
              signal_kind: "potential_claim",
              object_kind: "memory_entry",
              scope_hint: "project",
              domain_tags: ["garden"],
              confidence: 0.8,
              evidence_refs: ["memory-2"],
              raw_payload: { observation: "extra retry signal" }
            }
          ]
        }
      })
    ).rejects.toThrow("candidate_signals changed after a previous partial completion attempt");

    await expect(
      harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", oneSignalCompletion)
    ).resolves.toMatchObject({
      task_id: "task-extended-envelope-retry",
      status: "completed"
    });
  });

  it("rejects a Garden completion retry with changed candidate content for the same signal id", async () => {
    let failOnce = true;
    const harness = await createGardenMcpHarness({
      receiveSignal: async (signal, context) => {
        const received = await context.signalService.receiveSignal(signal);
        if (failOnce) {
          failOnce = false;
          throw new Error("simulated failure after first signal");
        }
        return received;
      }
    });
    harness.enqueueTask("task-mismatched-retry");
    await harness.callTool<GardenClaimTaskResponse>("garden.claim_task", {
      task_id: "task-mismatched-retry"
    });

    await expect(
      harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", {
        task_id: "task-mismatched-retry",
        status: "completed",
        result_envelope: {
          candidate_signals: [
            {
              signal_kind: "potential_preference",
              object_kind: "memory_entry",
              scope_hint: "project",
              domain_tags: ["garden"],
              confidence: 0.9,
              evidence_refs: ["memory-1"],
              raw_payload: { observation: "first durable signal" }
            }
          ]
        }
      })
    ).rejects.toThrow("Tool call failed for garden.complete_task");

    await harness.callTool<GardenClaimTaskResponse>("garden.claim_task", {
      task_id: "task-mismatched-retry"
    });
    await expect(
      harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", {
        task_id: "task-mismatched-retry",
        status: "completed",
        result_envelope: {
          candidate_signals: [
            {
              signal_kind: "potential_claim",
              object_kind: "memory_entry",
              scope_hint: "project",
              domain_tags: ["garden", "changed"],
              confidence: 0.9,
              evidence_refs: ["memory-1"],
              raw_payload: { observation: "changed durable signal" }
            }
          ]
        }
      })
    ).rejects.toThrow("Tool call failed for garden.complete_task");

    expect(harness.getGardenTask("task-mismatched-retry")).toMatchObject({
      status: "claimed",
      claimed_by: "garden-worker"
    });
    const signalRows = (
      harness.database.connection
        .prepare("SELECT COUNT(*) AS n FROM signals")
        .get() as { readonly n: number }
    ).n;
    expect(signalRows).toBe(1);
  });

  it("rejects duplicate same-claimant complete_task before a second signal can persist", async () => {
    let resolveFirstSignalStarted!: () => void;
    const firstSignalStarted = new Promise<void>((resolve) => {
      resolveFirstSignalStarted = resolve;
    });
    let unblockFirstSignal!: () => void;
    const firstSignalGate = new Promise<void>((resolve) => {
      unblockFirstSignal = resolve;
    });
    let receiveCount = 0;
    const harness = await createGardenMcpHarness({
      receiveSignal: async (signal, context) => {
        receiveCount += 1;
        if (receiveCount === 1) {
          resolveFirstSignalStarted();
          await firstSignalGate;
        }
        return await context.signalService.receiveSignal(signal);
      }
    });
    harness.enqueueTask("task-same-claimant-race");
    await harness.callTool<GardenClaimTaskResponse>("garden.claim_task", {
      task_id: "task-same-claimant-race"
    });

    const firstCompletion = harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", {
      task_id: "task-same-claimant-race",
      status: "completed",
      result_envelope: {
        candidate_signals: [
          {
            signal_kind: "potential_preference",
            object_kind: "memory_entry",
            scope_hint: "project",
            domain_tags: ["garden"],
            confidence: 0.9,
            evidence_refs: ["memory-1"],
            raw_payload: { observation: "first completion result" }
          }
        ]
      }
    });
    await firstSignalStarted;

    let duplicate: unknown;
    try {
      await harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", {
        task_id: "task-same-claimant-race",
        status: "completed",
        result_envelope: {
          candidate_signals: [
            {
              signal_kind: "potential_preference",
              object_kind: "memory_entry",
              scope_hint: "project",
              domain_tags: ["garden"],
              confidence: 0.9,
              evidence_refs: ["memory-1"],
              raw_payload: { observation: "duplicate completion result" }
            }
          ]
        }
      });
    } catch (error) {
      duplicate = error;
    }

    expect(duplicate).toBeDefined();
    let signalRows = (
      harness.database.connection
        .prepare("SELECT COUNT(*) AS n FROM signals")
        .get() as { readonly n: number }
    ).n;
    expect(signalRows).toBe(0);

    unblockFirstSignal();
    await expect(firstCompletion).resolves.toMatchObject({
      task_id: "task-same-claimant-race",
      status: "completed"
    });
    expect(receiveCount).toBe(1);
    signalRows = (
      harness.database.connection
        .prepare("SELECT COUNT(*) AS n FROM signals")
        .get() as { readonly n: number }
    ).n;
    expect(signalRows).toBe(1);
  });
});

interface GardenListPendingTasksResponse {
  readonly tasks: readonly {
    readonly task_id: string;
    readonly role: string;
    readonly kind: string;
    readonly created_at: string;
    readonly payload: unknown;
  }[];
}

interface GardenClaimTaskResponse {
  readonly status: "claimed" | "already_claimed";
  readonly task_id: string;
  readonly role: string;
  readonly kind: string;
  readonly payload: unknown;
}

interface GardenCompleteTaskResponse {
  readonly task_id: string;
  readonly status: "completed" | "failed";
  readonly events_appended: number;
}

interface GardenTaskDbRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly status: string;
  readonly claimed_by: string | null;
  readonly claimed_at: string | null;
  readonly completed_at: string | null;
  readonly last_error_text: string | null;
}

interface GardenMcpReceiveSignalContext {
  readonly gardenTaskRepo: SqliteGardenTaskRepo;
  readonly signalService: SignalService;
}

interface GardenMcpHarnessOptions {
  readonly now?: () => string;
  readonly receiveSignal?: (
    signal: CandidateMemorySignal,
    context: GardenMcpReceiveSignalContext
  ) => Promise<Readonly<{ readonly signal: Readonly<CandidateMemorySignal> }>>;
  readonly completeWithEvents?: (
    taskId: string,
    result: Parameters<SqliteGardenTaskRepo["completeWithEvents"]>[1],
    events: Parameters<SqliteGardenTaskRepo["completeWithEvents"]>[2],
    claimedBy: string,
    original: SqliteGardenTaskRepo["completeWithEvents"]
  ) => Promise<void>;
}

interface GardenMcpHarness {
  readonly database: StorageDatabase;
  readonly eventLogRepo: SqliteEventLogRepo;
  readonly gardenTaskRepo: SqliteGardenTaskRepo;
  readonly signalRepo: SqliteSignalRepo;
  callTool<TOutput>(toolName: string, args: Record<string, unknown>): Promise<TOutput>;
  close(): Promise<void>;
  enqueueTask(
    taskId: string,
    overrides?: Partial<{
      readonly workspace_id: string;
      readonly role: GardenRoleValue;
      readonly kind: GardenTaskKindValue;
      readonly payload: GardenTaskDescriptor;
      readonly created_at: string;
    }>
  ): void;
  getGardenTask(taskId: string): GardenTaskDbRow;
  setContext(overrides: Partial<McpMemoryToolCallContext>): void;
}

async function createGardenMcpHarness(options: GardenMcpHarnessOptions = {}): Promise<GardenMcpHarness> {
  const database = initDatabase({ filename: ":memory:" });
  const eventLogRepo = new SqliteEventLogRepo(database);
  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
  const signalRepo = new SqliteSignalRepo(database);
  const runtimeNotifier = {
    notify: () => {},
    notifyEntry: () => {}
  };
  const eventPublisher = new EventPublisher({
    eventLogRepo,
    runHotStateService: { apply: () => {} },
    runtimeNotifier
  });
  const gardenTaskRepo = new SqliteGardenTaskRepo(database.connection, eventPublisher);
  const signalService = new SignalService({
    eventLogRepo,
    signalRepo,
    runtimeNotifier
  });
  const originalCompleteWithEvents = gardenTaskRepo.completeWithEvents.bind(gardenTaskRepo);
  const handlerGardenTaskRepo: NonNullable<McpMemoryToolHandlerDependencies["gardenTaskRepo"]> = {
    enqueue: gardenTaskRepo.enqueue.bind(gardenTaskRepo),
    findById: gardenTaskRepo.findById.bind(gardenTaskRepo),
    peekPending: gardenTaskRepo.peekPending.bind(gardenTaskRepo),
    claimAtomic: gardenTaskRepo.claimAtomic.bind(gardenTaskRepo),
    completeWithEvents: async (taskId, result, events, claimedBy) => {
      if (options.completeWithEvents !== undefined) {
        await options.completeWithEvents(
          taskId,
          result,
          events,
          claimedBy,
          originalCompleteWithEvents
        );
        return;
      }
      await originalCompleteWithEvents(taskId, result, events, claimedBy);
    },
    beginCompletionAttempt: gardenTaskRepo.beginCompletionAttempt.bind(gardenTaskRepo),
    refreshClaim: gardenTaskRepo.refreshClaim.bind(gardenTaskRepo),
    releaseClaim: gardenTaskRepo.releaseClaim.bind(gardenTaskRepo)
  };
  const receiveSignal: NonNullable<GardenMcpHarnessOptions["receiveSignal"]> =
    options.receiveSignal ?? (async (signal) => await signalService.receiveSignal(signal));
  const context: McpMemoryToolCallContext = {
    workspaceId: "workspace-a",
    runId: "run-a",
    agentTarget: "garden-worker",
    sessionId: "garden-mcp-tools-test-session",
    surfaceId: "garden-mcp-tools-test"
  };
  await seedWorkspaceRun(workspaceRepo, runRepo, "workspace-a", "run-a");
  await seedWorkspaceRun(workspaceRepo, runRepo, "workspace-b", "run-b");
  let client: Client | null = null;
  let server: Server | null = null;

  const deps: McpMemoryToolHandlerDependencies = {
    now: options.now ?? (() => "2026-05-07T00:10:00.000Z"),
    generateId: () => "00000000-0000-4000-8000-000000000001",
    recallService: {
      recall: async () => ({
        candidates: [],
        active_constraints: [],
        active_constraints_count: 0,
        total_scanned: 0,
        coarse_filter_count: 0,
        fine_assessment_count: 0
      })
    },
    memoryService: {
      findById: async () => null,
      findByIdScoped: async () => null,
      update: async () => createMemoryEntry()
    },
    signalService: {
      receiveSignal: async (signal) =>
        await receiveSignal(signal, {
          gardenTaskRepo,
          signalService
        })
    },
    graphExploreService: {
      exploreOneHop: async () => []
    },
    sessionOverrideService: {
      apply: async () => ({ runtime_id: "override-garden-test" })
    },
    trustStateRecorder: {
      recordDelivery: async (input) => ({ ...input, audit_event_id: "event-delivery" }),
      recordUsage: async (input) => ({ ...input, audit_event_id: "event-usage" }),
      findDeliveryById: async () => null
    },
    eventPublisher,
    gardenTaskRepo: handlerGardenTaskRepo
  };
  const handler = createMcpMemoryToolHandler(deps);
  server = createAlayaMcpServer({
    memoryToolHandler: handler,
    contextProvider: () => context
  });
  client = new Client(
    { name: "garden-mcp-tools-test", version: "test" },
    { capabilities: {} }
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const harness: GardenMcpHarness = {
    database,
    eventLogRepo,
    gardenTaskRepo,
    signalRepo,
    async callTool<TOutput>(toolName: string, args: Record<string, unknown>): Promise<TOutput> {
      if (client === null) {
        throw new Error("MCP client is closed.");
      }
      const result = await client.callTool({ name: toolName, arguments: args });
      if (result.isError === true) {
        const errorText = result.content
          ?.map((item) => ("text" in item && typeof item.text === "string" ? item.text : ""))
          .join("\n");
        throw new Error(`Tool call failed for ${toolName}: ${errorText}`);
      }
      const structuredContent = result.structuredContent as
        | Readonly<{ ok: true; output: TOutput }>
        | undefined;
      expect(structuredContent).toMatchObject({ ok: true });
      return structuredContent!.output;
    },
    async close() {
      await client?.close();
      await server?.close();
      database.close();
      client = null;
      server = null;
    },
    enqueueTask(taskId, overrides = {}) {
      const workspaceId = overrides.workspace_id ?? "workspace-a";
      const role = overrides.role ?? GardenRole.JANITOR;
      const kind = overrides.kind ?? GardenTaskKind.TTL_CLEANUP;
      gardenTaskRepo.enqueue({
        id: taskId,
        workspace_id: workspaceId,
        role,
        kind,
        payload:
          overrides.payload ??
          createTaskDescriptor({
            task_id: taskId,
            task_kind: kind,
            workspace_id: workspaceId
          }),
        created_at: overrides.created_at ?? "2026-05-07T00:00:00.000Z"
      });
    },
    getGardenTask(taskId) {
      const row = database.connection
        .prepare(
          `SELECT id, workspace_id, status, claimed_by, claimed_at, completed_at, last_error_text
           FROM garden_tasks
           WHERE id = ?`
        )
        .get(taskId) as GardenTaskDbRow | undefined;
      if (row === undefined) {
        throw new Error(`Missing Garden task ${taskId}`);
      }
      return row;
    },
    setContext(overrides) {
      Object.assign(context, overrides);
    }
  };

  harnesses.add(harness);
  return harness;
}

async function seedWorkspaceRun(
  workspaceRepo: SqliteWorkspaceRepo,
  runRepo: SqliteRunRepo,
  workspaceId: string,
  runId: string
): Promise<void> {
  await workspaceRepo.create({
    workspace_id: workspaceId,
    name: workspaceId,
    root_path: `/tmp/${workspaceId}`,
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  await runRepo.create({
    run_id: runId,
    workspace_id: workspaceId,
    title: runId,
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
}

function createTaskDescriptor(overrides: Partial<GardenTaskDescriptor> = {}): GardenTaskDescriptor {
  return {
    task_id: "task-1",
    task_kind: GardenTaskKind.TTL_CLEANUP,
    required_tier: GardenTier.TIER_0,
    workspace_id: "workspace-a",
    run_id: "run-a",
    target_object_refs: ["memory-1"],
    priority: 10,
    created_at: "2026-05-07T00:00:00.000Z",
    ...overrides
  };
}

function createMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: "memory-1",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-05-07T00:00:00.000Z",
    updated_at: "2026-05-07T00:00:00.000Z",
    created_by: "garden-test",
    dimension: "preference",
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: "project",
    content: "Garden test memory.",
    domain_tags: [],
    evidence_refs: [],
    workspace_id: "workspace-a",
    run_id: "run-a",
    surface_id: null,
    storage_tier: "hot",
    activation_score: 0.5,
    retention_score: 0.5,
    manifestation_state: "excerpt",
    retention_state: "working",
    decay_profile: "stable",
    confidence: 1,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: 0,
    contradiction_count: 0,
    superseded_by: null,
    ...overrides
  };
}
