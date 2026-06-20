import { randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
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
import type { ProposalRouteServices } from "./proposals-types.js";
import {
  isRequestBodyTooLargeError,
  parseListPagination,
  rejectUnexpectedRequestBody,
  throwInvalidRequestBody,
  writeListPaginationHeaders
} from "./shared.js";
export type {
  PromoteStrictlyGovernedProposalRepoPort,
  PromoteStrictlyGovernedRuntimeNotifier,
  ProposalRouteServices
} from "./proposals-types.js";

// Governance-class promotion stays auditable through a pending path_relation Proposal; PathRelation changes wait for review.
// HTTP route surface:
//   GET  /workspaces/:wsId/proposals                    (list pending or all)
//   GET  /workspaces/:wsId/proposals/pending            (Inspector summary)
//   POST /workspaces/:wsId/proposals/:proposalId/review (Inspector accept/reject)
// The bare POST /proposals/:id/review and GET /proposals/:id are still
// removed: every endpoint here binds the workspace from the URL and
// delegates downstream services to enforce that scope.
export function registerProposalRoutes(app: Hono, services: ProposalRouteServices): void {
  registerProposalListRoutes(app, services);
  registerProposalReviewRoutes(app, services);
  registerMemoryActionProposalRoutes(app, services);
}

function registerProposalListRoutes(app: Hono, services: ProposalRouteServices): void {
  app.get("/workspaces/:wsId/proposals", async (context) => {
    const workspaceId = context.req.param("wsId");
    await services.workspaceService.getById(workspaceId);

    const state = context.req.query("state");
    const pagination = parseListPagination(context);
    const proposals =
      state === "all"
        ? await services.proposalService.findByWorkspaceId(workspaceId, pagination)
        : await services.proposalService.findPending(workspaceId, pagination);
    const totalCount =
      state === "all"
        ? await services.proposalService.countByWorkspaceId(workspaceId)
        : await services.proposalService.countPending(workspaceId);
    writeListPaginationHeaders(context, totalCount, pagination);

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
}

function registerProposalReviewRoutes(app: Hono, services: ProposalRouteServices): void {
  app.post("/workspaces/:wsId/proposals/:proposalId/review", async (context) => {
    return await reviewProposal(context, services);
  });
}

function registerMemoryActionProposalRoutes(app: Hono, services: ProposalRouteServices): void {
  app.post("/workspaces/:wsId/soul/memory/:memoryId/proposals/keep", (context) => keepMemoryProposal(context, services));
  app.post("/workspaces/:wsId/soul/memory/:memoryId/proposals/rewrite", (context) => rewriteMemoryProposal(context, services));
  app.post("/workspaces/:wsId/soul/memory/:memoryId/proposals/downgrade", (context) => downgradeMemoryProposal(context, services));

  app.post(
    "/workspaces/:wsId/soul/memory/:memoryId/proposals/promote-strictly-governed",
    (context) => promoteStrictlyGovernedProposal(context, services)
  );

  app.post("/workspaces/:wsId/soul/memory/:memoryId/proposals/retire", (context) => retireMemoryProposal(context, services));
}

async function keepMemoryProposal(context: Context, services: ProposalRouteServices): Promise<Response> {
  const prepared = await prepareExistingMemoryAction(context, services, { rejectBody: true });
  if (prepared instanceof Response) return prepared;
  return await createMemoryActionProposal(context, services, {
    workspaceId: prepared.workspaceId,
    memoryId: prepared.memoryId,
    proposed_changes: { confidence: clamp01((prepared.memory.confidence ?? 0.5) + 0.05) },
    reason: `Keep memory ${prepared.memoryId}: user confirmed this memory in Inspector.`
  });
}

async function rewriteMemoryProposal(context: Context, services: ProposalRouteServices): Promise<Response> {
  const prepared = await prepareExistingMemoryAction(context, services, { rejectBody: false });
  if (prepared instanceof Response) return prepared;
  const body = await readJsonObject(context);
  if (body === null) return context.json({ success: false, error: "invalid JSON body" }, 400);
  const newContent = typeof body.new_content === "string" ? body.new_content.trim() : "";
  if (newContent.length === 0) return context.json({ success: false, error: "new_content is required" }, 400);
  return await createMemoryActionProposal(context, services, {
    workspaceId: prepared.workspaceId,
    memoryId: prepared.memoryId,
    proposed_changes: { content: newContent },
    reason: `Rewrite memory ${prepared.memoryId}: Inspector user requested a content update.`
  });
}

async function downgradeMemoryProposal(context: Context, services: ProposalRouteServices): Promise<Response> {
  const prepared = await prepareExistingMemoryAction(context, services, { rejectBody: true });
  if (prepared instanceof Response) return prepared;
  return await createMemoryActionProposal(context, services, {
    workspaceId: prepared.workspaceId,
    memoryId: prepared.memoryId,
    proposed_changes: { confidence: clamp01((prepared.memory.confidence ?? 0.5) - 0.2) },
    reason: `Downgrade memory ${prepared.memoryId}: Inspector user requested weaker trust.`
  });
}

async function retireMemoryProposal(context: Context, services: ProposalRouteServices): Promise<Response> {
  const prepared = await prepareExistingMemoryAction(context, services, { rejectBody: true });
  if (prepared instanceof Response) return prepared;
  return await createMemoryActionProposal(context, services, {
    workspaceId: prepared.workspaceId,
    memoryId: prepared.memoryId,
    proposed_changes: { retention_state: "tombstoned", storage_tier: "cold" },
    reason: `Retire memory ${prepared.memoryId}: Inspector user requested soft deletion.`
  });
}

async function prepareExistingMemoryAction(
  context: Context,
  services: ProposalRouteServices,
  options: { readonly rejectBody: boolean }
) {
  if (options.rejectBody) {
    const unexpectedBody = await rejectUnexpectedRequestBody(context);
    if (unexpectedBody !== null) return unexpectedBody;
  }
  const workspaceId = context.req.param("wsId")!;
  const memoryId = context.req.param("memoryId")!;
  await services.workspaceService.getById(workspaceId);
  const memory = await services.memoryService.findByIdScoped(memoryId, workspaceId);
  if (memory === null) return memoryNotFound(context);
  return { workspaceId, memoryId, memory };
}

function memoryNotFound(context: Context): Response {
  return context.json({ success: false, error: { code: "NOT_FOUND", message: "Memory entry not found" } }, 404);
}

async function reviewProposal(context: Context, services: ProposalRouteServices): Promise<Response> {
  const workspaceId = context.req.param("wsId")!;
  const proposalId = context.req.param("proposalId")!;
  await services.workspaceService.getById(workspaceId);
  const body = await readJsonObject(context);
  if (body === null) return context.json({ success: false, error: "invalid JSON body" }, 400);
  const result = await services.mcpMemoryToolHandler.call({
    toolName: "soul.review_memory_proposal",
    arguments: buildReviewProposalArgs(proposalId, body),
    context: createInspectorToolContext(workspaceId)
  });
  if (!result.ok) {
    return context.json({ success: false, error: result.error }, proposalReviewErrorStatus(result.error.code));
  }
  return context.json({ success: true, data: result.output }, 200);
}

function buildReviewProposalArgs(proposalId: string, body: Record<string, unknown>): Record<string, unknown> {
  return {
    proposal_id: proposalId,
    verdict: body.verdict,
    reason: body.reason ?? null,
    reviewer_identity: body.reviewer_identity,
    reviewer_token: body.reviewer_token
  };
}

function proposalReviewErrorStatus(code: string): 400 | 404 | 500 {
  if (code === "VALIDATION") return 400;
  if (code === "NOT_FOUND") return 404;
  return 500;
}

async function promoteStrictlyGovernedProposal(
  context: Context,
  services: ProposalRouteServices
): Promise<Response> {
  const workspaceId = context.req.param("wsId")!;
  const memoryId = context.req.param("memoryId")!;
  await services.workspaceService.getById(workspaceId);
  const missing = await rejectMissingMemory(context, services, memoryId, workspaceId);
  if (missing !== null) return missing;
  const reason = await readPromotionReason(context, memoryId);
  const created = await createStrictlyGovernedProposal(services, { workspaceId, memoryId, reason });
  for (const event of created.events) await services.runtimeNotifier.notifyEntry(event);
  return context.json({ success: true, data: strictGovernanceResponse(created.proposal.proposal_id, memoryId) }, 200);
}

async function rejectMissingMemory(
  context: Context,
  services: ProposalRouteServices,
  memoryId: string,
  workspaceId: string
): Promise<Response | null> {
  const memory = await services.memoryService.findByIdScoped(memoryId, workspaceId);
  if (memory !== null) return null;
  return context.json(
    { success: false, error: { code: "NOT_FOUND", message: "Memory entry not found" } },
    404
  );
}

async function readPromotionReason(context: Context, memoryId: string): Promise<string> {
  const body = await readJsonObject(context);
  if (body !== null && typeof body.reason === "string" && body.reason.trim().length > 0) {
    return body.reason.trim();
  }
  return `Promote ${memoryId}: Inspector user requested PathRelation governance_class = strictly_governed.`;
}

async function createStrictlyGovernedProposal(
  services: ProposalRouteServices,
  input: { readonly workspaceId: string; readonly memoryId: string; readonly reason: string }
) {
  const proposalId = randomUUID();
  const timestamp = new Date().toISOString();
  const proposal = buildStrictlyGovernedProposal(input.memoryId, proposalId, timestamp);
  const summary = `${input.reason} Target PathRelation legitimacy.governance_class = ${PathGovernanceClass.STRICTLY_GOVERNED}.`;
  return await services.proposalRepo.createProposalWithEvents(
    {
      proposal,
      workspace_id: input.workspaceId,
      run_id: null,
      target_object_kind: "path_relation",
      proposed_change_summary: summary,
      proposed_path_relation: buildStrictlyGovernedPathRelationProposal(input.memoryId),
      created_at: timestamp
    },
    [buildProposalCreatedEvent(proposal, input.workspaceId)]
  );
}

function buildStrictlyGovernedProposal(memoryId: string, proposalId: string, timestamp: string): Proposal {
  return ProposalSchema.parse({
    runtime_id: proposalId,
    object_kind: ControlPlaneObjectKind.PROPOSAL,
    task_surface_ref: null,
    expires_at: null,
    derived_from: memoryId,
    retention_policy: RetentionPolicy.SESSION_ONLY,
    proposal_id: proposalId,
    dossier_ref: null,
    recommended_option_id: null,
    proposal_options: [buildStrictlyGovernedProposalOption(proposalId)],
    resolution_state: ProposalResolutionState.PENDING,
    last_updated_at: timestamp
  });
}

function buildStrictlyGovernedProposalOption(proposalId: string) {
  return {
    option_id: `promote_strictly_governed_${proposalId}`,
    option_kind: ProposalOptionKind.REQUEST_CONFIRMATION,
    preserves_protected_constraints: true,
    dropped_candidates: [], unresolved_after_apply: [],
    requires_confirmation: true
  };
}

function buildProposalCreatedEvent(
  proposal: Proposal,
  workspaceId: string
): Omit<EventLogEntry, "event_id" | "created_at" | "revision"> {
  return {
    event_type: MemoryGovernanceEventType.SOUL_PROPOSAL_CREATED,
    entity_type: "proposal",
    entity_id: proposal.proposal_id,
    workspace_id: workspaceId,
    run_id: null,
    caused_by: "inspector",
    payload_json: SoulProposalCreatedPayloadSchema.parse({
      object_id: proposal.runtime_id, object_kind: proposal.object_kind, workspace_id: workspaceId, run_id: null
    })
  };
}

function strictGovernanceResponse(proposalId: string, memoryId: string) {
  return {
    proposal_id: proposalId,
    status: "created",
    target_object_id: memoryId,
    target_object_kind: "path_relation",
    requested_governance_class: PathGovernanceClass.STRICTLY_GOVERNED
  };
}

function createInspectorToolContext(workspaceId: string) {
  return { workspaceId, runId: null, agentTarget: "inspector", sessionId: `inspector-${randomUUID()}` };
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
  const existing = await findExistingMemoryActionProposal(services, input);
  if (existing !== null) return alreadyPendingProposal(context, existing);
  const result = await callMemoryUpdateProposalTool(services, input);
  if (!result.ok) return context.json({ success: false, error: result.error }, memoryActionErrorStatus(result.error.code));
  return context.json({ success: true, data: result.output }, 200);
}

async function findExistingMemoryActionProposal(
  services: ProposalRouteServices,
  input: { readonly workspaceId: string; readonly memoryId: string; readonly proposed_changes: Record<string, unknown> }
): Promise<string | null> {
  return await findExistingPendingMatch(services, {
    workspaceId: input.workspaceId,
    memoryId: input.memoryId,
    proposed_changes: input.proposed_changes
  });
}

function alreadyPendingProposal(context: Context, proposalId: string): Response {
  return context.json({ success: true, data: { proposal_id: proposalId, status: "already_pending" } }, 200);
}

async function callMemoryUpdateProposalTool(
  services: ProposalRouteServices,
  input: {
    readonly workspaceId: string;
    readonly memoryId: string;
    readonly proposed_changes: Record<string, unknown>;
    readonly reason: string;
  }
) {
  return await services.mcpMemoryToolHandler.call({
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
}

function memoryActionErrorStatus(code: string): 400 | 404 | 500 | 503 {
  if (code === "VALIDATION") return 400;
  if (code === "NOT_FOUND") return 404;
  if (code === "NEEDS_CONTEXT") return 503;
  return 500;
}

async function readJsonObject(context: Context): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await context.req.json();
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (isRequestBodyTooLargeError(error)) {
      throwInvalidRequestBody(error);
    }
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
