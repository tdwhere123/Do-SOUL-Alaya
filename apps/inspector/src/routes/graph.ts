import type { Hono } from "hono";
import { assertInspectorWorkspace, proxyDaemonJson, type InspectorProxyOptions } from "./shared.js";

// invariant: the Inspector Graph surface is served from the unified
// path_relations plane via the daemon's read-only path-graph projection.
// The Inspector is a memory-tooling loopback, not an agent surface; this
// route only forwards the workspace-scoped GET to the daemon.
// see also: apps/core-daemon/src/routes/path-graph.ts
//           apps/inspector/web/src/pages/Graph.tsx
export function registerInspectorGraphRoutes(app: Hono, options: InspectorProxyOptions): void {
  app.get("/api/graph/:workspaceId", async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const forbidden = assertInspectorWorkspace(context, options, workspaceId);
    if (forbidden !== null) return forbidden;
    return await proxyDaemonJson(context, options, {
      method: "GET",
      path: `/workspaces/${encodeURIComponent(workspaceId)}/path-graph`
    });
  });
}
