import type { Hono } from "hono";
import { CoreError, type MemoryService, type RunService, type WorkspaceService } from "@do-soul/alaya-core";
import { MemoryDimensionSchema } from "@do-soul/alaya-protocol";

export interface MemoryRouteServices {
  readonly workspaceService: WorkspaceService;
  readonly runService: RunService;
  readonly memoryService: MemoryService;
}

// HTTP route surface intentionally omits GET /memories/:id.
// v0.1.0 release surface is MCP + CLI only (see CLAUDE.md "no GUI" invariant).
// Per-memory read flows through:
//   - MCP: soul.open_pointer (mcp-memory-tool-handler, workspace-scoped)
//   - CLI fallback: alaya tools call --json '{"name":"soul.open_pointer", ...}'
// Removed in p5-system-review-r1 (MR-B02: route-layer cross-workspace leak).
export function registerMemoryRoutes(app: Hono, services: MemoryRouteServices): void {
  app.get("/workspaces/:wsId/memories", async (context) => {
    const workspaceId = context.req.param("wsId");
    await services.workspaceService.getById(workspaceId);

    const dimension = context.req.query("dimension");
    const memories =
      dimension === undefined
        ? await services.memoryService.findByWorkspaceId(workspaceId)
        : await services.memoryService.findByDimension(workspaceId, parseDimension(dimension));

    return context.json({ success: true, data: memories }, 200);
  });

  app.get("/runs/:runId/memories", async (context) => {
    const runId = context.req.param("runId");
    await services.runService.getById(runId);

    const memories = await services.memoryService.findByRunId(runId);
    return context.json({ success: true, data: memories }, 200);
  });
}

function parseDimension(value: string) {
  try {
    return MemoryDimensionSchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid memory dimension", { cause: error });
  }
}
