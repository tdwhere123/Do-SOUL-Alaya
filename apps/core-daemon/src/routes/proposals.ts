import { randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import type { MemoryService, ProposalService, WorkspaceService } from "@do-soul/alaya-core";
import type { PathRelationProposalPayload } from "@do-soul/alaya-storage";
import {
  ControlPlaneObjectKind,
  MemoryGovernanceEventType,
  PathGovernanceClass,
  ProposalOptionKind,
  ProposalResolutionState,
  ProposalSchema,
  RetentionPolicy,
  SoulProposalCreatedPayloadSchema,
  type EventLogEntry,
  type Proposal
} from "@do-soul/alaya-protocol";
import type { McpMemoryToolHandler } from "../mcp-memory-tool-handler.js";

// invariant: governance_class promotion to strictly_governed is an
// auditable change (handbook invariants §3) and therefore must travel
// through the same Proposal lifecycle as memory mutations. The promote
// endpoint creates a pending Proposal with target_object_kind =
// "path_relation"; the underlying PathRelation row is not touched until
// the proposal is reviewed. The Proposal carries the requested
// governance_class in proposed_change_summary so the Inspector pending
// queue surfaces it without a downstream join.
// see also: packages/protocol/src/soul/path-relation.ts for PathGovernanceClass.

export type PromoteStrictlyGovernedProposalRepoPort = {
  createProposalWithEvents(
    input: {
      readonly proposal: Proposal;
      readonly workspace_id: string;
      readonly run_id: string | null;
      readonly target_object_kind: string;
      readonly proposed_change_summary?: string;
      readonly proposed_path_relation?: PathRelationProposalPayload | null;
      readonly created_at?: string;
    },
    events: ReadonlyArray<Omit<EventLogEntry, "event_id" | "created_at" | "revision">>
  ): Promise<Readonly<{
    readonly proposal: Readonly<Proposal>;
    readonly events: readonly EventLogEntry[];
  }>>;
};

export type PromoteStrictlyGovernedRuntimeNotifier = {
  notifyEntry(entry: EventLogEntry): void | Promise<void>;
};

export interface ProposalRouteServices {
  readonly workspaceService: WorkspaceService;
  readonly memoryService: Pick<MemoryService, "findByIdScoped">;
  readonly proposalService: ProposalService;
  readonly proposalRepo: PromoteStrictlyGovernedProposalRepoPort;
  readonly runtimeNotifier: PromoteStrictlyGovernedRuntimeNotifier;
  // invariant: the Inspector loopback uses these workspace-scoped HTTP
  // wrappers around the same MCP handler that attached agents call. The
  // wrappers exist on the daemon HTTP plane (not the agent control
  // plane): they are workspace-scoped at the URL level, so the removed
  // unscoped POST /proposals/:id/review route does not re-open. Per
  // invariant §21 (Inspector loopback only) the durable
  // promotion still routes through `proposalRepo.updatePendingResolutionWithEvents`
  // via the same MCP handler attached agents use; this HTTP wrapper does
  // not own the storage-atomic path.
  //
  // Production wiring always constructs the handler in
  // `apps/core-daemon/src/index.ts`; keep this required so a future wiring
  // drop fails at compile time instead of turning into a silent route 503.
  readonly mcpMemoryToolHandler: McpMemoryToolHandler;
}

// HTTP route surface for proposals:
//   GET  /workspaces/:wsId/proposals                    (list pending or all)
//   GET  /workspaces/:wsId/proposals/pending            (Inspector summary)
//   POST /workspaces/:wsId/proposals/:proposalId/review (Inspector accept/reject)
// The bare POST /proposals/:id/review and GET /proposals/:id are still
// removed: every endpoint here binds the workspace from the URL and
// delegates downstream services to enforce that scope.
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
    // Workspace is bound server-side from the McpMemoryToolCallContext
    // below; the request body no longer carries
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
        agentTarget: "inspector",
        sessionId: `inspector-${randomUUID()}`
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
      // JSON `null` / arrays / scalars all parse cleanly but would throw
      // on property access before the MCP handler can map validation to a
      // 400. Reject the boundary case explicitly at the HTTP boundary.
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
        agentTarget: "inspector",
        sessionId: `inspector-${randomUUID()}`
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

  app.post(
    "/workspaces/:wsId/soul/memory/:memoryId/proposals/promote-strictly-governed",
    async (context) => {
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
      const body = await readJsonObject(context);
      const reason =
        body !== null && typeof body.reason === "string" && body.reason.trim().length > 0
          ? body.reason.trim()
          : `Promote ${memoryId}: Inspector user requested PathRelation governance_class = strictly_governed.`;
      const proposalId = randomUUID();
      const timestamp = new Date().toISOString();
      const proposal = ProposalSchema.parse({
        runtime_id: proposalId,
        object_kind: ControlPlaneObjectKind.PROPOSAL,
        task_surface_ref: null,
        expires_at: null,
        derived_from: memoryId,
        retention_policy: RetentionPolicy.SESSION_ONLY,
        proposal_id: proposalId,
        dossier_ref: null,
        recommended_option_id: null,
        proposal_options: [
          {
            option_id: `promote_strictly_governed_${proposalId}`,
            option_kind: ProposalOptionKind.REQUEST_CONFIRMATION,
            preserves_protected_constraints: true,
            dropped_candidates: [],
            unresolved_after_apply: [],
            requires_confirmation: true
          }
        ],
        resolution_state: ProposalResolutionState.PENDING,
        last_updated_at: timestamp
      });
      const creationEvent: Omit<EventLogEntry, "event_id" | "created_at" | "revision"> = {
        event_type: MemoryGovernanceEventType.SOUL_PROPOSAL_CREATED,
        entity_type: "proposal",
        entity_id: proposal.proposal_id,
        workspace_id: workspaceId,
        run_id: null,
        caused_by: "inspector",
        payload_json: SoulProposalCreatedPayloadSchema.parse({
          object_id: proposal.runtime_id,
          object_kind: proposal.object_kind,
          workspace_id: workspaceId,
          run_id: null
        })
      };
      const summary = `${reason} Target PathRelation legitimacy.governance_class = ${PathGovernanceClass.STRICTLY_GOVERNED}.`;
      const created = await services.proposalRepo.createProposalWithEvents(
        {
          proposal,
          workspace_id: workspaceId,
          run_id: null,
          target_object_kind: "path_relation",
          proposed_change_summary: summary,
          proposed_path_relation: buildStrictlyGovernedPathRelationProposal(memoryId),
          created_at: timestamp
        },
        [creationEvent]
      );
      for (const event of created.events) {
        await services.runtimeNotifier.notifyEntry(event);
      }
      return context.json(
        {
          success: true,
          data: {
            proposal_id: created.proposal.proposal_id,
            status: "created",
            target_object_id: memoryId,
            target_object_kind: "path_relation",
            requested_governance_class: PathGovernanceClass.STRICTLY_GOVERNED
          }
        },
        200
      );
    }
  );

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
  // Second clicks of the same Inspector action button on the same memory
  // should not spam-create duplicate pending proposals. We
  // best-effort scan up to 100 pending proposals (the soul.list_pending_proposals
  // tool's max limit) and reuse an existing proposal whose target + proposed_changes
  // canonically match. Workspaces with >100 pending proposals may miss tail matches;
  // Inspector clicks are not a high-frequency path so this is acceptable. If the
  // miss rate becomes a problem, lift this lookup off the MCP tool and onto a
  // direct proposalRepo.findPendingSummaries call without the 100-row cap.
  const existing = await findExistingPendingMatch(services, {
    workspaceId: input.workspaceId,
    memoryId: input.memoryId,
    proposed_changes: input.proposed_changes
  });
  if (existing !== null) {
    return context.json(
      {
        success: true,
        data: { proposal_id: existing, status: "already_pending" }
      },
      200
    );
  }

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
      agentTarget: "inspector",
      sessionId: `inspector-${randomUUID()}`
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

function buildStrictlyGovernedPathRelationProposal(memoryId: string): PathRelationProposalPayload {
  return {
    target_anchor: {
      kind: "object_facet",
      object_id: memoryId,
      facet_key: "strictly_governed_constraint"
    },
    constitution: {
      relation_kind: "governance_constraint",
      why_this_relation_exists: ["operator requested strictly_governed governance promotion"]
    },
    effect_vector: {
      salience: 1,
      recall_bias: 1,
      verification_bias: 1,
      unfinishedness_bias: 0,
      default_manifestation_preference: "stance_bias"
    },
    plasticity_state: {
      strength: 1,
      direction_bias: "source_to_target",
      stability_class: "pinned",
      support_events_count: 1,
      contradiction_events_count: 0
    },
    lifecycle: {
      status: "active",
      retirement_rule: "manual"
    },
    legitimacy: {
      evidence_basis: ["inspector:promote-strictly-governed"],
      governance_class: PathGovernanceClass.STRICTLY_GOVERNED
    }
  };
}

async function findExistingPendingMatch(
  services: ProposalRouteServices,
  input: {
    readonly workspaceId: string;
    readonly memoryId: string;
    readonly proposed_changes: Record<string, unknown>;
  }
): Promise<string | null> {
  const result = await services.mcpMemoryToolHandler.call({
    toolName: "soul.list_pending_proposals",
    arguments: { limit: 100 },
    context: {
      workspaceId: input.workspaceId,
      runId: null,
      agentTarget: "inspector",
      sessionId: `inspector-${randomUUID()}`
    }
  });
  if (!result.ok) return null;
  const output = result.output as
    | {
        readonly proposals?: ReadonlyArray<{
          readonly proposal_id: string;
          readonly target_object_id: string;
          readonly proposed_changes: Record<string, unknown> | null;
        }>;
      }
    | null
    | undefined;
  const proposals = output?.proposals ?? [];
  if (proposals.length === 0) return null;
  const targetKey = canonicalizeChanges(input.proposed_changes);
  for (const proposal of proposals) {
    if (proposal.target_object_id !== input.memoryId) continue;
    if (proposal.proposed_changes === null) continue;
    if (canonicalizeChanges(proposal.proposed_changes) === targetKey) {
      return proposal.proposal_id;
    }
  }
  return null;
}

function canonicalizeChanges(value: Record<string, unknown>): string {
  const sortedKeys = Object.keys(value).sort();
  return JSON.stringify(sortedKeys.map((key) => [key, value[key]]));
}
