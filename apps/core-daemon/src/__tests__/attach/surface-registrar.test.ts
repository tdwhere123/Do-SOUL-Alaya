import { describe, expect, it, vi } from "vitest";
import {
  canonicalAgentSurfaceId,
  createAttachSurfaceRegistrar
} from "../../attach/surface-registrar.js";

describe("createAttachSurfaceRegistrar", () => {
  it("creates a surface on first attach per (workspace, agent_target) and skips a subsequent existing row", async () => {
    const created: Array<{ surface_id: string; workspace_id: string }> = [];
    let existing: { surface_id: string; workspace_id: string } | null = null;
    const surfaceService = {
      findBySurfaceId: vi.fn(async (surface_id: string, workspace_id: string) => {
        if (existing !== null && existing.surface_id === surface_id && existing.workspace_id === workspace_id) {
          return { surface_id, workspace_id };
        }
        return null;
      }),
      createSurface: vi.fn(async (input: { surface_id: string; surface_kind: string; workspace_id: string; created_by: string }) => {
        existing = { surface_id: input.surface_id, workspace_id: input.workspace_id };
        created.push({ surface_id: input.surface_id, workspace_id: input.workspace_id });
        return { object_id: "obj-" + created.length };
      })
    };
    const registrar = createAttachSurfaceRegistrar({
      surfaceService: surfaceService as unknown as Parameters<typeof createAttachSurfaceRegistrar>[0]["surfaceService"]
    });
    await registrar.ensureAgentSurface({ workspaceId: "ws1", agentTarget: "codex" });
    await registrar.ensureAgentSurface({ workspaceId: "ws1", agentTarget: "codex" });
    expect(surfaceService.createSurface).toHaveBeenCalledTimes(1);
    expect(created).toEqual([{ surface_id: "agent:codex", workspace_id: "ws1" }]);
    const callArgs = surfaceService.createSurface.mock.calls[0][0];
    expect(callArgs.surface_kind).toBe("mcp_agent_attach");
    expect(callArgs.created_by).toBe("attach:codex");
  });

  it("creates one row per agent_target per workspace", async () => {
    const seen = new Map<string, true>();
    const surfaceService = {
      findBySurfaceId: vi.fn(async (surface_id: string, workspace_id: string) => {
        const key = `${workspace_id}|${surface_id}`;
        return seen.has(key) ? { surface_id, workspace_id } : null;
      }),
      createSurface: vi.fn(async (input: { surface_id: string; workspace_id: string }) => {
        seen.set(`${input.workspace_id}|${input.surface_id}`, true);
        return {};
      })
    };
    const registrar = createAttachSurfaceRegistrar({
      surfaceService: surfaceService as unknown as Parameters<typeof createAttachSurfaceRegistrar>[0]["surfaceService"]
    });
    await registrar.ensureAgentSurface({ workspaceId: "ws1", agentTarget: "codex" });
    await registrar.ensureAgentSurface({ workspaceId: "ws1", agentTarget: "claude-code" });
    await registrar.ensureAgentSurface({ workspaceId: "ws2", agentTarget: "codex" });
    expect(surfaceService.createSurface).toHaveBeenCalledTimes(3);
  });

  it("treats CONFLICT from createSurface as a successful idempotent registration", async () => {
    const surfaceService = {
      findBySurfaceId: vi.fn(async () => null),
      createSurface: vi.fn(async () => {
        const err: { code: string; message: string } = { code: "CONFLICT", message: "exists" };
        throw err;
      })
    };
    const registrar = createAttachSurfaceRegistrar({
      surfaceService: surfaceService as unknown as Parameters<typeof createAttachSurfaceRegistrar>[0]["surfaceService"]
    });
    await expect(
      registrar.ensureAgentSurface({ workspaceId: "ws1", agentTarget: "codex" })
    ).resolves.toBeUndefined();
  });

  it("propagates non-conflict errors so the handler can warn and retry next call", async () => {
    const surfaceService = {
      findBySurfaceId: vi.fn(async () => null),
      createSurface: vi.fn(async () => {
        throw new Error("transient db error");
      })
    };
    const warn = vi.fn();
    const registrar = createAttachSurfaceRegistrar({ surfaceService, warn });
    await expect(
      registrar.ensureAgentSurface({ workspaceId: "ws1", agentTarget: "codex" })
    ).rejects.toThrow(/transient db error/);
    expect(warn).toHaveBeenCalled();
  });

  it("canonicalAgentSurfaceId namespaces the surface_id under agent:", () => {
    expect(canonicalAgentSurfaceId("codex")).toBe("agent:codex");
    expect(canonicalAgentSurfaceId("claude-code")).toBe("agent:claude-code");
  });
});
