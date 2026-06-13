import type { Context, Hono } from "hono";
import {
  assertInspectorWorkspace,
  isRequestBodyTooLargeError,
  rejectUnexpectedRequestBody,
  proxyDaemonJson,
  type InspectorProxyOptions
} from "./shared.js";

// A1 (HITL daemon backbone) — Inspector tooling-loopback for the new
// pending-proposals listing tool plus accept/reject. The Inspector is
// not an agent surface; it never participates in agent control flow.
// Both routes proxy to the daemon's workspace-scoped HTTP endpoints
// (see apps/core-daemon/src/routes/proposals.ts), which themselves
// invoke the same MCP handler attached agents call.
export function registerInspectorProposalRoutes(app: Hono, options: InspectorProxyOptions): void {
  app.get("/api/proposals/:workspaceId/pending", async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const forbidden = assertInspectorWorkspace(context, options, workspaceId);
    if (forbidden !== null) return forbidden;
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
    const forbidden = assertInspectorWorkspace(context, options, workspaceId);
    if (forbidden !== null) return forbidden;
    const proposalId = context.req.param("proposalId");
    let body: unknown;
    try {
      body = await context.req.json();
    } catch (error) {
      if (isRequestBodyTooLargeError(error)) {
        throw error;
      }
      return context.json({ error: "invalid_request" }, 400);
    }
    return await proxyDaemonJson(context, options, {
      method: "POST",
      path: `/workspaces/${encodeURIComponent(workspaceId)}/proposals/${encodeURIComponent(proposalId)}/review`,
      body: bindReviewerIdentity(body, options),
      // Review is routed through the soul.* memory tool handler, which
      // returns a closed {success: false, error: {code, message}} envelope.
      // Forward it verbatim so MCP / Inspector / CLI report identical
      // error.code + error.message.
      forwardStructuredError: true
    });
  });

  app.post("/api/proposals/:workspaceId/memory/:memoryId/keep", async (context) =>
    await proxyMemoryAction(context, options, "keep")
  );
  app.post("/api/proposals/:workspaceId/memory/:memoryId/rewrite", async (context) =>
    await proxyMemoryAction(context, options, "rewrite")
  );
  app.post("/api/proposals/:workspaceId/memory/:memoryId/downgrade", async (context) =>
    await proxyMemoryAction(context, options, "downgrade")
  );
  app.post("/api/proposals/:workspaceId/memory/:memoryId/retire", async (context) =>
    await proxyMemoryAction(context, options, "retire")
  );

  // The MemoryBrowser "Promote to strictly_governed" action calls the
  // daemon-style path directly (see apps/inspector/web/src/pages/MemoryBrowser.tsx).
  // It forwards to the daemon endpoint that opens a path_relation governance
  // proposal (see apps/core-daemon/src/routes/proposals.ts) — the Inspector
  // never mutates durable truth, only proposes through the governed lifecycle.
  app.post(
    "/api/workspaces/:workspaceId/soul/memory/:memoryId/proposals/promote-strictly-governed",
    async (context) => {
      const workspaceId = context.req.param("workspaceId");
      const memoryId = context.req.param("memoryId");
      if (workspaceId === undefined || memoryId === undefined) {
        return context.json({ error: "invalid_request" }, 400);
      }
      const forbidden = assertInspectorWorkspace(context, options, workspaceId);
      if (forbidden !== null) return forbidden;
      let body: unknown = undefined;
      try {
        body = await context.req.json();
      } catch (error) {
        if (isRequestBodyTooLargeError(error)) {
          throw error;
        }
        body = undefined;
      }
      return await proxyDaemonJson(context, options, {
        method: "POST",
        path: `/workspaces/${encodeURIComponent(workspaceId)}/soul/memory/${encodeURIComponent(memoryId)}/proposals/promote-strictly-governed`,
        body,
        forwardStructuredError: true
      });
    }
  );
}

async function proxyMemoryAction(
  context: Context,
  options: InspectorProxyOptions,
  action: "keep" | "rewrite" | "downgrade" | "retire"
): Promise<Response> {
  const workspaceId = context.req.param("workspaceId");
  const memoryId = context.req.param("memoryId");
  if (workspaceId === undefined || memoryId === undefined) {
    return context.json({ error: "invalid_request" }, 400);
  }
  const forbidden = assertInspectorWorkspace(context, options, workspaceId);
  if (forbidden !== null) return forbidden;
  if (action !== "rewrite") {
    const unexpectedBody = await rejectUnexpectedRequestBody(context);
    if (unexpectedBody !== null) return unexpectedBody;
  }
  let body: unknown = undefined;
  if (action === "rewrite") {
    try {
      body = await context.req.json();
    } catch (error) {
      if (isRequestBodyTooLargeError(error)) {
        throw error;
      }
      return context.json({ error: "invalid_request" }, 400);
    }
  }
  return await proxyDaemonJson(context, options, {
    method: "POST",
    path: `/workspaces/${encodeURIComponent(workspaceId)}/soul/memory/${encodeURIComponent(memoryId)}/proposals/${action}`,
    body,
    forwardStructuredError: true
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
