import type { Context, Hono } from "hono";
import type { ProposalRouteServices } from "./proposals-types.js";
import { createHttpReviewerToolContext, findExistingPendingMatch } from "./proposals-pending-match.js";
import { clamp01, parsePendingListLimit, parseProposalListState } from "./proposals-request-helpers.js";
import {
  jsonError,
  mcpToolErrorStatus,
  parseListPagination,
  readJsonObject,
  rejectUnexpectedRequestBody,
  resolveListAndCount,
  writeListPaginationHeaders
} from "../../shared/shared.js";
import { boundedPathParams, readBoundedPathParam } from "../../../middleware/bounded-path-params.js";
export type { ProposalRouteServices } from "./proposals-types.js";

// HTTP reviewer memory actions originate proposals; their guarded review owns durable effects.
// HTTP route surface:
//   GET  /workspaces/:wsId/proposals                    (list pending or all)
//   GET  /workspaces/:wsId/proposals/pending            (HTTP reviewer summary)
//   POST /workspaces/:wsId/proposals/:proposalId/review (HTTP reviewer accept/reject)
// The bare POST /proposals/:id/review and GET /proposals/:id are still
// removed: every endpoint here binds the workspace from the URL and
// delegates downstream services to enforce that scope.
export function registerProposalRoutes(app: Hono, services: ProposalRouteServices): void {
  const memoryActionLocks = new Map<string, Promise<void>>();
  registerProposalListRoutes(app, services);
  registerProposalReviewRoutes(app, services);
  registerMemoryActionProposalRoutes(app, services, memoryActionLocks);
}

function registerProposalListRoutes(app: Hono, services: ProposalRouteServices): void {
  app.get("/workspaces/:wsId/proposals", boundedPathParams("wsId"), async (context) => {
    const workspaceId = readBoundedPathParam(context, "wsId");
    await services.workspaceService.getById(workspaceId);

    const state = parseProposalListState(context.req.query("state"));
    const pagination = parseListPagination(context);
    const [proposals, totalCount] = state === "all"
      ? await resolveListAndCount(
          services.proposalService.findByWorkspaceId(workspaceId, pagination),
          services.proposalService.countByWorkspaceId(workspaceId)
        )
      : await resolveListAndCount(
          services.proposalService.findPending(workspaceId, pagination),
          services.proposalService.countPending(workspaceId)
        );
    writeListPaginationHeaders(context, totalCount, pagination);

    return context.json({ success: true, data: proposals }, 200);
  });

  app.get("/workspaces/:wsId/proposals/pending", boundedPathParams("wsId"), async (context) => {
    const workspaceId = readBoundedPathParam(context, "wsId");
    await services.workspaceService.getById(workspaceId);
    const since = context.req.query("since") ?? undefined;
    const limit = parsePendingListLimit(context.req.query("limit"));
    // Workspace is bound server-side from the McpMemoryToolCallContext
    // below; the request body no longer carries
    // workspace_id (mirrors soul.explore_graph).
    const args: Record<string, unknown> = {};
    if (since !== undefined) args.since = since;
    if (limit !== undefined) args.limit = limit;

    const result = await services.mcpMemoryToolHandler.call({
      toolName: "soul.list_pending_proposals",
      arguments: args,
      context: createHttpReviewerToolContext(workspaceId)
    });
    if (!result.ok) {
      return jsonError(context, mcpToolErrorStatus(result.error.code), result.error);
    }
    return context.json({ success: true, data: result.output }, 200);
  });
}

function registerProposalReviewRoutes(app: Hono, services: ProposalRouteServices): void {
  app.post("/workspaces/:wsId/proposals/:proposalId/review", boundedPathParams("wsId", "proposalId"), async (context) => {
    return await reviewProposal(context, services);
  });
}

type MemoryActionLocks = Map<string, Promise<void>>;

function registerMemoryActionProposalRoutes(
  app: Hono,
  services: ProposalRouteServices,
  memoryActionLocks: MemoryActionLocks
): void {
  app.post("/workspaces/:wsId/soul/memory/:memoryId/proposals/keep", boundedPathParams("wsId", "memoryId"), (context) => keepMemoryProposal(context, services, memoryActionLocks));
  app.post("/workspaces/:wsId/soul/memory/:memoryId/proposals/rewrite", boundedPathParams("wsId", "memoryId"), (context) => rewriteMemoryProposal(context, services, memoryActionLocks));
  app.post("/workspaces/:wsId/soul/memory/:memoryId/proposals/downgrade", boundedPathParams("wsId", "memoryId"), (context) => downgradeMemoryProposal(context, services, memoryActionLocks));

  app.post("/workspaces/:wsId/soul/memory/:memoryId/proposals/retire", boundedPathParams("wsId", "memoryId"), (context) => retireMemoryProposal(context, services, memoryActionLocks));
}

async function keepMemoryProposal(
  context: Context,
  services: ProposalRouteServices,
  memoryActionLocks: MemoryActionLocks
): Promise<Response> {
  const prepared = await prepareExistingMemoryAction(context, services, { rejectBody: true });
  if (prepared instanceof Response) return prepared;
  return await createMemoryActionProposal(context, services, memoryActionLocks, {
    workspaceId: prepared.workspaceId,
    memoryId: prepared.memoryId,
    proposed_changes: { confidence: clamp01((prepared.memory.confidence ?? 0.5) + 0.05) },
    reason: `Keep memory ${prepared.memoryId}: confirmed via HTTP reviewer.`
  });
}

async function rewriteMemoryProposal(
  context: Context,
  services: ProposalRouteServices,
  memoryActionLocks: MemoryActionLocks
): Promise<Response> {
  const prepared = await prepareExistingMemoryAction(context, services, { rejectBody: false });
  if (prepared instanceof Response) return prepared;
  const body = await readJsonObject(context);
  if (body === null) return jsonError(context, 400, "invalid JSON body");
  const newContent = typeof body.new_content === "string" ? body.new_content.trim() : "";
  if (newContent.length === 0) return jsonError(context, 400, "new_content is required");
  return await createMemoryActionProposal(context, services, memoryActionLocks, {
    workspaceId: prepared.workspaceId,
    memoryId: prepared.memoryId,
    proposed_changes: { content: newContent },
    reason: `Rewrite memory ${prepared.memoryId}: HTTP reviewer requested a content update.`
  });
}

async function downgradeMemoryProposal(
  context: Context,
  services: ProposalRouteServices,
  memoryActionLocks: MemoryActionLocks
): Promise<Response> {
  const prepared = await prepareExistingMemoryAction(context, services, { rejectBody: true });
  if (prepared instanceof Response) return prepared;
  return await createMemoryActionProposal(context, services, memoryActionLocks, {
    workspaceId: prepared.workspaceId,
    memoryId: prepared.memoryId,
    proposed_changes: { confidence: clamp01((prepared.memory.confidence ?? 0.5) - 0.2) },
    reason: `Downgrade memory ${prepared.memoryId}: HTTP reviewer requested weaker trust.`
  });
}

async function retireMemoryProposal(
  context: Context,
  services: ProposalRouteServices,
  memoryActionLocks: MemoryActionLocks
): Promise<Response> {
  const prepared = await prepareExistingMemoryAction(context, services, { rejectBody: true });
  if (prepared instanceof Response) return prepared;
  return await createMemoryActionProposal(context, services, memoryActionLocks, {
    workspaceId: prepared.workspaceId,
    memoryId: prepared.memoryId,
    proposed_changes: { retention_state: "tombstoned", storage_tier: "cold" },
    reason: `Retire memory ${prepared.memoryId}: HTTP reviewer requested soft deletion.`
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
  const workspaceId = readBoundedPathParam(context, "wsId");
  const memoryId = readBoundedPathParam(context, "memoryId");
  await services.workspaceService.getById(workspaceId);
  const memory = await services.memoryService.findByIdScoped(memoryId, workspaceId);
  if (memory === null) return memoryNotFound(context);
  return { workspaceId, memoryId, memory };
}

function memoryNotFound(context: Context): Response {
  return jsonError(context, 404, { code: "NOT_FOUND", message: "Memory entry not found" });
}

async function reviewProposal(context: Context, services: ProposalRouteServices): Promise<Response> {
  const workspaceId = readBoundedPathParam(context, "wsId");
  const proposalId = readBoundedPathParam(context, "proposalId");
  await services.workspaceService.getById(workspaceId);
  const body = await readJsonObject(context);
  if (body === null) return jsonError(context, 400, "invalid JSON body");
  const result = await services.mcpMemoryToolHandler.call({
    toolName: "soul.review_memory_proposal",
    arguments: buildReviewProposalArgs(proposalId, body),
    context: createHttpReviewerToolContext(workspaceId)
  });
  if (!result.ok) {
    return jsonError(context, mcpToolErrorStatus(result.error.code), result.error);
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

async function createMemoryActionProposal(
  context: Context,
  services: ProposalRouteServices,
  memoryActionLocks: MemoryActionLocks,
  input: {
    readonly workspaceId: string;
    readonly memoryId: string;
    readonly proposed_changes: Record<string, unknown>;
    readonly reason: string;
  }
): Promise<Response> {
  return await withMemoryActionLock(
    memoryActionLocks,
    input.workspaceId,
    input.memoryId,
    async () => {
      const existingProposalId = await findExistingPendingMatch(services, {
        workspaceId: input.workspaceId,
        memoryId: input.memoryId,
        proposed_changes: input.proposed_changes
      });
      if (existingProposalId !== null) {
        return alreadyPendingProposal(context, existingProposalId);
      }
      const result = await callMemoryUpdateProposalTool(services, input);
      if (!result.ok) {
        return jsonError(context, mcpToolErrorStatus(result.error.code), result.error);
      }
      return context.json({ success: true, data: result.output }, 200);
    }
  );
}

async function withMemoryActionLock<T>(
  locks: MemoryActionLocks,
  workspaceId: string,
  memoryId: string,
  action: () => Promise<T>
): Promise<T> {
  const key = `${workspaceId}\0${memoryId}`;
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => current);
  locks.set(key, chained);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (locks.get(key) === chained) {
      locks.delete(key);
    }
  }
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
    context: createHttpReviewerToolContext(input.workspaceId)
  });
}
