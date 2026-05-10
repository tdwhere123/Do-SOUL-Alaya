import type { Hono } from "hono";
import { assertInspectorWorkspace, proxyDaemonJson, type InspectorProxyOptions } from "./shared.js";

export function registerInspectorGraphRoutes(app: Hono, options: InspectorProxyOptions): void {
  app.get("/api/graph/:workspaceId", async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const forbidden = assertInspectorWorkspace(context, options, workspaceId);
    if (forbidden !== null) return forbidden;
    return await proxyDaemonJson(context, options, {
      method: "GET",
      path: `/workspaces/${encodeURIComponent(workspaceId)}/soul/graph`
    });
  });
}
