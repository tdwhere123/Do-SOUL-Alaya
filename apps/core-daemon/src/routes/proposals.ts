import type { Hono } from "hono";
import type { ProposalService, WorkspaceService } from "@do-soul/alaya-core";

export interface ProposalRouteServices {
  readonly workspaceService: WorkspaceService;
  readonly proposalService: ProposalService;
}

// HTTP route surface intentionally omits proposal review and per-id read.
// v0.1.0 release surface is MCP + CLI only (see CLAUDE.md "no GUI" invariant).
// Proposal review and read flow through:
//   - MCP: soul.review_proposal / soul.list_proposals (mcp-memory-tool-handler)
//   - CLI fallback: alaya tools call --json '{"name":"soul.review_proposal", ...}'
// Removed in p5-system-review-r1:
//   - POST /proposals/:id/review (MR-B01: non-atomic; no workspace scoping)
//   - GET /proposals/:id (MR-B02 sibling: no workspace scoping at route layer)
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
}
