import {
  ALAYA_SYSEXITS,
  type AlayaCliContext,
  type AlayaCliResult,
  type AlayaSubcommandSpec
} from "./bridge.js";
import type { McpMemoryToolCallContext } from "../mcp-memory/tool-handler.js";

// A1 (HITL daemon backbone) — `alaya review` is a CLI fallback for the
// same MCP handler attached agents use. Each verb routes through the
// MemoryToolHandler so behavior, validation, and audit trails stay
// identical between Codex/Claude attach and a human at a terminal. This
// follows the `alaya tools list | tools call` precedent in
// apps/core-daemon/src/cli/tools.ts.

import {
  buildCallContext,
  buildEdgeFilterArguments,
  formatCell,
  formatJsonCell,
  formatOverdue,
  resolveReviewIdentity,
  reviewArgsSchema,
  type ReviewArgs,
  type ReviewCommandDependencies
} from "./review-support.js";
export type { ReviewArgs, ReviewCommandDependencies } from "./review-support.js";

export function createReviewCommand(deps: ReviewCommandDependencies): AlayaSubcommandSpec<ReviewArgs> {
  return {
    name: "review",
    description:
      "Review pending memory or edge proposals. Subactions: pending | accept <proposal-id> | reject <proposal-id>; edge review uses review edges pending|accept|reject.",
    argsSchema: reviewArgsSchema(),
    requiresDaemonReady: false,
    handler: async (ctx, args) => await executeReviewCommand(ctx, args, deps)
  };
}

async function executeReviewCommand(
  ctx: AlayaCliContext,
  args: ReviewArgs,
  deps: ReviewCommandDependencies
): Promise<AlayaCliResult> {
  if (args.target === "edges") {
    if (args.action === "pending") {
      return await runEdgePending(ctx, args, deps);
    }
    return await runEdgeReview(ctx, args, deps);
  }
  if (args.action === "pending") {
    return await runPending(ctx, args, deps);
  }
  return await runReview(ctx, args, deps);
}

async function runPending(
  ctx: AlayaCliContext,
  args: ReviewArgs,
  deps: ReviewCommandDependencies
): Promise<AlayaCliResult> {
  const callContext = await resolveReviewCallContext(ctx, args, deps);
  if ("exitCode" in callContext) {
    return callContext;
  }
  const result = await deps.handler.call({
    toolName: "soul.list_pending_proposals",
    arguments: buildPendingProposalArguments(args),
    context: callContext
  });
  return renderPendingReviewResult(ctx, result);
}
async function runEdgePending(
  ctx: AlayaCliContext,
  args: ReviewArgs,
  deps: ReviewCommandDependencies
): Promise<AlayaCliResult> {
  const callContextResult = await buildCallContext(ctx, args, deps);
  if (!callContextResult.ok) {
    ctx.stderr.write(`${callContextResult.message}\n`);
    return { exitCode: ALAYA_SYSEXITS.DATAERR };
  }
  const requestArgs = buildEdgeFilterArguments(args, { includeProposalIds: false });
  const result = await deps.handler.call({
    toolName: "soul.list_pending_edge_proposals",
    arguments: requestArgs,
    context: callContextResult.context
  });

  if (!result.ok) {
    ctx.stderr.write(`${result.error.code}: ${result.error.message}\n`);
    return {
      exitCode:
        result.error.code === "VALIDATION" || result.error.code === "UNKNOWN_TOOL"
          ? ALAYA_SYSEXITS.DATAERR
          : ALAYA_SYSEXITS.SOFTWARE,
      json: result
    };
  }

  if (ctx.jsonRequested !== true) {
    const summaries = (result.output as { proposals?: readonly Record<string, unknown>[] }).proposals;
    if (summaries === undefined || summaries.length === 0) {
      ctx.stdout.write("(no pending edge proposals)\n");
    } else {
      ctx.stdout.write(
        "proposal_id\tsource_memory_id\ttarget_memory_id\tedge_type\ttrigger_source\tconfidence\tcreated_at\treason\n"
      );
      for (const summary of summaries) {
        ctx.stdout.write(
          `${formatCell(summary.proposal_id)}\t${formatCell(summary.source_memory_id)}\t${formatCell(summary.target_memory_id)}\t${formatCell(summary.edge_type)}\t${formatCell(summary.trigger_source)}\t${formatCell(summary.confidence)}\t${formatCell(summary.created_at)}\t${formatCell(summary.reason)}\n`
        );
      }
    }
  }
  return {
    exitCode: ALAYA_SYSEXITS.OK,
    json: result.output
  };
}

async function runEdgeReview(
  ctx: AlayaCliContext,
  args: ReviewArgs,
  deps: ReviewCommandDependencies
): Promise<AlayaCliResult> {
  const callContextResult = await buildCallContext(ctx, args, deps);
  if (!callContextResult.ok) {
    ctx.stderr.write(`${callContextResult.message}\n`);
    return { exitCode: ALAYA_SYSEXITS.DATAERR };
  }
  const reviewer = resolveReviewIdentity(ctx, args, deps);
  if (!reviewer.ok) {
    ctx.stderr.write(`${reviewer.message}\n`);
    return { exitCode: ALAYA_SYSEXITS.USAGE };
  }
  const reviewArguments: Record<string, unknown> = {
    verdict: args.action === "accept" ? "accept" : "reject",
    filter: buildEdgeFilterArguments(args, { includeProposalIds: true }),
    reason: args.reason,
    reviewer_identity: reviewer.identity
  };
  if (reviewer.token !== null) {
    reviewArguments.reviewer_token = reviewer.token;
  }

  const result = await deps.handler.call({
    toolName: "soul.batch_review_edge_proposals",
    arguments: reviewArguments,
    context: callContextResult.context
  });

  if (!result.ok) {
    ctx.stderr.write(`${result.error.code}: ${result.error.message}\n`);
    return {
      exitCode:
        result.error.code === "VALIDATION" || result.error.code === "UNKNOWN_TOOL"
          ? ALAYA_SYSEXITS.DATAERR
          : ALAYA_SYSEXITS.SOFTWARE,
      json: result
    };
  }

  if (ctx.jsonRequested !== true) {
    ctx.stdout.write(`${JSON.stringify(result.output)} durable_apply=edge-review\n`);
  }
  return {
    exitCode: ALAYA_SYSEXITS.OK,
    json: result.output
  };
}

async function runReview(
  ctx: AlayaCliContext,
  args: ReviewArgs,
  deps: ReviewCommandDependencies
): Promise<AlayaCliResult> {
  if (args.proposalId === null) {
    ctx.stderr.write(`review ${args.action} requires a proposal id\n`);
    return { exitCode: ALAYA_SYSEXITS.USAGE };
  }

  const callContext = await resolveReviewCallContext(ctx, args, deps);
  if ("exitCode" in callContext) {
    return callContext;
  }
  const reviewer = resolveReviewIdentity(ctx, args, deps);
  if (!reviewer.ok) {
    ctx.stderr.write(`${reviewer.message}\n`);
    return { exitCode: ALAYA_SYSEXITS.USAGE };
  }
  const result = await deps.handler.call({
    toolName: "soul.review_memory_proposal",
    arguments: buildMemoryProposalReviewArguments(args, reviewer),
    context: callContext
  });
  return renderReviewMutationResult(ctx, result);
}

async function resolveReviewCallContext(
  ctx: AlayaCliContext,
  args: ReviewArgs,
  deps: ReviewCommandDependencies
): Promise<McpMemoryToolCallContext | AlayaCliResult> {
  const callContextResult = await buildCallContext(ctx, args, deps);
  if (callContextResult.ok) {
    return callContextResult.context;
  }
  ctx.stderr.write(`${callContextResult.message}\n`);
  return { exitCode: ALAYA_SYSEXITS.DATAERR };
}

function buildPendingProposalArguments(args: ReviewArgs): Record<string, unknown> {
  const requestArgs: Record<string, unknown> = {};
  if (args.since !== null) {
    requestArgs.since = args.since;
  }
  if (args.limit !== null) {
    requestArgs.limit = args.limit;
  }
  return requestArgs;
}

function renderPendingReviewResult(
  ctx: AlayaCliContext,
  result: Awaited<ReturnType<ReviewCommandDependencies["handler"]["call"]>>
): AlayaCliResult {
  if (!result.ok) {
    return renderReviewToolFailure(ctx, result);
  }
  if (ctx.jsonRequested !== true) {
    writePendingReviewTable(ctx, result.output as { proposals?: readonly Record<string, unknown>[] });
  }
  return { exitCode: ALAYA_SYSEXITS.OK, json: result.output };
}

function renderReviewMutationResult(
  ctx: AlayaCliContext,
  result: Awaited<ReturnType<ReviewCommandDependencies["handler"]["call"]>>
): AlayaCliResult {
  if (!result.ok) {
    return renderReviewToolFailure(ctx, result);
  }
  if (ctx.jsonRequested !== true) {
    const output = result.output as { resolution_state?: string; proposal_id?: string };
    const durableApplyState =
      output.resolution_state === "accepted" ? "durable_apply=applied" : "durable_apply=not-requested";
    ctx.stdout.write(`${JSON.stringify(result.output)} ${durableApplyState}\n`);
  }
  return { exitCode: ALAYA_SYSEXITS.OK, json: result.output };
}

function renderReviewToolFailure(
  ctx: AlayaCliContext,
  result: Exclude<Awaited<ReturnType<ReviewCommandDependencies["handler"]["call"]>>, { ok: true }>
): AlayaCliResult {
  ctx.stderr.write(`${result.error.code}: ${result.error.message}\n`);
  return {
    exitCode:
      result.error.code === "VALIDATION" || result.error.code === "UNKNOWN_TOOL"
        ? ALAYA_SYSEXITS.DATAERR
        : ALAYA_SYSEXITS.SOFTWARE,
    json: result
  };
}

function writePendingReviewTable(
  ctx: Pick<AlayaCliContext, "stdout">,
  output: { proposals?: readonly Record<string, unknown>[] }
): void {
  const summaries = output.proposals;
  if (summaries === undefined || summaries.length === 0) {
    ctx.stdout.write("(no pending proposals)\n");
    return;
  }
  ctx.stdout.write(
    "proposal_id\ttarget_kind\ttarget_id\tcreated_at\treviewer\tdeadline\tqueue_state\tchange_summary\tproposed_changes\n"
  );
  for (const summary of summaries) {
    ctx.stdout.write(
      `${formatCell(summary.proposal_id)}\t${formatCell(summary.target_object_kind)}\t${formatCell(summary.target_object_id)}\t${formatCell(summary.created_at)}\t${formatCell(summary.assigned_reviewer_identity)}\t${formatCell(summary.deadline_at)}\t${formatOverdue(summary.is_overdue)}\t${formatCell(summary.proposed_change_summary)}\t${formatJsonCell(summary.proposed_changes)}\n`
    );
  }
}

function buildMemoryProposalReviewArguments(
  args: ReviewArgs,
  reviewer: Readonly<{ identity: string; token: string | null }>
): Record<string, unknown> {
  const reviewArguments: Record<string, unknown> = {
    proposal_id: args.proposalId,
    verdict: args.action === "accept" ? "accept" : "reject",
    reason: args.reason,
    reviewer_identity: reviewer.identity
  };
  if (reviewer.token !== null) {
    reviewArguments.reviewer_token = reviewer.token;
  }
  return reviewArguments;
}
