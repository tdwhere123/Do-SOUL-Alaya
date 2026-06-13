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

  // R0-B host-worker EDGE_CLASSIFY lifecycle + envelope discrimination.
  describe("EDGE_CLASSIFY host-worker task", () => {
    function enqueueEdgeClassify(
      harness: GardenMcpHarness,
      taskId: string,
      overrides: Parameters<typeof createEdgeClassifyPayload>[0] = { taskId }
    ): void {
      harness.gardenTaskRepo.enqueue({
        id: taskId,
        workspace_id: "workspace-a",
        role: GardenRole.LIBRARIAN,
        kind: GardenTaskKind.EDGE_CLASSIFY,
        payload: createEdgeClassifyPayload({ ...overrides, taskId }),
        created_at: "2026-05-07T00:00:00.000Z"
      });
    }

    it("surfaces as host_worker and exposes only the pair content to the worker", async () => {
      const harness = await createGardenMcpHarness({ applyVerdict: vi.fn(async () => "applied") });
      enqueueEdgeClassify(harness, "edge-classify-list");

      const listed = await harness.callTool<GardenListPendingTasksResponse>(
        "garden.list_pending_tasks",
        { limit: 10 }
      );
      const task = listed.tasks.find((candidate) => candidate.task_id === "edge-classify-list");
      expect(task?.role).toBe("host_worker");
      expect(task?.kind).toBe(GardenTaskKind.EDGE_CLASSIFY);
      // The public payload carries the pair content but NOT the provenance
      // signal id (the daemon re-binds that at apply time).
      expect(task?.payload).toMatchObject({
        dimension: "fact",
        scope_class: "project",
        source_memory: expect.objectContaining({ object_id: "memory-source" }),
        neighbor_memory: expect.objectContaining({ object_id: "memory-neighbor" })
      });
      expect(task?.payload).not.toHaveProperty("source_signal_id");
    });

    it("enqueue -> claim -> complete(edge_verdict) applies the verdict via the applier", async () => {
      const applyVerdict = vi.fn(async () => "applied");
      const harness = await createGardenMcpHarness({ applyVerdict });
      enqueueEdgeClassify(harness, "edge-classify-apply");

      await harness.callTool<GardenClaimTaskResponse>("garden.claim_task", {
        task_id: "edge-classify-apply"
      });
      const response = await harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", {
        task_id: "edge-classify-apply",
        status: "completed",
        result_envelope: {
          edge_verdict: {
            source_object_id: "memory-source",
            neighbor_object_id: "memory-neighbor",
            edge_type: "supports",
            confidence: 0.92,
            rationale: "both rows assert the same rule"
          }
        }
      });

      expect(response).toMatchObject({ task_id: "edge-classify-apply", status: "completed" });
      expect(applyVerdict).toHaveBeenCalledTimes(1);
      expect(applyVerdict).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: "workspace-a",
          // source_signal_id is re-bound from the task payload provenance.
          sourceSignalId: "signal-1",
          verdict: expect.objectContaining({ edge_type: "supports", source_object_id: "memory-source" })
        })
      );
      expect(harness.getGardenTask("edge-classify-apply")).toMatchObject({ status: "completed" });
      const completed = await harness.eventLogRepo.queryByType(GardenEventType.SOUL_GARDEN_TASK_COMPLETED);
      expect(completed[0]?.payload_json).toMatchObject({
        task_id: "edge-classify-apply",
        task_kind: GardenTaskKind.EDGE_CLASSIFY,
        success: true
      });
    });

    it("no-worker fallback: an unclaimed EDGE_CLASSIFY never calls the applier; the heuristic edge stands", async () => {
      const applyVerdict = vi.fn(async () => "applied");
      const harness = await createGardenMcpHarness({ applyVerdict });
      enqueueEdgeClassify(harness, "edge-classify-unclaimed");

      // Nobody claims or completes — the task simply sits pending. The verdict
      // applier is never invoked, so the inline heuristic edge is the only
      // edge (eventual consistency: refinement is best-effort).
      const listed = await harness.callTool<GardenListPendingTasksResponse>(
        "garden.list_pending_tasks",
        { limit: 10 }
      );
      expect(listed.tasks.map((task) => task.task_id)).toContain("edge-classify-unclaimed");
      expect(applyVerdict).not.toHaveBeenCalled();
      expect(harness.getGardenTask("edge-classify-unclaimed").status).toBe("pending");
    });

    it("a none verdict completes the task but applies no refinement", async () => {
      const applyVerdict = vi.fn(async () => null);
      const harness = await createGardenMcpHarness({ applyVerdict });
      enqueueEdgeClassify(harness, "edge-classify-none");
      await harness.callTool<GardenClaimTaskResponse>("garden.claim_task", {
        task_id: "edge-classify-none"
      });

      const response = await harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", {
        task_id: "edge-classify-none",
        status: "completed",
        result_envelope: {
          edge_verdict: {
            source_object_id: "memory-source",
            neighbor_object_id: "memory-neighbor",
            edge_type: "none",
            confidence: 0.99,
            rationale: "no relationship"
          }
        }
      });

      expect(response).toMatchObject({ status: "completed" });
      expect(applyVerdict).toHaveBeenCalledTimes(1);
      expect(harness.getGardenTask("edge-classify-none")).toMatchObject({ status: "completed" });
    });

    it("rejects candidate_signals on an EDGE_CLASSIFY task (envelope discrimination)", async () => {
      const applyVerdict = vi.fn(async () => "applied");
      const harness = await createGardenMcpHarness({ applyVerdict });
      enqueueEdgeClassify(harness, "edge-classify-wrong-shape");
      await harness.callTool<GardenClaimTaskResponse>("garden.claim_task", {
        task_id: "edge-classify-wrong-shape"
      });

      await expect(
        harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", {
          task_id: "edge-classify-wrong-shape",
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
                raw_payload: { observation: "wrong result shape for edge_classify" }
              }
            ]
          }
        })
      ).rejects.toThrow("complete it with result_envelope.edge_verdict");
      expect(applyVerdict).not.toHaveBeenCalled();
      // The task is untouched — still claimed, ready for a correct retry.
      expect(harness.getGardenTask("edge-classify-wrong-shape")).toMatchObject({ status: "claimed" });
    });

    it("rejects a completed EDGE_CLASSIFY task with no edge_verdict (false-success guard)", async () => {
      const applyVerdict = vi.fn(async () => "applied");
      const harness = await createGardenMcpHarness({ applyVerdict });
      enqueueEdgeClassify(harness, "edge-classify-missing-verdict");
      await harness.callTool<GardenClaimTaskResponse>("garden.claim_task", {
        task_id: "edge-classify-missing-verdict"
      });

      await expect(
        harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", {
          task_id: "edge-classify-missing-verdict",
          status: "completed"
        })
      ).rejects.toThrow("completed without a result_envelope.edge_verdict");
      // No verdict applied, no false success recorded — the task stays claimed
      // for a correct retry (verdict, or status="failed").
      expect(applyVerdict).not.toHaveBeenCalled();
      expect(harness.getGardenTask("edge-classify-missing-verdict")).toMatchObject({
        status: "claimed"
      });
      const completed = await harness.eventLogRepo.queryByType(
        GardenEventType.SOUL_GARDEN_TASK_COMPLETED
      );
      expect(
        completed.some(
          (event) =>
            (event.payload_json as { readonly task_id?: string }).task_id ===
            "edge-classify-missing-verdict"
        )
      ).toBe(false);
    });

    it("rejects a completed EDGE_CLASSIFY task with an empty result_envelope (no verdict)", async () => {
      const applyVerdict = vi.fn(async () => "applied");
      const harness = await createGardenMcpHarness({ applyVerdict });
      enqueueEdgeClassify(harness, "edge-classify-empty-envelope");
      await harness.callTool<GardenClaimTaskResponse>("garden.claim_task", {
        task_id: "edge-classify-empty-envelope"
      });

      await expect(
        harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", {
          task_id: "edge-classify-empty-envelope",
          status: "completed",
          result_envelope: {}
        })
      ).rejects.toThrow("completed without a result_envelope.edge_verdict");
      expect(applyVerdict).not.toHaveBeenCalled();
      expect(harness.getGardenTask("edge-classify-empty-envelope")).toMatchObject({
        status: "claimed"
      });
    });

    it("allows a failed EDGE_CLASSIFY task with no verdict (failure path unchanged)", async () => {
      const applyVerdict = vi.fn(async () => "applied");
      const harness = await createGardenMcpHarness({ applyVerdict });
      enqueueEdgeClassify(harness, "edge-classify-failed");
      await harness.callTool<GardenClaimTaskResponse>("garden.claim_task", {
        task_id: "edge-classify-failed"
      });

      const response = await harness.callTool<GardenCompleteTaskResponse>(
        "garden.complete_task",
        {
          task_id: "edge-classify-failed",
          status: "failed",
          last_error_text: "host worker could not produce a verdict"
        }
      );

      expect(response).toMatchObject({ task_id: "edge-classify-failed", status: "failed" });
      // A failure refines nothing; the inline heuristic edge stands.
      expect(applyVerdict).not.toHaveBeenCalled();
      expect(harness.getGardenTask("edge-classify-failed")).toMatchObject({ status: "failed" });
      const completed = await harness.eventLogRepo.queryByType(
        GardenEventType.SOUL_GARDEN_TASK_COMPLETED
      );
      expect(
        completed.find(
          (event) =>
            (event.payload_json as { readonly task_id?: string }).task_id ===
            "edge-classify-failed"
        )?.payload_json
      ).toMatchObject({ success: false });
    });

    it("rejects an edge_verdict on a non-EDGE_CLASSIFY task (envelope discrimination)", async () => {
      const harness = await createGardenMcpHarness();
      harness.enqueueTask("post-turn-wrong-shape", {
        role: GardenRole.LIBRARIAN,
        kind: GardenTaskKind.PATH_PLASTICITY_UPDATE,
        payload: createTaskDescriptor({
          task_id: "post-turn-wrong-shape",
          task_kind: GardenTaskKind.PATH_PLASTICITY_UPDATE,
          required_tier: GardenTier.TIER_2
        })
      });
      await harness.callTool<GardenClaimTaskResponse>("garden.claim_task", {
        task_id: "post-turn-wrong-shape"
      });

      await expect(
        harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", {
          task_id: "post-turn-wrong-shape",
          status: "completed",
          result_envelope: {
            edge_verdict: {
              source_object_id: "memory-source",
              neighbor_object_id: "memory-neighbor",
              edge_type: "supports",
              confidence: 0.92,
              rationale: "wrong result shape for this kind"
            }
          }
        })
      ).rejects.toThrow("does not accept an edge_verdict");
    });

    it("rejects a verdict whose pair does not match the claimed task", async () => {
      const applyVerdict = vi.fn(async () => "applied");
      const harness = await createGardenMcpHarness({ applyVerdict });
      enqueueEdgeClassify(harness, "edge-classify-pair-mismatch");
      await harness.callTool<GardenClaimTaskResponse>("garden.claim_task", {
        task_id: "edge-classify-pair-mismatch"
      });

      await expect(
        harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", {
          task_id: "edge-classify-pair-mismatch",
          status: "completed",
          result_envelope: {
            edge_verdict: {
              source_object_id: "some-other-memory",
              neighbor_object_id: "memory-neighbor",
              edge_type: "supports",
              confidence: 0.92,
              rationale: "redirected to an arbitrary pair"
            }
          }
        })
      ).rejects.toThrow("does not match the claimed task");
      expect(applyVerdict).not.toHaveBeenCalled();
    });

    it("rejects a completed EDGE_CLASSIFY verdict when the stored task payload is malformed", async () => {
      const applyVerdict = vi.fn(async () => "applied");
      const harness = await createGardenMcpHarness({ applyVerdict });
      harness.gardenTaskRepo.enqueue({
        id: "edge-classify-malformed-payload",
        workspace_id: "workspace-a",
        role: GardenRole.LIBRARIAN,
        kind: GardenTaskKind.EDGE_CLASSIFY,
        payload: {
          task_kind: GardenTaskKind.EDGE_CLASSIFY,
          source_memory: { object_id: "memory-source" },
          neighbor_memory: { content: "missing object id" }
        },
        created_at: "2026-05-07T00:00:00.000Z"
      });
      await harness.callTool<GardenClaimTaskResponse>("garden.claim_task", {
        task_id: "edge-classify-malformed-payload"
      });

      await expect(
        harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", {
          task_id: "edge-classify-malformed-payload",
          status: "completed",
          result_envelope: {
            edge_verdict: {
              source_object_id: "memory-source",
              neighbor_object_id: "memory-neighbor",
              edge_type: "supports",
              confidence: 0.92,
              rationale: "must not apply without a valid stored pair binding"
            }
          }
        })
      ).rejects.toThrow("has malformed EDGE_CLASSIFY payload");
      expect(applyVerdict).not.toHaveBeenCalled();
      expect(harness.getGardenTask("edge-classify-malformed-payload")).toMatchObject({
        status: "claimed"
      });
      const completed = await harness.eventLogRepo.queryByType(
        GardenEventType.SOUL_GARDEN_TASK_COMPLETED
      );
      expect(
        completed.some(
          (event) =>
            (event.payload_json as { readonly task_id?: string }).task_id ===
            "edge-classify-malformed-payload"
        )
      ).toBe(false);
    });

    it("only the claimant may complete an EDGE_CLASSIFY task", async () => {
      const applyVerdict = vi.fn(async () => "applied");
      const harness = await createGardenMcpHarness({ applyVerdict });
      enqueueEdgeClassify(harness, "edge-classify-claimant-only");
      await harness.callTool<GardenClaimTaskResponse>("garden.claim_task", {
        task_id: "edge-classify-claimant-only"
      });
      harness.setContext({ agentTarget: "claude-code" });

      await expect(
        harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", {
          task_id: "edge-classify-claimant-only",
          status: "completed",
          result_envelope: {
            edge_verdict: {
              source_object_id: "memory-source",
              neighbor_object_id: "memory-neighbor",
              edge_type: "supports",
              confidence: 0.92,
              rationale: "different agent must not complete"
            }
          }
        })
      ).rejects.toThrow("claimed by a different agent target");
      expect(applyVerdict).not.toHaveBeenCalled();
      expect(harness.getGardenTask("edge-classify-claimant-only")).toMatchObject({ status: "claimed" });
    });
  });
});
