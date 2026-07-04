import type { Hono } from "hono";
import { EmbeddingStatusSchema, type EmbeddingStatus } from "@do-soul/alaya-protocol";
import type { WorkspaceService } from "@do-soul/alaya-core";

export interface EmbeddingStatusRouteServices {
  readonly workspaceService: Pick<WorkspaceService, "getById">;
  readonly embeddingStatusService: {
    getStatus(workspaceId: string): Promise<EmbeddingStatus>;
  };
}

export function registerEmbeddingStatusRoutes(
  app: Hono,
  services: EmbeddingStatusRouteServices
): void {
  app.get("/workspaces/:workspaceId/embedding-status", async (context) => {
    const workspaceId = context.req.param("workspaceId");
    await services.workspaceService.getById(workspaceId);
    const status = await services.embeddingStatusService.getStatus(workspaceId);
    return context.json({ success: true, data: EmbeddingStatusSchema.parse(status) }, 200);
  });
}
