import type { Hono } from "hono";
import { assertInspectorWorkspace, proxyDaemonJson, type InspectorProxyOptions } from "./shared.js";

// invariant: Inspector is a tooling loopback, not an agent surface; it
// proxies the durable list-memories read to the daemon's workspace-scoped
// GET /workspaces/{ws}/memories with the same workspace assertion as the
// other inspector routes. The daemon route already enforces scope.
// see also: apps/core-daemon/src/routes/memories.ts
//          apps/core-daemon/src/routes/evidence.ts
export function registerInspectorMemoryEntryRoutes(
  app: Hono,
  options: InspectorProxyOptions
): void {
  app.get("/api/memory-entries/:workspaceId", async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const forbidden = assertInspectorWorkspace(context, options, workspaceId);
    if (forbidden !== null) return forbidden;
    const dimension = context.req.query("dimension");
    const search = new URLSearchParams();
    if (dimension !== undefined && dimension.length > 0) {
      search.set("dimension", dimension);
    }
    const query = search.toString();
    return await proxyDaemonJson(context, options, {
      method: "GET",
      path: `/workspaces/${encodeURIComponent(workspaceId)}/memories${query.length > 0 ? `?${query}` : ""}`
    });
  });

  app.get("/api/pointers/:workspaceId/:objectId", async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const forbidden = assertInspectorWorkspace(context, options, workspaceId);
    if (forbidden !== null) return forbidden;
    const objectId = context.req.param("objectId");
    return await proxyDaemonJson(context, options, {
      method: "GET",
      path: `/evidence/${encodeURIComponent(objectId)}`
    });
  });
}
