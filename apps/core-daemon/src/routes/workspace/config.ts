import { CoreError, type WorkspaceService } from "@do-soul/alaya-core";
import {
  EnvironmentConfigSchema,
  ManifestationBudgetConfigSchema,
  RuntimeEmbeddingConfigSchema,
  RuntimeGardenComputeConfigSchema,
  SoulConfigSchema,
  StrategyConfigSchema,
  ToolchainStatusSchema,
  bindStandardConfigPatchResponse,
  bindStandardResponse
} from "@do-soul/alaya-protocol";
import type { Context, Hono } from "hono";
import { z, type ZodTypeAny } from "zod";
import { parseJsonBody } from "../shared/shared.js";
import type { AppConfigService } from "../../services/config-service.js";
import type { EnvironmentStatusService } from "../../services/environment-status-service.js";

const ManifestationBudgetReadSchema = ManifestationBudgetConfigSchema.and(
  z.object({ source: z.enum(["default", "stored"]) }).readonly()
);

export interface ConfigRouteServices {
  readonly workspaceService: WorkspaceService;
  readonly configService?: AppConfigService;
  readonly environmentStatusService?: EnvironmentStatusService;
}

export function registerConfigRoutes(app: Hono, services: ConfigRouteServices): void {
  const { configService } = services;
  if (configService !== undefined) {
    registerWorkspaceConfigRoutes(app, services, configService);
    registerRuntimeConfigRoutes(app, configService);
    registerManifestationBudgetRoutes(app, services, configService);
  }

  const { environmentStatusService } = services;
  if (environmentStatusService !== undefined) {
    registerEnvironmentStatusRoute(app, services, environmentStatusService);
  }
}

function registerWorkspaceConfigRoutes(
  app: Hono,
  services: ConfigRouteServices,
  configService: AppConfigService
): void {
  registerWorkspaceConfigRoute(app, services, configService, "soul", SoulConfigSchema);
  registerWorkspaceConfigRoute(app, services, configService, "strategy", StrategyConfigSchema);
  registerWorkspaceConfigRoute(app, services, configService, "environment", EnvironmentConfigSchema);
}

function registerWorkspaceConfigRoute<T extends ZodTypeAny>(
  app: Hono,
  services: ConfigRouteServices,
  configService: AppConfigService,
  section: "soul" | "strategy" | "environment",
  schema: T
): void {
  app.get(`/workspaces/:workspaceId/config/${section}`, async (context) => {
    const workspaceId = await requireWorkspace(services.workspaceService, context.req.param("workspaceId"));
    const config = await readWorkspaceConfig(configService, section, workspaceId);
    return jsonStandardResponse(context, schema, config);
  });

  app.patch(`/workspaces/:workspaceId/config/${section}`, async (context) => {
    const workspaceId = await requireWorkspace(services.workspaceService, context.req.param("workspaceId"));
    const config = await patchWorkspaceConfig(
      configService,
      section,
      workspaceId,
      await parseJsonBody(context.req.json.bind(context.req), parseConfigPatchBody)
    );
    return jsonStandardResponse(context, schema, config);
  });
}

async function readWorkspaceConfig(
  configService: AppConfigService,
  section: "soul" | "strategy" | "environment",
  workspaceId: string
) {
  switch (section) {
    case "soul":
      return await configService.getSoulConfig(workspaceId);
    case "strategy":
      return await configService.getStrategyConfig(workspaceId);
    case "environment":
      return await configService.getEnvironmentConfig(workspaceId);
  }
}

async function patchWorkspaceConfig(
  configService: AppConfigService,
  section: "soul" | "strategy" | "environment",
  workspaceId: string,
  patch: Record<string, unknown>
) {
  switch (section) {
    case "soul":
      return await configService.patchSoulConfig(workspaceId, patch);
    case "strategy":
      return await configService.patchStrategyConfig(workspaceId, patch);
    case "environment":
      return await configService.patchEnvironmentConfig(workspaceId, patch);
  }
}

function registerRuntimeConfigRoutes(app: Hono, configService: AppConfigService): void {
  app.get("/config/runtime/embedding-supplement", async (context) => {
    const config = await configService.getRuntimeEmbeddingConfig();
    return jsonStandardResponse(context, RuntimeEmbeddingConfigSchema, config);
  });

  app.patch("/config/runtime/embedding-supplement", async (context) => {
    const config = await configService.patchRuntimeEmbeddingConfig(
      await parseJsonBody(context.req.json.bind(context.req), parseConfigPatchBody)
    );
    return jsonConfigPatchResponse(context, RuntimeEmbeddingConfigSchema, config, true);
  });

  app.get("/config/runtime/garden-compute", async (context) => {
    const config = await configService.getRuntimeGardenComputeConfig();
    return jsonStandardResponse(context, RuntimeGardenComputeConfigSchema, config);
  });

  app.patch("/config/runtime/garden-compute", async (context) => {
    const config = await configService.patchRuntimeGardenComputeConfig(
      await parseJsonBody(context.req.json.bind(context.req), parseConfigPatchBody)
    );
    return jsonConfigPatchResponse(context, RuntimeGardenComputeConfigSchema, config, false);
  });
}

function registerManifestationBudgetRoutes(
  app: Hono,
  services: ConfigRouteServices,
  configService: AppConfigService
): void {
  app.get("/workspaces/:workspaceId/config/manifestation-budget", async (context) => {
    const workspaceId = await requireWorkspace(services.workspaceService, context.req.param("workspaceId"));
    const result = await configService.getManifestationBudgetConfig(workspaceId);
    return jsonStandardResponse(context, ManifestationBudgetReadSchema, {
      ...result.config,
      source: result.source
    });
  });

  app.patch("/workspaces/:workspaceId/config/manifestation-budget", async (context) => {
    const workspaceId = await requireWorkspace(services.workspaceService, context.req.param("workspaceId"));
    const saved = await configService.patchManifestationBudgetConfig(
      workspaceId,
      await parseJsonBody(context.req.json.bind(context.req), parseConfigPatchBody)
    );
    return jsonStandardResponse(context, ManifestationBudgetConfigSchema, saved);
  });
}

function registerEnvironmentStatusRoute(
  app: Hono,
  services: ConfigRouteServices,
  environmentStatusService: EnvironmentStatusService
): void {
  app.get("/workspaces/:workspaceId/environment-status", async (context) => {
    await requireWorkspace(services.workspaceService, context.req.param("workspaceId"));
    const status = await environmentStatusService.getStatus();
    return jsonStandardResponse(context, ToolchainStatusSchema, status);
  });
}

function jsonStandardResponse<T extends ZodTypeAny>(
  context: Context,
  schema: T,
  data: unknown
): Response {
  return context.json(bindStandardResponse(schema, data), 200);
}

function jsonConfigPatchResponse<T extends ZodTypeAny>(
  context: Context,
  schema: T,
  data: unknown,
  requiresDaemonRestart: boolean
): Response {
  return context.json(
    bindStandardConfigPatchResponse(schema, data, { requiresDaemonRestart }),
    200
  );
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
