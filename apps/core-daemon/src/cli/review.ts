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
  const callContext = buildCallContext(ctx, args, deps);
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
    const summaries = (result.output as { proposals?: readonly Record<string, string>[] })
      .proposals;
    if (summaries === undefined || summaries.length === 0) {
      ctx.stdout.write("(no pending proposals)\n");
    } else {
      for (const summary of summaries) {
        ctx.stdout.write(
          `${summary.proposal_id}\t${summary.target_object_kind}\t${summary.target_object_id}\t${summary.created_at}\t${summary.proposed_change_summary}\n`
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

  const callContext = buildCallContext(ctx, args, deps);
  const reviewerIdentity =
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

  const result = await deps.handler.call({
    toolName: "soul.review_memory_proposal",
    arguments: {
      proposal_id: args.proposalId,
      verdict: args.action === "accept" ? "accept" : "reject",
      reason: args.reason,
      reviewer_identity: reviewerIdentity
    },
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
    ctx.stdout.write(`${JSON.stringify(result.output)}\n`);
  }
  return {
    exitCode: ALAYA_SYSEXITS.OK,
    json: result.output
  };
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

function buildCallContext(
  ctx: AlayaCliContext,
  args: ReviewArgs,
  deps: ReviewCommandDependencies
): McpMemoryToolCallContext {
  return {
    workspaceId:
      args.contextOverrides.workspaceId ??
      deps.defaultWorkspaceId ??
      ctx.env.ALAYA_WORKSPACE_ID ??
      "default",
    runId:
      args.contextOverrides.runId !== undefined
        ? args.contextOverrides.runId
        : deps.defaultRunId ?? ctx.env.ALAYA_RUN_ID ?? null,
    agentTarget:
      args.contextOverrides.agentTarget ??
      deps.defaultAgentTarget ??
      ctx.env.ALAYA_AGENT_TARGET ??
      "cli"
  };
}
