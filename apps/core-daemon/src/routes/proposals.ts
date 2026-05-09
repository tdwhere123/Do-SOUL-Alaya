import type { Context, Hono } from "hono";
import type { MemoryService, ProposalService, WorkspaceService } from "@do-soul/alaya-core";
import type { McpMemoryToolHandler } from "../mcp-memory-tool-handler.js";

export interface ProposalRouteServices {
  readonly workspaceService: WorkspaceService;
  readonly memoryService: Pick<MemoryService, "findByIdScoped">;
  readonly proposalService: ProposalService;
  // A1 (HITL daemon backbone) — the Inspector loopback uses these
  // workspace-scoped HTTP wrappers around the same MCP handler that
  // attached agents call. The wrappers exist on the daemon HTTP plane
  // (not the agent control plane): they are workspace-scoped at the
  // URL level, so the prior `#BL-024` concern (non-atomic + no workspace
  // scoping in the removed POST /proposals/:id/review route) does not
  // re-open. Per invariant §21 (Inspector loopback only) the durable
  // promotion still routes through `proposalRepo.updatePendingResolutionWithEvents`
  // via the same MCP handler attached agents use; this HTTP wrapper does
  // not own the storage-atomic path.
  //
  // D2 MERGED-I7: required (not optional) — production wiring always
  // constructs the handler in `apps/core-daemon/src/index.ts`, so the
  // 503 fallback was dead code that masked any future wiring drop. If
  // a refactor accidentally drops the wiring, the type system now
  // catches it instead of letting the route 503 silently.
  readonly mcpMemoryToolHandler: McpMemoryToolHandler;
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
    const since = context.req.query("since") ?? undefined;
    const limitRaw = context.req.query("limit");
    const limit = limitRaw === undefined ? undefined : Number.parseInt(limitRaw, 10);
    // A1 fix-loop (finding-2): workspace is bound server-side from the
    // McpMemoryToolCallContext below; the request body no longer carries
    // workspace_id (mirrors soul.explore_graph).
    const args: Record<string, unknown> = {};
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
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = await context.req.json();
      // D2 MERGED-I4: JSON `null` / arrays / scalars all parse cleanly but
      // would throw a TypeError on property access (`body.verdict`)
      // before the existing `result.error.code === "VALIDATION"` mapping
      // can return a 400. Reject the boundary case explicitly so the
      // HTTP trust boundary returns 400 instead of leaking a 500.
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return context.json(
          { success: false, error: "invalid JSON body" },
          400
        );
      }
      body = parsed as Record<string, unknown>;
    } catch {
      return context.json({ success: false, error: "invalid JSON body" }, 400);
    }
    const args: Record<string, unknown> = {
      proposal_id: proposalId,
      verdict: body.verdict,
      reason: body.reason ?? null,
      reviewer_identity: body.reviewer_identity,
      reviewer_token: body.reviewer_token
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

  app.post("/workspaces/:wsId/soul/memory/:memoryId/proposals/keep", async (context) => {
    const workspaceId = context.req.param("wsId");
    const memoryId = context.req.param("memoryId");
    await services.workspaceService.getById(workspaceId);
    const memory = await services.memoryService.findByIdScoped(memoryId, workspaceId);
    if (memory === null) {
      return context.json(
        { success: false, error: { code: "NOT_FOUND", message: "Memory entry not found" } },
        404
      );
    }
    return await createMemoryActionProposal(context, services, {
      workspaceId,
      memoryId,
      proposed_changes: {
        confidence: clamp01((memory.confidence ?? 0.5) + 0.05)
      },
      reason: `Keep memory ${memoryId}: user confirmed this memory in Inspector.`
    });
  });

  app.post("/workspaces/:wsId/soul/memory/:memoryId/proposals/rewrite", async (context) => {
    const workspaceId = context.req.param("wsId");
    const memoryId = context.req.param("memoryId");
    await services.workspaceService.getById(workspaceId);
    if ((await services.memoryService.findByIdScoped(memoryId, workspaceId)) === null) {
      return context.json(
        { success: false, error: { code: "NOT_FOUND", message: "Memory entry not found" } },
        404
      );
    }
    const body = await readJsonObject(context);
    if (body === null) {
      return context.json({ success: false, error: "invalid JSON body" }, 400);
    }
    const newContent = typeof body.new_content === "string" ? body.new_content.trim() : "";
    if (newContent.length === 0) {
      return context.json({ success: false, error: "new_content is required" }, 400);
    }
    return await createMemoryActionProposal(context, services, {
      workspaceId,
      memoryId,
      proposed_changes: { content: newContent },
      reason: `Rewrite memory ${memoryId}: Inspector user requested a content update.`
    });
  });

  app.post("/workspaces/:wsId/soul/memory/:memoryId/proposals/downgrade", async (context) => {
    const workspaceId = context.req.param("wsId");
    const memoryId = context.req.param("memoryId");
    await services.workspaceService.getById(workspaceId);
    const memory = await services.memoryService.findByIdScoped(memoryId, workspaceId);
    if (memory === null) {
      return context.json(
        { success: false, error: { code: "NOT_FOUND", message: "Memory entry not found" } },
        404
      );
    }
    return await createMemoryActionProposal(context, services, {
      workspaceId,
      memoryId,
      proposed_changes: {
        confidence: clamp01((memory.confidence ?? 0.5) - 0.2)
      },
      reason: `Downgrade memory ${memoryId}: Inspector user requested weaker trust.`
    });
  });

  app.post("/workspaces/:wsId/soul/memory/:memoryId/proposals/retire", async (context) => {
    const workspaceId = context.req.param("wsId");
    const memoryId = context.req.param("memoryId");
    await services.workspaceService.getById(workspaceId);
    const memory = await services.memoryService.findByIdScoped(memoryId, workspaceId);
    if (memory === null) {
      return context.json(
        { success: false, error: { code: "NOT_FOUND", message: "Memory entry not found" } },
        404
      );
    }
    return await createMemoryActionProposal(context, services, {
      workspaceId,
      memoryId,
      proposed_changes: {
        retention_state: "tombstoned",
        storage_tier: "cold"
      },
      reason: `Retire memory ${memoryId}: Inspector user requested soft deletion.`
    });
  });
}

async function createMemoryActionProposal(
  context: Context,
  services: ProposalRouteServices,
  input: {
    readonly workspaceId: string;
    readonly memoryId: string;
    readonly proposed_changes: Record<string, unknown>;
    readonly reason: string;
  }
): Promise<Response> {
  const result = await services.mcpMemoryToolHandler.call({
    toolName: "soul.propose_memory_update",
    arguments: {
      target_object_id: input.memoryId,
      proposed_changes: input.proposed_changes,
      reason: input.reason
    },
    context: {
      workspaceId: input.workspaceId,
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
          : result.error.code === "NEEDS_CONTEXT"
            ? 503
            : 500;
    return context.json({ success: false, error: result.error }, status);
  }
  return context.json({ success: true, data: result.output }, 200);
}

async function readJsonObject(context: Context): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await context.req.json();
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return Number(value.toFixed(6));
}
