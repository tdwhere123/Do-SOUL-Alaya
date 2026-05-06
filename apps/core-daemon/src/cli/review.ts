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
  readonly action: "pending" | "accept" | "reject";
  readonly proposalId: string | null;
  readonly reason: string | null;
  readonly limit: number | null;
  readonly since: string | null;
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
      "Review pending memory proposals. Subactions: pending | accept <proposal-id> | reject <proposal-id> [--reason ...] [--reviewer ...].",
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
  // A1 fix-loop (finding-2): workspace_id is bound server-side from
  // callContext.workspaceId; no longer placed in the request body
  // (mirrors soul.explore_graph schema discipline).
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
  let reviewerBinding: { readonly token: string; readonly identity: string } | null;
  try {
    reviewerBinding = resolveReviewerBinding(ctx, deps);
  } catch (error) {
    ctx.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return { exitCode: ALAYA_SYSEXITS.USAGE };
  }
  if (
    reviewerBinding !== null &&
    args.reviewerIdentity !== null &&
    args.reviewerIdentity !== reviewerBinding.identity
  ) {
    ctx.stderr.write("reviewer identity does not match ALAYA_REVIEWER_IDENTITY.\n");
    return { exitCode: ALAYA_SYSEXITS.USAGE };
  }
  const reviewerIdentity =
    reviewerBinding?.identity ??
    args.reviewerIdentity ??
    deps.defaultReviewerIdentity ??
    ctx.env.ALAYA_REVIEWER_IDENTITY ??
    null;
  if (reviewerIdentity === null || reviewerIdentity.trim().length === 0) {
    ctx.stderr.write(
      "review requires --reviewer <identity> (or ALAYA_REVIEWER_IDENTITY env var) so the audit trail names who approved or rejected.\n"
    );
    return { exitCode: ALAYA_SYSEXITS.USAGE };
  }

  const reviewArguments: Record<string, unknown> = {
    proposal_id: args.proposalId,
    verdict: args.action === "accept" ? "accept" : "reject",
    reason: args.reason,
    reviewer_identity: reviewerIdentity
  };
  if (reviewerBinding !== null) {
    reviewArguments.reviewer_token = reviewerBinding.token;
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

function normalizeOptionalString(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? null : normalized;
}

function formatCell(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : "-";
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
        "Usage: review pending [--workspace <id>] [--limit <n>] [--since <iso>] | review accept <proposal-id> --reviewer <id> [--reason ...] | review reject <proposal-id> --reviewer <id> [--reason ...]"
    };
  }

  const action = input[0];
  if (action !== "pending" && action !== "accept" && action !== "reject") {
    return { ok: false, message: `Unknown review action: ${action}` };
  }

  let proposalId: string | null = null;
  let reason: string | null = null;
  let limit: number | null = null;
  let since: string | null = null;
  let reviewerIdentity: string | null = null;
  let workspaceId: string | null = null;
  let runId: string | null | undefined = undefined;
  let agentTarget: string | null = null;
  const positionals: string[] = [];

  for (let index = 1; index < input.length; index += 1) {
    const token = input[index]!;
    if (
      token === "--reason" ||
      token === "--limit" ||
      token === "--since" ||
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

  if (action !== "pending" && positionals.length !== 1) {
    return {
      ok: false,
      message: `review ${action} requires exactly one proposal id positional.`
    };
  }
  if (action === "pending" && positionals.length > 0) {
    return { ok: false, message: "review pending takes no positionals." };
  }

  if (action !== "pending") {
    proposalId = positionals[0]!;
  }

  return {
    ok: true,
    args: {
      action,
      proposalId,
      reason,
      limit,
      since,
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
  // D2 MERGED-I3 / Gate-5F: the `alaya review` verbs ARE the
  // human-reviewer surface. They MUST default to `runId: null` and
  // `agentTarget: "cli"` regardless of attach-session env such as
  // ALAYA_RUN_ID / ALAYA_AGENT_TARGET. Only explicit CLI/dependency
  // overrides change the review context.
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
        "cli"
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
