import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GardenEventType,
  GardenRole,
  GardenTaskKind,
  GardenTier,
  parseGardenEventPayload
} from "@do-soul/alaya-protocol";

import {
  cleanupGardenMcpHarnesses,
  createEdgeClassifyPayload,
  createGardenMcpHarness,
  createTaskDescriptor,
  type GardenClaimTaskResponse,
  type GardenCompleteTaskResponse,
  type GardenListPendingTasksResponse,
  type GardenMcpHarness
} from "./garden-mcp-tools-fixture.js";

afterEach(cleanupGardenMcpHarnesses);

describe("Garden MCP tools", () => {

  it("list returns pending only", async () => {
    const harness = await createGardenMcpHarness();
    harness.enqueueTask("task-pending");
    harness.enqueueTask("task-claimed");
    await harness.gardenTaskRepo.claimAtomic(
      "task-claimed",
      "worker-a",
      "2026-05-07T00:00:01.000Z"
    );
    harness.enqueueTask("task-completed");
    await harness.gardenTaskRepo.claimAtomic(
      "task-completed",
      "worker-a",
      "2026-05-07T00:00:02.000Z"
    );
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
      payload: {}
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
      payload: {}
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

  it("rejects unsupported extracted_proposals without completing the claimed task", async () => {
    const harness = await createGardenMcpHarness();
    harness.enqueueTask("task-extracted-proposals");
    await harness.callTool<GardenClaimTaskResponse>(
      "garden.claim_task",
      { task_id: "task-extracted-proposals" }
    );

    await expect(
      harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", {
        task_id: "task-extracted-proposals",
        status: "completed",
        result_envelope: {
          extracted_proposals: [
            {
              proposal_id: "proposal-unsupported",
              target_object_kind: "memory_entry"
            }
          ]
        }
      })
    ).rejects.toThrow("extracted_proposals");

    expect(harness.getGardenTask("task-extracted-proposals")).toMatchObject({
      status: "claimed",
      claimed_by: "garden-worker",
      completed_at: null
    });
    await expect(
      harness.eventLogRepo.queryByType(GardenEventType.SOUL_GARDEN_TASK_COMPLETED)
    ).resolves.toHaveLength(0);
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
    await expect(
      harness.gardenTaskRepo.claimAtomic(
        "task-reclaimed",
        "garden-worker",
        "2026-05-07T00:00:00.000Z"
      )
    ).resolves.toBe("claimed");
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
});
