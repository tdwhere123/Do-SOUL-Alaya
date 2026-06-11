import type { Hono } from "hono";
import { CoreError, type MemoryService, type RunService, type WorkspaceService } from "@do-soul/alaya-core";
import { MemoryDimensionSchema } from "@do-soul/alaya-protocol";

export interface MemoryRouteServices {
  readonly workspaceService: WorkspaceService;
  readonly runService: RunService;
  readonly memoryService: MemoryService;
}

// HTTP route surface intentionally omits GET /memories/:id.
// Per-memory reads must stay workspace-scoped per invariants §21 and §29:
//   - MCP: soul.open_pointer (mcp-memory/tool-handler, workspace-scoped)
//   - CLI fallback: alaya tools call --json '{"name":"soul.open_pointer", ...}'
//   - Inspector: GET /workspaces/:wsId/memories and scoped pointer routes
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
