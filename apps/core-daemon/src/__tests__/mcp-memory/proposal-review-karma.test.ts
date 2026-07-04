import { describe, expect, it, vi } from "vitest";
import { emitProposalReviewKarma } from "../../mcp-memory/proposal-review-karma.js";
import type { McpMemoryProposalWorkflowDependencies } from "../../mcp-memory/proposal-workflow.js";

describe("emitProposalReviewKarma", () => {
  it("fires accept_gain once for a memory_entry proposal accept", async () => {
    const emitKarmaEvent = vi.fn(async () => {});
    const deps = {
      dynamicsService: { emitKarmaEvent }
    } as unknown as McpMemoryProposalWorkflowDependencies;

    await emitProposalReviewKarma(
      deps,
      {
        proposal: { derived_from: "memory-target" },
        workspace_id: "workspace-1",
        run_id: "run-1",
        target_object_kind: "memory_entry",
        target_object_id: "memory-target"
      } as NonNullable<
        Awaited<ReturnType<McpMemoryProposalWorkflowDependencies["proposalRepo"]["findScopedById"]>>
      >,
      "accept",
      {
        workspaceId: "workspace-1",
        runId: "run-1",
        agentTarget: "codex",
        surfaceId: null
      }
    );

    expect(emitKarmaEvent).toHaveBeenCalledTimes(1);
    expect(emitKarmaEvent).toHaveBeenCalledWith({
      kind: "accept_gain",
      objectId: "memory-target",
      workspaceId: "workspace-1",
      runId: "run-1"
    });
  });

  it("fires reject_penalty once for a memory_entry proposal reject", async () => {
    const emitKarmaEvent = vi.fn(async () => {});
    const deps = {
      dynamicsService: { emitKarmaEvent }
    } as unknown as McpMemoryProposalWorkflowDependencies;

    await emitProposalReviewKarma(
      deps,
      {
        proposal: { derived_from: "memory-target" },
        workspace_id: "workspace-1",
        run_id: null,
        target_object_kind: "memory_entry",
        target_object_id: "memory-target"
      } as NonNullable<
        Awaited<ReturnType<McpMemoryProposalWorkflowDependencies["proposalRepo"]["findScopedById"]>>
      >,
      "reject",
      {
        workspaceId: "workspace-1",
        runId: null,
        agentTarget: "codex",
        surfaceId: null
      }
    );

    expect(emitKarmaEvent).toHaveBeenCalledTimes(1);
    expect(emitKarmaEvent).toHaveBeenCalledWith({
      kind: "reject_penalty",
      objectId: "memory-target",
      workspaceId: "workspace-1",
      runId: null
    });
  });

  it("skips karma for non-memory_entry proposals", async () => {
    const emitKarmaEvent = vi.fn(async () => {});
    const deps = {
      dynamicsService: { emitKarmaEvent }
    } as unknown as McpMemoryProposalWorkflowDependencies;

    await emitProposalReviewKarma(
      deps,
      {
        proposal: { derived_from: "path-1" },
        workspace_id: "workspace-1",
        run_id: "run-1",
        target_object_kind: "path_relation",
        target_object_id: "path-1"
      } as NonNullable<
        Awaited<ReturnType<McpMemoryProposalWorkflowDependencies["proposalRepo"]["findScopedById"]>>
      >,
      "accept",
      {
        workspaceId: "workspace-1",
        runId: "run-1",
        agentTarget: "codex",
        surfaceId: null
      }
    );

    expect(emitKarmaEvent).not.toHaveBeenCalled();
  });
});
