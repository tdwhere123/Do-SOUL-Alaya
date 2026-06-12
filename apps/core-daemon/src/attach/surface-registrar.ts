import type { SurfaceService } from "@do-soul/alaya-core";

// invariant: ensureAgentSurface is the MCP-side counterpart to the
// profile-file attach commands. Profile mutation makes the agent's client
// config point at Alaya, but it never reaches the daemon's
// surface_identities table. This registrar fills that gap: the first
// MCP tool call from each (workspace_id, agent_target) writes a single
// surface_identities row + SOUL_SURFACE_CREATED audit event, and every
// later call hits the in-memory dedupe in the MCP handler.
// see also: apps/core-daemon/src/cli/attach/codex.ts:createAttachCodexCommandSpec
// see also: apps/core-daemon/src/cli/attach/claude.ts:createAttachClaudeCommandSpec
// see also: apps/core-daemon/src/mcp-memory/tool-handler.ts
// see also: packages/core/src/surfaces/surface-service.ts:SurfaceService.createSurface

export interface AttachSurfaceRegistrar {
  ensureAgentSurface(input: {
    readonly workspaceId: string;
    readonly agentTarget: string;
  }): Promise<void>;
}

export interface AttachSurfaceRegistrarDeps {
  readonly surfaceService: Pick<SurfaceService, "createSurface" | "findBySurfaceId">;
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
}

export function createAttachSurfaceRegistrar(
  deps: AttachSurfaceRegistrarDeps
): AttachSurfaceRegistrar {
  return {
    async ensureAgentSurface({ workspaceId, agentTarget }): Promise<void> {
      const surfaceId = canonicalAgentSurfaceId(agentTarget);
      const existing = await deps.surfaceService.findBySurfaceId(surfaceId, workspaceId);
      if (existing !== null) return;
      try {
        await deps.surfaceService.createSurface({
          surface_id: surfaceId,
          surface_kind: "mcp_agent_attach",
          workspace_id: workspaceId,
          created_by: `attach:${agentTarget}`
        });
      } catch (error) {
        if (isConflictError(error)) {
          // invariant: CONFLICT after the probe means another caller won the
          // create race; the row exists, so registration is already satisfied.
          return;
        }
        deps.warn?.("ensureAgentSurface createSurface failed", {
          workspace_id: workspaceId,
          agent_target: agentTarget,
          surface_id: surfaceId,
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }
    }
  };
}

export function canonicalAgentSurfaceId(agentTarget: string): string {
  return `agent:${agentTarget}`;
}

function isConflictError(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const candidate = error as { readonly code?: unknown };
  return candidate.code === "CONFLICT";
}
