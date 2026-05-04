import type { Hono } from "hono";
import type { ProposalService, WorkspaceService } from "@do-soul/alaya-core";
import type { McpMemoryToolHandler } from "../mcp-memory-tool-handler.js";

export interface ProposalRouteServices {
  readonly workspaceService: WorkspaceService;
  readonly proposalService: ProposalService;
  // A1 (HITL daemon backbone) — the Inspector loopback uses these
  // workspace-scoped HTTP wrappers around the same MCP handler that
  // attached agents call. The wrappers exist on the daemon HTTP plane
  // (not the agent control plane): they are workspace-scoped at the
  // URL level, so the prior MR-B01 concern (non-atomic + no workspace
  // scoping in the removed POST /proposals/:id/review route) does not
  // re-open. CLI + MCP remain the canonical agent surfaces; the HTTP
  // surface here is for the Inspector tooling-loopback only.
  readonly mcpMemoryToolHandler?: McpMemoryToolHandler;
}

// HTTP route surface for proposals:
//   GET  /workspaces/:wsId/proposals                    (list pending or all)
//   GET  /workspaces/:wsId/proposals/pending            (Inspector summary)
//   POST /workspaces/:wsId/proposals/:proposalId/review (Inspector accept/reject)
// The bare POST /proposals/:id/review and GET /proposals/:id are still
// removed (MR-B01 / MR-B02 sibling) — every endpoint here binds the
// workspace from the URL and delegates downstream services to enforce
// that scope.
export function registerProposalRoutes(app: Hono, services: ProposalRouteServices): void {
  app.get("/workspaces/:wsId/proposals", async (context) => {
    const workspaceId = context.req.param("wsId");
    await services.workspaceService.getById(workspaceId);

    const state = context.req.query("state");
    const proposals =
      state === "all"
        ? await services.proposalService.findByWorkspaceId(workspaceId)
        : await services.proposalService.findPending(workspaceId);

    return context.json({ success: true, data: proposals }, 200);
  });

  app.get("/workspaces/:wsId/proposals/pending", async (context) => {
    const workspaceId = context.req.param("wsId");
    await services.workspaceService.getById(workspaceId);
    if (services.mcpMemoryToolHandler === undefined) {
      return context.json({ success: false, error: "memory tool handler unavailable" }, 503);
    }
    const since = context.req.query("since") ?? undefined;
    const limitRaw = context.req.query("limit");
    const limit = limitRaw === undefined ? undefined : Number.parseInt(limitRaw, 10);
    const args: Record<string, unknown> = { workspace_id: workspaceId };
    if (since !== undefined) args.since = since;
    if (limit !== undefined && Number.isFinite(limit)) args.limit = limit;

    const result = await services.mcpMemoryToolHandler.call({
      toolName: "soul.list_pending_proposals",
      arguments: args,
      context: {
        workspaceId,
        runId: null,
        agentTarget: "inspector"
      }
    });
    if (!result.ok) {
      const status = result.error.code === "VALIDATION" ? 400 : 500;
      return context.json({ success: false, error: result.error }, status);
    }
    return context.json({ success: true, data: result.output }, 200);
  });

  app.post("/workspaces/:wsId/proposals/:proposalId/review", async (context) => {
    const workspaceId = context.req.param("wsId");
    const proposalId = context.req.param("proposalId");
    await services.workspaceService.getById(workspaceId);
    if (services.mcpMemoryToolHandler === undefined) {
      return context.json({ success: false, error: "memory tool handler unavailable" }, 503);
    }
    let body: Record<string, unknown>;
    try {
      body = (await context.req.json()) as Record<string, unknown>;
    } catch {
      return context.json({ success: false, error: "invalid JSON body" }, 400);
    }
    const args: Record<string, unknown> = {
      proposal_id: proposalId,
      verdict: body.verdict,
      reason: body.reason ?? null,
      reviewer_identity: body.reviewer_identity
    };
    const result = await services.mcpMemoryToolHandler.call({
      toolName: "soul.review_memory_proposal",
      arguments: args,
      context: {
        workspaceId,
        runId: null,
        agentTarget: "inspector"
      }
    });
    if (!result.ok) {
      const status =
        result.error.code === "VALIDATION"
          ? 400
          : result.error.code === "NOT_FOUND"
            ? 404
            : 500;
      return context.json({ success: false, error: result.error }, status);
    }
    return context.json({ success: true, data: result.output }, 200);
  });
}
