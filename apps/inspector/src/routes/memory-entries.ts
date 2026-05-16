import type { Hono } from "hono";
import { assertInspectorWorkspace, proxyDaemonJson, type InspectorProxyOptions } from "./shared.js";

// invariant: Inspector is a tooling loopback, not an agent surface.
// Both the memory list and the pointer fetch are proxied through
// workspace-scoped daemon routes: GET /workspaces/{ws}/memories and
// GET /workspaces/{ws}/evidence/{id}. The latter uses
// `EvidenceService.findByIdScoped` so a caller cannot read another
// workspace's evidence by object_id alone.
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
      path: `/workspaces/${encodeURIComponent(workspaceId)}/evidence/${encodeURIComponent(objectId)}`
    });
  });
}
