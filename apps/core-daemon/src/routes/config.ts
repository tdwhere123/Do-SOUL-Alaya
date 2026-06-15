import { CoreError, type WorkspaceService } from "@do-soul/alaya-core";
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
  const { configService } = services;
  if (configService !== undefined) {
    app.get("/workspaces/:workspaceId/config/soul", async (context) => {
      const workspaceId = await requireWorkspace(services.workspaceService, context.req.param("workspaceId"));
      const config = await configService.getSoulConfig(workspaceId);
      return context.json({ success: true, data: config }, 200);
    });

    app.patch("/workspaces/:workspaceId/config/soul", async (context) => {
      const workspaceId = await requireWorkspace(services.workspaceService, context.req.param("workspaceId"));
      const config = await configService.patchSoulConfig(
        workspaceId,
        await parseJsonBody(context.req.json.bind(context.req), parseConfigPatchBody)
      );
      return context.json({ success: true, data: config }, 200);
    });

    app.get("/workspaces/:workspaceId/config/strategy", async (context) => {
      const workspaceId = await requireWorkspace(services.workspaceService, context.req.param("workspaceId"));
      const config = await configService.getStrategyConfig(workspaceId);
      return context.json({ success: true, data: config }, 200);
    });

    app.patch("/workspaces/:workspaceId/config/strategy", async (context) => {
      const workspaceId = await requireWorkspace(services.workspaceService, context.req.param("workspaceId"));
      const config = await configService.patchStrategyConfig(
        workspaceId,
        await parseJsonBody(context.req.json.bind(context.req), parseConfigPatchBody)
      );
      return context.json({ success: true, data: config }, 200);
    });

    app.get("/workspaces/:workspaceId/config/environment", async (context) => {
      const workspaceId = await requireWorkspace(services.workspaceService, context.req.param("workspaceId"));
      const config = await configService.getEnvironmentConfig(workspaceId);
      return context.json({ success: true, data: config }, 200);
    });

    app.patch("/workspaces/:workspaceId/config/environment", async (context) => {
      const workspaceId = await requireWorkspace(services.workspaceService, context.req.param("workspaceId"));
      const config = await configService.patchEnvironmentConfig(
        workspaceId,
        await parseJsonBody(context.req.json.bind(context.req), parseConfigPatchBody)
      );
      return context.json({ success: true, data: config }, 200);
    });

    app.get("/config/runtime/embedding-supplement", async (context) => {
      const config = await configService.getRuntimeEmbeddingConfig();
      return context.json({ success: true, data: config }, 200);
    });

    app.patch("/config/runtime/embedding-supplement", async (context) => {
      const config = await configService.patchRuntimeEmbeddingConfig(
        await parseJsonBody(context.req.json.bind(context.req), parseConfigPatchBody)
      );
      return context.json({ success: true, data: config, requires_daemon_restart: true }, 200);
    });

    app.get("/config/runtime/garden-compute", async (context) => {
      const config = await configService.getRuntimeGardenComputeConfig();
      return context.json({ success: true, data: config }, 200);
    });

    app.patch("/config/runtime/garden-compute", async (context) => {
      const config = await configService.patchRuntimeGardenComputeConfig(
        await parseJsonBody(context.req.json.bind(context.req), parseConfigPatchBody)
      );
      return context.json({ success: true, data: config, requires_daemon_restart: false }, 200);
    });

    app.get("/workspaces/:workspaceId/config/manifestation-budget", async (context) => {
      const workspaceId = await requireWorkspace(services.workspaceService, context.req.param("workspaceId"));
      const result = await configService.getManifestationBudgetConfig(workspaceId);
      return context.json({
        success: true,
        data: result.config,
        source: result.source
      }, 200);
    });

    app.patch("/workspaces/:workspaceId/config/manifestation-budget", async (context) => {
      const workspaceId = await requireWorkspace(services.workspaceService, context.req.param("workspaceId"));
      const saved = await configService.patchManifestationBudgetConfig(
        workspaceId,
        await parseJsonBody(context.req.json.bind(context.req), parseConfigPatchBody)
      );
      return context.json({ success: true, data: saved, requires_daemon_restart: false }, 200);
    });
  }

  const { environmentStatusService } = services;
  if (environmentStatusService !== undefined) {
    app.get("/workspaces/:workspaceId/environment-status", async (context) => {
      await requireWorkspace(services.workspaceService, context.req.param("workspaceId"));
      const status = await environmentStatusService.getStatus();
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

function parseConfigPatchBody(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CoreError("VALIDATION", "Config patch body must be a JSON object");
  }

  return value as Record<string, unknown>;
}
