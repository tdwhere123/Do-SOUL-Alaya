import type { Hono } from "hono";
import type { WorkspaceService } from "@do-soul/alaya-core";
import type { RecallUtilizationService } from "../services/recall-utilization-service.js";

export interface RecallStatsRouteServices {
  readonly workspaceService: Pick<WorkspaceService, "getById">;
  readonly recallUtilizationService: RecallUtilizationService;
}

export function registerRecallStatsRoutes(
  app: Hono,
  services: RecallStatsRouteServices
): void {
  app.get("/workspaces/:workspaceId/recall-stats", async (context) => {
    const workspaceId = context.req.param("workspaceId");
    await services.workspaceService.getById(workspaceId);

    const since = normalizeQueryString(context.req.query("since"));
    const until = normalizeQueryString(context.req.query("until"));
    const excludeRaw = normalizeQueryString(context.req.query("excludeAgentTargets"));
    const excludeAgentTargets =
      excludeRaw === null
        ? undefined
        : excludeRaw
            .split(",")
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0);

    const stats = await services.recallUtilizationService.getStats({
      workspaceId,
      since,
      until,
      excludeAgentTargets
    });

    return context.json({ success: true, data: stats }, 200);
  });
}

function normalizeQueryString(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed;
}
