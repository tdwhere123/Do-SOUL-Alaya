import type { Hono } from "hono";
import { proxyDaemonJson, type InspectorProxyOptions } from "./shared.js";

export function registerInspectorGraphRoutes(app: Hono, options: InspectorProxyOptions): void {
  app.get("/api/graph/:workspaceId", async (context) =>
    await proxyDaemonJson(context, options, {
      method: "GET",
      path: `/workspaces/${encodeURIComponent(context.req.param("workspaceId"))}/soul/graph`
    })
  );
}
