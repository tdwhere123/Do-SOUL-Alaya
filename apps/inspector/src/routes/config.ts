import {
  EnvironmentConfigSchema,
  RuntimeEmbeddingConfigPatchSchema,
  SoulConfigSchema,
  StrategyConfigSchema
} from "@do-soul/alaya-protocol";
import type { Hono } from "hono";
import { patchRuntimeEmbeddingEnv, type InspectorConfigPaths } from "../config-store.js";
import { proxyDaemonJson, type InspectorProxyOptions } from "./shared.js";

export function registerInspectorConfigRoutes(
  app: Hono,
  options: InspectorProxyOptions & {
    readonly configPathsProvider: () => InspectorConfigPaths;
    readonly clock?: () => string;
  }
): void {
  registerConfigSection(app, options, "soul", SoulConfigSchema.unwrap().partial().strict());
  registerConfigSection(app, options, "strategy", StrategyConfigSchema.unwrap().partial().strict());
  registerConfigSection(app, options, "environment", EnvironmentConfigSchema.unwrap().partial().strict());

  app.get("/api/config/:workspaceId/embedding-supplement", async (context) =>
    await proxyDaemonJson(context, options, {
      method: "GET",
      path: `/workspaces/${encodeURIComponent(context.req.param("workspaceId"))}/embedding-status`
    })
  );

  app.patch("/api/config/runtime/embedding-supplement", async (context) => {
    const rawPatch = await context.req.json();
    const patch = RuntimeEmbeddingConfigPatchSchema.parse(rawPatch);
    const result = await patchRuntimeEmbeddingEnv({
      patch,
      paths: options.configPathsProvider(),
      clock: options.clock
    });
    return context.json({
      success: true,
      data: result.patch,
      requires_daemon_restart: true
    }, 200);
  });
}

function registerConfigSection(
  app: Hono,
  options: InspectorProxyOptions,
  section: "soul" | "strategy" | "environment",
  patchSchema: { parse(input: unknown): unknown }
): void {
  app.get(`/api/config/:workspaceId/${section}`, async (context) =>
    await proxyDaemonJson(context, options, {
      method: "GET",
      path: `/workspaces/${encodeURIComponent(context.req.param("workspaceId"))}/config/${section}`
    })
  );

  app.patch(`/api/config/:workspaceId/${section}`, async (context) => {
    const body = patchSchema.parse(await context.req.json());
    return await proxyDaemonJson(context, options, {
      method: "PATCH",
      path: `/workspaces/${encodeURIComponent(context.req.param("workspaceId"))}/config/${section}`,
      body
    });
  });
}
