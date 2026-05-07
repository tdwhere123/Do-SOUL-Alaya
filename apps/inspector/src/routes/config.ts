import {
  EnvironmentConfigSchema,
  SoulConfigSchema,
  StrategyConfigSchema
} from "@do-soul/alaya-protocol";
import type { Hono } from "hono";
import { proxyDaemonJson, type InspectorProxyOptions } from "./shared.js";

export function registerInspectorConfigRoutes(
  app: Hono,
  options: InspectorProxyOptions
): void {
  registerConfigSection(app, options, "soul", SoulConfigSchema.unwrap().partial().strict());
  registerConfigSection(app, options, "strategy", StrategyConfigSchema.unwrap().partial().strict());
  registerConfigSection(app, options, "environment", EnvironmentConfigSchema.unwrap().partial().strict());

  app.get("/api/config/:workspaceId/embedding-supplement", async (context) => {
    return await proxyDaemonJson(context, options, {
      method: "GET",
      path: "/config/runtime/embedding-supplement"
    });
  });

  app.patch("/api/config/runtime/embedding-supplement", async (context) => {
    return await proxyDaemonJson(context, options, {
      method: "PATCH",
      path: "/config/runtime/embedding-supplement",
      body: await context.req.json()
    });
  });

  app.get("/api/config/:workspaceId/garden-compute", async (context) => {
    return await proxyDaemonJson(context, options, {
      method: "GET",
      path: "/config/runtime/garden-compute"
    });
  });

  app.patch("/api/config/runtime/garden-compute", async (context) => {
    return await proxyDaemonJson(context, options, {
      method: "PATCH",
      path: "/config/runtime/garden-compute",
      body: await context.req.json()
    });
  });

  // U2: surface embedding init/runtime failures inline in the Inspector
  // config form. The daemon already records degraded_reason via the health
  // journal; this proxy gives the form a clean read path.
  app.get("/api/embedding-status/:workspaceId", async (context) => {
    return await proxyDaemonJson(context, options, {
      method: "GET",
      path: `/workspaces/${encodeURIComponent(context.req.param("workspaceId"))}/embedding-status`
    });
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
