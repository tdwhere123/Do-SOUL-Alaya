import { randomUUID } from "node:crypto";
import type {
  McpMemoryToolCallContext,
  McpMemoryToolHandler
} from "../mcp-memory/tool-handler.js";
import type { AlayaCliArgsSchema, AlayaCliContext } from "./bridge.js";
import {
  ensureImplicitLocalWorkspace,
  type EnsureLocalWorkspacePort,
  type RunWorkspaceLookupPort,
  resolveTrustedCliRunId,
  resolveCliWorkspaceContext
} from "./workspace-context.js";

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

export interface ReviewArgs {
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

export function resolveReviewIdentity(
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

export function buildEdgeFilterArguments(
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

export function formatCell(value: unknown): string {
  if (typeof value === "string") {
    return value.length > 0 ? value : "-";
  }
  if (typeof value === "number") {
    return String(value);
  }
  return "-";
}

export function formatJsonCell(value: unknown): string {
  return value === null || value === undefined ? "-" : JSON.stringify(value);
}

export function formatOverdue(value: unknown): string {
  return value === true ? "overdue" : "open";
}

export function reviewArgsSchema(): AlayaCliArgsSchema<ReviewArgs> {
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

interface ParsedReviewHead {
  readonly target: ReviewArgs["target"];
  readonly action: ReviewArgs["action"];
  readonly actionIndex: number;
}

interface ParsedReviewOptionState {
  readonly positionals: string[];
  proposalId: string | null;
  edgeProposalIds: string[];
  reason: string | null;
  limit: number | null;
  since: string | null;
  edgeType: string | null;
  minConfidence: number | null;
  reviewerIdentity: string | null;
  workspaceId: string | null;
  runId: string | null | undefined;
  agentTarget: string | null;
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

  const head = parseReviewCommandHead(input);
  if (!head.ok) {
    return head;
  }

  const options = collectReviewOptionState(input, head.actionIndex + 1);
  if (!options.ok) {
    return options;
  }

  return finalizeReviewArgs(head, options.state);
}

function parseReviewCommandHead(input: readonly string[]):
  | Readonly<{ ok: true; target: ReviewArgs["target"]; action: ReviewArgs["action"]; actionIndex: number }>
  | Readonly<{ ok: false; message: string }> {
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
  return { ok: true, target, action, actionIndex };
}

function createParsedReviewOptionState(): ParsedReviewOptionState {
  return {
    positionals: [],
    proposalId: null,
    edgeProposalIds: [],
    reason: null,
    limit: null,
    since: null,
    edgeType: null,
    minConfidence: null,
    reviewerIdentity: null,
    workspaceId: null,
    runId: undefined,
    agentTarget: null
  };
}

function collectReviewOptionState(
  input: readonly string[],
  startIndex: number
):
  | Readonly<{ ok: true; state: ParsedReviewOptionState }>
  | Readonly<{ ok: false; message: string }> {
  const state = createParsedReviewOptionState();
  for (let index = startIndex; index < input.length; index += 1) {
    const token = input[index]!;
    if (!isReviewOption(token)) {
      if (token.startsWith("--")) {
        return { ok: false, message: `Unknown review option: ${token}` };
      }
      state.positionals.push(token);
      continue;
    }
    const value = input[index + 1];
    if (value === undefined || value.trim().length === 0) {
      return { ok: false, message: `${token} requires a non-empty value.` };
    }
    const applied = applyReviewOption(state, token, value);
    if (!applied.ok) {
      return applied;
    }
    index += 1;
  }
  return { ok: true, state };
}

function isReviewOption(token: string): boolean {
  return (
    token === "--reason" ||
    token === "--limit" ||
    token === "--since" ||
    token === "--type" ||
    token === "--min-conf" ||
    token === "--reviewer" ||
    token === "--workspace" ||
    token === "--run" ||
    token === "--agent"
  );
}

function applyReviewOption(
  state: ParsedReviewOptionState,
  token: string,
  value: string
): Readonly<{ ok: true }> | Readonly<{ ok: false; message: string }> {
  switch (token) {
    case "--reason":
      state.reason = value;
      return { ok: true };
    case "--limit":
      return parseReviewLimit(state, value);
    case "--since":
      state.since = value.trim();
      return { ok: true };
    case "--type":
      state.edgeType = value.trim();
      return { ok: true };
    case "--min-conf":
      return parseReviewMinConfidence(state, value);
    case "--reviewer":
      state.reviewerIdentity = value.trim();
      return { ok: true };
    case "--workspace":
      state.workspaceId = value.trim();
      return { ok: true };
    case "--run":
      state.runId = value.trim() === "null" ? null : value.trim();
      return { ok: true };
    case "--agent":
      state.agentTarget = value.trim();
      return { ok: true };
    default:
      return { ok: false, message: `Unknown review option: ${token}` };
  }
}

function parseReviewLimit(
  state: ParsedReviewOptionState,
  value: string
): Readonly<{ ok: true }> | Readonly<{ ok: false; message: string }> {
  const parsedLimit = Number.parseInt(value, 10);
  if (!Number.isFinite(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
    return { ok: false, message: "--limit must be an integer between 1 and 100." };
  }
  state.limit = parsedLimit;
  return { ok: true };
}

function parseReviewMinConfidence(
  state: ParsedReviewOptionState,
  value: string
): Readonly<{ ok: true }> | Readonly<{ ok: false; message: string }> {
  const parsedConfidence = Number.parseFloat(value);
  if (!Number.isFinite(parsedConfidence) || parsedConfidence < 0 || parsedConfidence > 1) {
    return { ok: false, message: "--min-conf must be a number between 0 and 1." };
  }
  state.minConfidence = parsedConfidence;
  return { ok: true };
}

function finalizeReviewArgs(
  head: ParsedReviewHead,
  state: ParsedReviewOptionState
): Readonly<{ ok: true; args: ReviewArgs }> | Readonly<{ ok: false; message: string }> {
  if (head.target === "memory") {
    return finalizeMemoryReviewArgs(head, state);
  }
  return finalizeEdgeReviewArgs(head, state);
}

function finalizeMemoryReviewArgs(
  head: ParsedReviewHead,
  state: ParsedReviewOptionState
): Readonly<{ ok: true; args: ReviewArgs }> | Readonly<{ ok: false; message: string }> {
  if (state.edgeType !== null || state.minConfidence !== null) {
    return { ok: false, message: "--type and --min-conf are only valid for review edges." };
  }
  if (head.action === "pending" && state.positionals.length > 0) {
    return { ok: false, message: "review pending takes no positionals." };
  }
  if (head.action !== "pending" && state.positionals.length !== 1) {
    return {
      ok: false,
      message: `review ${head.action} requires exactly one proposal id positional.`
    };
  }
  state.proposalId = head.action === "pending" ? null : state.positionals[0]!;
  return buildReviewArgsResult(head, state);
}

function finalizeEdgeReviewArgs(
  head: ParsedReviewHead,
  state: ParsedReviewOptionState
): Readonly<{ ok: true; args: ReviewArgs }> | Readonly<{ ok: false; message: string }> {
  if (head.action === "pending" && state.positionals.length > 0) {
    return { ok: false, message: "review edges pending takes no positionals." };
  }
  if (head.action !== "pending") {
    state.edgeProposalIds = state.positionals;
    if (
      state.edgeProposalIds.length === 0 &&
      state.edgeType === null &&
      state.minConfidence === null &&
      state.since === null
    ) {
      return {
        ok: false,
        message: `review edges ${head.action} requires at least one proposal id or filter (--type, --min-conf, --since).`
      };
    }
  }
  return buildReviewArgsResult(head, state);
}

function buildReviewArgsResult(
  head: ParsedReviewHead,
  state: ParsedReviewOptionState
): Readonly<{ ok: true; args: ReviewArgs }> {
  return {
    ok: true,
    args: {
      target: head.target,
      action: head.action,
      proposalId: state.proposalId,
      edgeProposalIds: state.edgeProposalIds,
      reason: state.reason,
      limit: state.limit,
      since: state.since,
      edgeType: state.edgeType,
      minConfidence: state.minConfidence,
      reviewerIdentity: state.reviewerIdentity,
      contextOverrides: {
        workspaceId: state.workspaceId,
        runId: state.runId,
        agentTarget: state.agentTarget
      }
    }
  };
}

export async function buildCallContext(
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
