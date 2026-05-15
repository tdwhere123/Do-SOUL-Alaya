import type { Hono } from "hono";
import {
  assertInspectorWorkspace,
  proxyDaemonJson,
  type InspectorProxyOptions
} from "./shared.js";

export function registerInspectorRecallStatsRoutes(
  app: Hono,
  options: InspectorProxyOptions
): void {
  app.get("/api/recall-stats/:workspaceId", async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const forbidden = assertInspectorWorkspace(context, options, workspaceId);
    if (forbidden !== null) return forbidden;

    const search = new URLSearchParams();
    const since = context.req.query("since");
    const until = context.req.query("until");
    const exclude = context.req.query("excludeAgentTargets");
    if (since !== undefined && since.length > 0) search.set("since", since);
    if (until !== undefined && until.length > 0) search.set("until", until);
    if (exclude !== undefined && exclude.length > 0)
      search.set("excludeAgentTargets", exclude);
    const query = search.toString();

    return await proxyDaemonJson(context, options, {
      method: "GET",
      path: `/workspaces/${encodeURIComponent(workspaceId)}/recall-stats${
        query.length > 0 ? `?${query}` : ""
      }`
    });
  });
}
