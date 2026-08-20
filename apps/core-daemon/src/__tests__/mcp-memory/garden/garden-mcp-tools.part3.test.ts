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
