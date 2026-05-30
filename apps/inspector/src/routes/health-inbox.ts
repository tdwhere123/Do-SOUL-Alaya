import type { Hono } from "hono";
import { assertInspectorWorkspace, proxyDaemonJson, type InspectorProxyOptions } from "./shared.js";

// invariant: HealthInbox is a read-only projection over HealthIssueGroup
// rows. The Inspector is a memory-tooling loopback, not an agent surface;
// this route only forwards the workspace-scoped GET to the daemon.
// see also: apps/core-daemon/src/routes/health-inbox.ts
//           apps/inspector/web/src/pages/HealthInbox.tsx
export function registerInspectorHealthInboxRoutes(
  app: Hono,
  options: InspectorProxyOptions
): void {
  app.get("/api/workspaces/:workspaceId/health-inbox", async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const forbidden = assertInspectorWorkspace(context, options, workspaceId);
    if (forbidden !== null) return forbidden;
    const state = context.req.query("state");
    const causeKind = context.req.query("causeKind");
    const limit = context.req.query("limit");
    const search = new URLSearchParams();
    if (state !== undefined && state.length > 0) search.set("state", state);
    if (causeKind !== undefined && causeKind.length > 0) search.set("causeKind", causeKind);
    if (limit !== undefined && limit.length > 0) search.set("limit", limit);
    const query = search.toString();
    return await proxyDaemonJson(context, options, {
      method: "GET",
      path: `/workspaces/${encodeURIComponent(workspaceId)}/health-inbox${query.length > 0 ? `?${query}` : ""}`
    });
  });
}
