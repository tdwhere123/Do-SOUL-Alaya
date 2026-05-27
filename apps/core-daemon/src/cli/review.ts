import { randomUUID } from "node:crypto";
import type {
  McpMemoryToolCallContext,
  McpMemoryToolHandler
} from "../mcp-memory-tool-handler.js";
import {
  ALAYA_SYSEXITS,
  type AlayaCliArgsSchema,
  type AlayaCliContext,
  type AlayaCliResult,
  type AlayaSubcommandSpec
} from "./bridge.js";
import {
  ensureImplicitLocalWorkspace,
  type EnsureLocalWorkspacePort,
  type RunWorkspaceLookupPort,
  resolveTrustedCliRunId,
  resolveCliWorkspaceContext
} from "./workspace-context.js";

// A1 (HITL daemon backbone) — `alaya review` is a CLI fallback for the
// same MCP handler attached agents use. Each verb routes through the
// MemoryToolHandler so behavior, validation, and audit trails stay
// identical between Codex/Claude attach and a human at a terminal. This
// follows the `alaya tools list | tools call` precedent in
// apps/core-daemon/src/cli/tools.ts.

export interface ReviewCommandDependencies {
  readonly handler: McpMemoryToolHandler;
  readonly defaultWorkspaceId?: string;
  readonly defaultRunId?: string | null;
  readonly defaultAgentTarget?: string;
  readonly defaultReviewerIdentity?: string;
  readonly defaultReviewerToken?: string;
  readonly ensureLocalWorkspace?: EnsureLocalWorkspacePort;
  readonly runService?: RunWorkspaceLookupPort;
}

interface ReviewArgs {
  readonly target: "memory" | "edges";
  readonly action: "pending" | "accept" | "reject";
  readonly proposalId: string | null;
  readonly edgeProposalIds: readonly string[];
  readonly reason: string | null;
  readonly limit: number | null;
  readonly since: string | null;
  readonly edgeType: string | null;
  readonly minConfidence: number | null;
  readonly reviewerIdentity: string | null;
  readonly contextOverrides: Readonly<{
    readonly workspaceId: string | null;
    readonly runId: string | null | undefined;
    readonly agentTarget: string | null;
  }>;
}

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
  const callContextResult = await buildCallContext(ctx, args, deps);
  if (!callContextResult.ok) {
    ctx.stderr.write(`${callContextResult.message}\n`);
    return { exitCode: ALAYA_SYSEXITS.DATAERR };
  }
  const callContext = callContextResult.context;
  // invariant: workspace_id is bound server-side from
  // callContext.workspaceId; it must NOT be placed in the request body
  // (mirrors soul.explore_graph schema discipline — keeps attached
  // LLMs from being taught to pass caller scope back in the payload).
  const requestArgs: Record<string, unknown> = {};
  if (args.since !== null) requestArgs.since = args.since;
  if (args.limit !== null) requestArgs.limit = args.limit;

  const result = await deps.handler.call({
    toolName: "soul.list_pending_proposals",
    arguments: requestArgs,
    context: callContext
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
    const summaries = (result.output as { proposals?: readonly Record<string, unknown>[] })
      .proposals;
    if (summaries === undefined || summaries.length === 0) {
      ctx.stdout.write("(no pending proposals)\n");
    } else {
      ctx.stdout.write(
        "proposal_id\ttarget_kind\ttarget_id\tcreated_at\treviewer\tdeadline\tqueue_state\tchange_summary\tproposed_changes\n"
      );
      for (const summary of summaries) {
        ctx.stdout.write(
          `${formatCell(summary.proposal_id)}\t${formatCell(summary.target_object_kind)}\t${formatCell(summary.target_object_id)}\t${formatCell(summary.created_at)}\t${formatCell(summary.assigned_reviewer_identity)}\t${formatCell(summary.deadline_at)}\t${formatOverdue(summary.is_overdue)}\t${formatCell(summary.proposed_change_summary)}\t${formatJsonCell(summary.proposed_changes)}\n`
        );
      }
    }
  }
  return {
    exitCode: ALAYA_SYSEXITS.OK,
    json: result.output
  };
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

  const callContextResult = await buildCallContext(ctx, args, deps);
  if (!callContextResult.ok) {
    ctx.stderr.write(`${callContextResult.message}\n`);
    return { exitCode: ALAYA_SYSEXITS.DATAERR };
  }
  const callContext = callContextResult.context;
  const reviewer = resolveReviewIdentity(ctx, args, deps);
  if (!reviewer.ok) {
    ctx.stderr.write(`${reviewer.message}\n`);
    return { exitCode: ALAYA_SYSEXITS.USAGE };
  }

  const reviewArguments: Record<string, unknown> = {
    proposal_id: args.proposalId,
    verdict: args.action === "accept" ? "accept" : "reject",
    reason: args.reason,
    reviewer_identity: reviewer.identity
  };
  if (reviewer.token !== null) {
    reviewArguments.reviewer_token = reviewer.token;
  }

  const result = await deps.handler.call({
    toolName: "soul.review_memory_proposal",
    arguments: reviewArguments,
    context: callContext
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
    const output = result.output as { resolution_state?: string; proposal_id?: string };
    const durableApplyState =
      output.resolution_state === "accepted" ? "durable_apply=applied" : "durable_apply=not-requested";
    ctx.stdout.write(`${JSON.stringify(result.output)} ${durableApplyState}\n`);
  }
  return {
    exitCode: ALAYA_SYSEXITS.OK,
    json: result.output
  };
}

function resolveReviewerBinding(
  ctx: AlayaCliContext,
  deps: ReviewCommandDependencies
): { readonly token: string; readonly identity: string } | null {
  const token = normalizeOptionalString(deps.defaultReviewerToken ?? ctx.env.ALAYA_REVIEWER_TOKEN);
  if (token === null) {
    return null;
  }
  const identity = normalizeOptionalString(deps.defaultReviewerIdentity ?? ctx.env.ALAYA_REVIEWER_IDENTITY);
  if (identity === null) {
    throw new Error("ALAYA_REVIEWER_TOKEN and ALAYA_REVIEWER_IDENTITY must be configured together.");
  }
  return { token, identity };
}

function resolveReviewIdentity(
  ctx: AlayaCliContext,
  args: ReviewArgs,
  deps: ReviewCommandDependencies
):
  | { readonly ok: true; readonly identity: string; readonly token: string | null }
  | { readonly ok: false; readonly message: string } {
  let reviewerBinding: { readonly token: string; readonly identity: string } | null;
  try {
    reviewerBinding = resolveReviewerBinding(ctx, deps);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  if (
    reviewerBinding !== null &&
    args.reviewerIdentity !== null &&
    args.reviewerIdentity !== reviewerBinding.identity
  ) {
    return { ok: false, message: "reviewer identity does not match ALAYA_REVIEWER_IDENTITY." };
  }
  const reviewerIdentity =
    reviewerBinding?.identity ??
    args.reviewerIdentity ??
    deps.defaultReviewerIdentity ??
    ctx.env.ALAYA_REVIEWER_IDENTITY ??
    null;
  if (reviewerIdentity === null || reviewerIdentity.trim().length === 0) {
    return {
      ok: false,
      message:
        "review requires --reviewer <identity> (or ALAYA_REVIEWER_IDENTITY env var) so the audit trail names who approved or rejected."
    };
  }
  return {
    ok: true,
    identity: reviewerIdentity,
    token: reviewerBinding?.token ?? null
  };
}

function normalizeOptionalString(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? null : normalized;
}

function buildEdgeFilterArguments(
  args: ReviewArgs,
  options: { readonly includeProposalIds: boolean }
): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  if (options.includeProposalIds && args.edgeProposalIds.length > 0) {
    filter.proposal_ids = args.edgeProposalIds;
  }
  if (args.edgeType !== null) {
    filter.edge_type = args.edgeType;
  }
  if (args.minConfidence !== null) {
    filter.min_confidence = args.minConfidence;
  }
  if (args.since !== null) {
    filter.since = args.since;
  }
  if (args.limit !== null) {
    filter.limit = args.limit;
  }
  return filter;
}

function formatCell(value: unknown): string {
  if (typeof value === "string") {
    return value.length > 0 ? value : "-";
  }
  if (typeof value === "number") {
    return String(value);
  }
  return "-";
}

function formatJsonCell(value: unknown): string {
  return value === null || value === undefined ? "-" : JSON.stringify(value);
}

function formatOverdue(value: unknown): string {
  return value === true ? "overdue" : "open";
}

function reviewArgsSchema(): AlayaCliArgsSchema<ReviewArgs> {
  return {
    safeParse(input) {
      if (!Array.isArray(input) || input.some((token) => typeof token !== "string")) {
        return {
          success: false,
          error: { issues: [{ path: [], message: "Expected a string argument list." }] }
        };
      }
      const parsed = parseReviewArgs(input);
      if (!parsed.ok) {
        return { success: false, error: { issues: [{ path: [], message: parsed.message }] } };
      }
      return { success: true, data: parsed.args };
    }
  };
}

function parseReviewArgs(input: readonly string[]):
  | Readonly<{ ok: true; args: ReviewArgs }>
  | Readonly<{ ok: false; message: string }> {
  if (input.length === 0) {
    return {
      ok: false,
      message:
        "Usage: review pending [--workspace <id>] [--limit <n>] [--since <iso>] | review accept <proposal-id> --reviewer <id> [--reason ...] | review reject <proposal-id> --reviewer <id> [--reason ...] | review edges pending|accept|reject [proposal-id ...] [--type <edge-type>] [--min-conf <n>] [--since <iso>]"
    };
  }

  const target = input[0] === "edges" ? "edges" : "memory";
  const actionIndex = target === "edges" ? 1 : 0;
  const action = input[actionIndex];
  if (action === undefined) {
    return { ok: false, message: "review edges requires an action: pending | accept | reject." };
  }
  if (action !== "pending" && action !== "accept" && action !== "reject") {
    return {
      ok: false,
      message: target === "edges" ? `Unknown edge review action: ${action}` : `Unknown review action: ${action}`
    };
  }

  let proposalId: string | null = null;
  let edgeProposalIds: string[] = [];
  let reason: string | null = null;
  let limit: number | null = null;
  let since: string | null = null;
  let edgeType: string | null = null;
  let minConfidence: number | null = null;
  let reviewerIdentity: string | null = null;
  let workspaceId: string | null = null;
  let runId: string | null | undefined = undefined;
  let agentTarget: string | null = null;
  const positionals: string[] = [];

  for (let index = actionIndex + 1; index < input.length; index += 1) {
    const token = input[index]!;
    if (
      token === "--reason" ||
      token === "--limit" ||
      token === "--since" ||
      token === "--type" ||
      token === "--min-conf" ||
      token === "--reviewer" ||
      token === "--workspace" ||
      token === "--run" ||
      token === "--agent"
    ) {
      const value = input[index + 1];
      if (value === undefined || value.trim().length === 0) {
        return { ok: false, message: `${token} requires a non-empty value.` };
      }
      switch (token) {
        case "--reason":
          reason = value;
          break;
        case "--limit": {
          const parsedLimit = Number.parseInt(value, 10);
          if (!Number.isFinite(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
            return { ok: false, message: "--limit must be an integer between 1 and 100." };
          }
          limit = parsedLimit;
          break;
        }
        case "--since":
          since = value.trim();
          break;
        case "--type":
          edgeType = value.trim();
          break;
        case "--min-conf": {
          const parsedConfidence = Number.parseFloat(value);
          if (!Number.isFinite(parsedConfidence) || parsedConfidence < 0 || parsedConfidence > 1) {
            return { ok: false, message: "--min-conf must be a number between 0 and 1." };
          }
          minConfidence = parsedConfidence;
          break;
        }
        case "--reviewer":
          reviewerIdentity = value.trim();
          break;
        case "--workspace":
          workspaceId = value.trim();
          break;
        case "--run":
          runId = value.trim() === "null" ? null : value.trim();
          break;
        case "--agent":
          agentTarget = value.trim();
          break;
      }
      index += 1;
      continue;
    }
    if (token.startsWith("--")) {
      return { ok: false, message: `Unknown review option: ${token}` };
    }
    positionals.push(token);
  }

  if (target === "memory" && (edgeType !== null || minConfidence !== null)) {
    return { ok: false, message: "--type and --min-conf are only valid for review edges." };
  }

  if (target === "memory" && action !== "pending" && positionals.length !== 1) {
    return {
      ok: false,
      message: `review ${action} requires exactly one proposal id positional.`
    };
  }
  if (target === "memory" && action === "pending" && positionals.length > 0) {
    return { ok: false, message: "review pending takes no positionals." };
  }

  if (target === "memory" && action !== "pending") {
    proposalId = positionals[0]!;
  }
  if (target === "edges") {
    if (action === "pending" && positionals.length > 0) {
      return { ok: false, message: "review edges pending takes no positionals." };
    }
    if (action !== "pending") {
      edgeProposalIds = positionals;
      if (
        edgeProposalIds.length === 0 &&
        edgeType === null &&
        minConfidence === null &&
        since === null
      ) {
        return {
          ok: false,
          message: `review edges ${action} requires at least one proposal id or filter (--type, --min-conf, --since).`
        };
      }
    }
  }

  return {
    ok: true,
    args: {
      target,
      action,
      proposalId,
      edgeProposalIds,
      reason,
      limit,
      since,
      edgeType,
      minConfidence,
      reviewerIdentity,
      contextOverrides: { workspaceId, runId, agentTarget }
    }
  };
}

async function buildCallContext(
  ctx: AlayaCliContext,
  args: ReviewArgs,
  deps: ReviewCommandDependencies
): Promise<
  | { readonly ok: true; readonly context: McpMemoryToolCallContext }
  | { readonly ok: false; readonly message: string }
> {
  // The `alaya review` verbs are the human-reviewer surface. They must
  // default to `runId: null` and `agentTarget: "cli"` regardless of
  // attach-session env such as ALAYA_RUN_ID / ALAYA_AGENT_TARGET. Only
  // explicit CLI/dependency overrides change the review context.
  const workspaceContext = resolveCliWorkspaceContext(
    ctx,
    args.contextOverrides.workspaceId,
    deps.defaultWorkspaceId
  );
  await ensureImplicitLocalWorkspace(workspaceContext, deps.ensureLocalWorkspace);
  const requestedRun = resolveRequestedRunId(args, deps);
  const trustedRunId = await resolveTrustedCliRunId({
    runId: requestedRun.runId,
    workspaceId: workspaceContext.workspaceId,
    runService: deps.runService,
    sourceLabel: requestedRun.sourceLabel
  });
  if (!trustedRunId.ok) {
    return trustedRunId;
  }

  return {
    ok: true,
    context: {
      workspaceId: workspaceContext.workspaceId,
      runId: trustedRunId.runId,
      agentTarget:
        args.contextOverrides.agentTarget ??
        deps.defaultAgentTarget ??
        "cli",
      sessionId: `review-cli-${randomUUID()}`
    }
  };
}

function resolveRequestedRunId(
  args: ReviewArgs,
  deps: ReviewCommandDependencies
): { readonly runId: string | null | undefined; readonly sourceLabel: string } {
  if (args.contextOverrides.runId !== undefined) {
    return { runId: args.contextOverrides.runId, sourceLabel: "--run" };
  }
  if (deps.defaultRunId !== undefined && deps.defaultRunId !== null) {
    return { runId: deps.defaultRunId, sourceLabel: "defaultRunId" };
  }
  return { runId: null, sourceLabel: "review-run" };
}
