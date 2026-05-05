import type { Hono } from "hono";
import { proxyDaemonJson, type InspectorProxyOptions } from "./shared.js";

// A1 (HITL daemon backbone) — Inspector tooling-loopback for the new
// pending-proposals listing tool plus accept/reject. The Inspector is
// not an agent surface; it never participates in agent control flow.
// Both routes proxy to the daemon's workspace-scoped HTTP endpoints
// (see apps/core-daemon/src/routes/proposals.ts), which themselves
// invoke the same MCP handler attached agents call.
export function registerInspectorProposalRoutes(app: Hono, options: InspectorProxyOptions): void {
  app.get("/api/proposals/:workspaceId/pending", async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const since = context.req.query("since");
    const limit = context.req.query("limit");
    const search = new URLSearchParams();
    if (since !== undefined && since.length > 0) search.set("since", since);
    if (limit !== undefined && limit.length > 0) search.set("limit", limit);
    const query = search.toString();
    return await proxyDaemonJson(context, options, {
      method: "GET",
      path: `/workspaces/${encodeURIComponent(workspaceId)}/proposals/pending${query.length > 0 ? `?${query}` : ""}`
    });
  });

  app.post("/api/proposals/:workspaceId/:proposalId/review", async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const proposalId = context.req.param("proposalId");
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: "invalid_request" }, 400);
    }
    return await proxyDaemonJson(context, options, {
      method: "POST",
      path: `/workspaces/${encodeURIComponent(workspaceId)}/proposals/${encodeURIComponent(proposalId)}/review`,
      body: bindReviewerIdentity(body, options)
    });
  });
}

function bindReviewerIdentity(body: unknown, options: InspectorProxyOptions): unknown {
  if (options.reviewerToken === undefined || options.reviewerIdentity === undefined) {
    return body;
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return body;
  }
  return {
    ...body,
    reviewer_identity: options.reviewerIdentity,
    reviewer_token: options.reviewerToken
  };
}
