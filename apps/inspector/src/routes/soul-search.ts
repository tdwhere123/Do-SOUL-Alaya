import type { Hono } from "hono";
import { assertInspectorWorkspace, proxyDaemonJson, type InspectorProxyOptions } from "./shared.js";

// Inspector loopback for the NL+time-aware search bar. Forwards body verbatim
// to the daemon's POST /workspaces/:wsId/soul/search, which routes through
// the same MCP soul.recall handler attached agents use.
export function registerInspectorSoulSearchRoutes(
  app: Hono,
  options: InspectorProxyOptions
): void {
  app.post("/api/soul/search/:workspaceId", async (context) => {
    const workspaceId = context.req.param("workspaceId");
    if (workspaceId === undefined) {
      return context.json({ error: "invalid_request" }, 400);
    }
    const forbidden = assertInspectorWorkspace(context, options, workspaceId);
    if (forbidden !== null) return forbidden;
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: "invalid_request" }, 400);
    }
    return await proxyDaemonJson(context, options, {
      method: "POST",
      path: `/workspaces/${encodeURIComponent(workspaceId)}/soul/search`,
      body,
      forwardStructuredError: true
    });
  });
}
