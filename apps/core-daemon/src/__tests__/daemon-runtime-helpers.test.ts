import { describe, expect, it, vi } from "vitest";
import { reconcileBootstrapPathsForAllWorkspaces } from "../daemon-runtime-helpers.js";

describe("reconcileBootstrapPathsForAllWorkspaces", () => {
  it("calls reconcileBootstrapPaths for each listed workspace", async () => {
    const reconcileBootstrapPaths = vi.fn(async (workspaceId: string) => ({
      status: "planted" as const,
      workspace_id: workspaceId,
      paths_planted: 1,
      record_id: `record-${workspaceId}`,
      template_ids: ["template-a"] as const
    }));
    const warn = vi.fn();

    await reconcileBootstrapPathsForAllWorkspaces({
      workspaceRepo: {
        list: async () => [{ workspace_id: "ws_alpha" }, { workspace_id: "ws_beta" }]
      },
      workspaceService: { reconcileBootstrapPaths },
      warn
    });

    expect(reconcileBootstrapPaths).toHaveBeenCalledTimes(2);
    expect(reconcileBootstrapPaths).toHaveBeenNthCalledWith(1, "ws_alpha");
    expect(reconcileBootstrapPaths).toHaveBeenNthCalledWith(2, "ws_beta");
    expect(warn).not.toHaveBeenCalled();
  });

  it("reconciles active workspaces only when workspace state is available", async () => {
    const reconcileBootstrapPaths = vi.fn(async (workspaceId: string) => ({
      status: "already_planted" as const,
      workspace_id: workspaceId,
      record_id: `record-${workspaceId}`,
      relation_count: 1
    }));
    const warn = vi.fn();

    await reconcileBootstrapPathsForAllWorkspaces({
      workspaceRepo: {
        list: async () => [
          { workspace_id: "ws_active", workspace_state: "active" },
          { workspace_id: "ws_archived", workspace_state: "archived" }
        ]
      },
      workspaceService: { reconcileBootstrapPaths },
      warn
    });

    expect(reconcileBootstrapPaths).toHaveBeenCalledTimes(1);
    expect(reconcileBootstrapPaths).toHaveBeenCalledWith("ws_active");
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs and continues when one workspace's reconcile throws", async () => {
    const reconcileBootstrapPaths = vi.fn(async (workspaceId: string) => {
      if (workspaceId === "ws_beta") {
        throw new Error("planner_unavailable");
      }
      return {
        status: "already_planted" as const,
        workspace_id: workspaceId,
        record_id: `record-${workspaceId}`,
        relation_count: 1
      };
    });
    const warn = vi.fn();

    await reconcileBootstrapPathsForAllWorkspaces({
      workspaceRepo: {
        list: async () => [
          { workspace_id: "ws_alpha" },
          { workspace_id: "ws_beta" },
          { workspace_id: "ws_gamma" }
        ]
      },
      workspaceService: { reconcileBootstrapPaths },
      warn
    });

    expect(reconcileBootstrapPaths).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "bootstrap reconcile failed",
      expect.objectContaining({
        workspace_id: "ws_beta",
        error: "planner_unavailable"
      })
    );
  });

  it("warns and returns silently when workspace enumeration fails", async () => {
    const reconcileBootstrapPaths = vi.fn();
    const warn = vi.fn();

    await reconcileBootstrapPathsForAllWorkspaces({
      workspaceRepo: {
        list: async () => {
          throw new Error("db_unavailable");
        }
      },
      workspaceService: { reconcileBootstrapPaths },
      warn
    });

    expect(reconcileBootstrapPaths).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "bootstrap reconcile enumeration failed",
      expect.objectContaining({ error: "db_unavailable" })
    );
  });

  it("no-ops cleanly when workspace list is empty", async () => {
    const reconcileBootstrapPaths = vi.fn();
    const warn = vi.fn();

    await reconcileBootstrapPathsForAllWorkspaces({
      workspaceRepo: { list: async () => [] },
      workspaceService: { reconcileBootstrapPaths },
      warn
    });

    expect(reconcileBootstrapPaths).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
