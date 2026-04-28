import { CoreError, type WorkspaceService } from "@do-what/core";
import type { Hono } from "hono";
import { parseJsonBody } from "./shared.js";
import type { AppConfigService } from "../services/config-service.js";
import type { EnvironmentStatusService } from "../services/environment-status-service.js";

export interface ConfigRouteServices {
  readonly workspaceService: WorkspaceService;
  readonly configService?: AppConfigService;
  readonly environmentStatusService?: EnvironmentStatusService;
}

export function registerConfigRoutes(app: Hono, services: ConfigRouteServices): void {
  if (services.configService !== undefined) {
    app.get("/workspaces/:workspaceId/config/soul", async (context) => {
      const workspaceId = await requireWorkspace(services.workspaceService, context.req.param("workspaceId"));
      const config = await services.configService!.getSoulConfig(workspaceId);
      return context.json({ success: true, data: config }, 200);
    });

    app.patch("/workspaces/:workspaceId/config/soul", async (context) => {
      const workspaceId = await requireWorkspace(services.workspaceService, context.req.param("workspaceId"));
      const config = await services.configService!.patchSoulConfig(
        workspaceId,
        await parseJsonBody(context.req.json.bind(context.req))
      );
      return context.json({ success: true, data: config }, 200);
    });

    app.get("/workspaces/:workspaceId/config/strategy", async (context) => {
      const workspaceId = await requireWorkspace(services.workspaceService, context.req.param("workspaceId"));
      const config = await services.configService!.getStrategyConfig(workspaceId);
      return context.json({ success: true, data: config }, 200);
    });

    app.patch("/workspaces/:workspaceId/config/strategy", async (context) => {
      const workspaceId = await requireWorkspace(services.workspaceService, context.req.param("workspaceId"));
      const config = await services.configService!.patchStrategyConfig(
        workspaceId,
        await parseJsonBody(context.req.json.bind(context.req))
      );
      return context.json({ success: true, data: config }, 200);
    });

    app.get("/workspaces/:workspaceId/config/environment", async (context) => {
      const workspaceId = await requireWorkspace(services.workspaceService, context.req.param("workspaceId"));
      const config = await services.configService!.getEnvironmentConfig(workspaceId);
      return context.json({ success: true, data: config }, 200);
    });

    app.patch("/workspaces/:workspaceId/config/environment", async (context) => {
      const workspaceId = await requireWorkspace(services.workspaceService, context.req.param("workspaceId"));
      const config = await services.configService!.patchEnvironmentConfig(
        workspaceId,
        await parseJsonBody(context.req.json.bind(context.req))
      );
      return context.json({ success: true, data: config }, 200);
    });
  }

  if (services.environmentStatusService !== undefined) {
    app.get("/workspaces/:workspaceId/environment-status", async (context) => {
      await requireWorkspace(services.workspaceService, context.req.param("workspaceId"));
      const status = await services.environmentStatusService!.getStatus();
      return context.json({ success: true, data: status }, 200);
    });
  }
}

async function requireWorkspace(workspaceService: WorkspaceService, workspaceId: string): Promise<string> {
  const trimmed = workspaceId.trim();

  if (trimmed.length === 0) {
    throw new CoreError("VALIDATION", "workspaceId is required");
  }

  await workspaceService.getById(trimmed);
  return trimmed;
}

