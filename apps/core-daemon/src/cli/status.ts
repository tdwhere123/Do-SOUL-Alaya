import type { TrustSummary } from "@do-soul/alaya-protocol";
import type { DaemonStartupStepRecord } from "../index.js";
import type { RecallUtilizationService, RecallUtilizationStats } from "../services/recall-utilization-service.js";
import { ALAYA_SYSEXITS, type AlayaCliArgsSchema, type AlayaCliContext, type AlayaCliResult, type AlayaSubcommandSpec } from "./bridge.js";

const DEFAULT_RECALL_STATS_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

export interface StatusCommandDependencies {
  readonly trustStateSummaryProvider: (agentTarget: string) => Promise<TrustSummary>;
  readonly resolveAgentTargets?: () => Promise<readonly string[]> | readonly string[];
  readonly getGardenStatus?: () => Promise<Readonly<{ last_pass_at: string | null }>>;
  readonly getSourceGroundingDeferStats?: () => Promise<Readonly<{
    queue_depth: number;
    queue_cap: number;
    deferred_by_reason: Readonly<Record<string, number>>;
  }>> | Readonly<{
    queue_depth: number;
    queue_cap: number;
    deferred_by_reason: Readonly<Record<string, number>>;
  }>;
  readonly recallUtilizationService: RecallUtilizationService;
  readonly startupStepsProvider?: (
    context: Pick<AlayaCliContext, "daemon">
  ) => readonly DaemonStartupStepRecord[];
  readonly clock?: () => string;
}

interface StatusArgs {
  readonly agentTargets: readonly string[];
  readonly recallStats: boolean;
  readonly recallStatsWorkspaceId: string | null;
  readonly recallStatsSince: string | null;
  readonly recallStatsUntil: string | null;
}

interface StatusReport {
  readonly checked_at: string;
  readonly daemon: Readonly<{
    up: boolean;
    completed_steps: readonly string[];
    missing_steps: readonly string[];
  }>;
  readonly trust: readonly TrustSummary[];
  readonly garden: Readonly<{
    last_pass_at: string | null;
    source_grounding_defers?: Readonly<{
      queue_depth: number;
      queue_cap: number;
      deferred_by_reason: Readonly<Record<string, number>>;
    }>;
  }>;
  readonly recall_stats?: RecallUtilizationStats;
}

const STARTUP_STEPS = [
  "database",
  "repositories",
  "core-services",
  "garden-runtime",
  "mcp-tooling",
  "http-app"
] as const;

export function createStatusCommand(
  deps: StatusCommandDependencies
): AlayaSubcommandSpec<StatusArgs> {
  return {
    name: "status",
    description: "Report daemon readiness, trust summaries, and Garden status.",
    argsSchema: statusArgsSchema(),
    requiresDaemonReady: false,
    handler: async (ctx, args) => await executeStatusCommand(ctx, args, deps)
  };
}

function statusArgsSchema(): AlayaCliArgsSchema<StatusArgs> {
  return {
    safeParse: safeParseStatusArgs
  };
}

async function normalizeAgentTargets(
  resolveAgentTargets: StatusCommandDependencies["resolveAgentTargets"]
): Promise<readonly string[]> {
  const resolved = resolveAgentTargets ? await resolveAgentTargets() : ["codex", "claude-code"];
  const normalized = resolved
    .map((target) => target.trim())
    .filter((target) => target.length > 0);
  return normalized.length > 0 ? normalized : ["codex", "claude-code"];
}

function writeHumanSummary(stream: NodeJS.WritableStream, report: StatusReport): void {
  stream.write(`daemon up: ${report.daemon.up ? "yes" : "no"}\n`);
  stream.write(
    "memory governance: candidate signals and pending proposals are review inputs; durable memory changes only after accepted proposal apply.\n"
  );
  for (const trust of report.trust) {
    stream.write(
      `${trust.agent_target}: state=${trust.state} delivered=${trust.delivered_count} used=${trust.used_count} skipped=${trust.skipped_count} not_applicable=${trust.not_applicable_count} unverifiable=${trust.unverifiable_count}\n`
    );
  }
  stream.write(
    "trust counters above track delivery/usage evidence and are distinct from pending proposal queue state.\n"
  );
  stream.write(`garden last pass: ${report.garden.last_pass_at ?? "n/a"}\n`);
  if (report.garden.source_grounding_defers !== undefined) {
    const defers = report.garden.source_grounding_defers;
    const reasons = Object.entries(defers.deferred_by_reason)
      .map(([reason, count]) => `${reason}=${count}`)
      .join(" ") || "(none)";
    stream.write(
      `garden source-grounding defers: queue=${defers.queue_depth}/${defers.queue_cap} by_reason: ${reasons}\n`
    );
  }
  stream.write("memory inspector: run `alaya inspect --open` to launch the loopback UI (http://127.0.0.1:5174).\n");
  if (report.recall_stats !== undefined) {
    writeRecallStatsSummary(stream, report.recall_stats);
  }
}

function writeRecallStatsSummary(stream: NodeJS.WritableStream, stats: RecallUtilizationStats): void {
  const window = `${stats.window.since ?? "(open)"} → ${stats.window.until ?? "(now)"}`;
  stream.write(`recall stats (workspace ${stats.window.workspace_id}, ${window}):\n`);
  stream.write(
    `  recall: total=${stats.recall.total} unique_runs=${stats.recall.unique_runs} null_run=${stats.recall.null_run} miss=${stats.recall.miss_count}/${stats.recall.total} (${formatRatio(stats.recall.miss_ratio)}) p50_pointers=${stats.recall.p50_pointer_count} p50_latency_ms=${stats.recall.p50_latency_ms}\n`
  );
  stream.write(
    `  embedding: queries=${stats.embedding.total_queries} returned=${stats.embedding.returned_candidate_count} p50_ms=${stats.embedding.p50_latency_ms} p95_ms=${stats.embedding.p95_latency_ms} p99_ms=${stats.embedding.p99_latency_ms}\n`
  );
  stream.write(
    `  usage:  total=${stats.usage.total} used=${stats.usage.used} skipped=${stats.usage.skipped} not_applicable=${stats.usage.not_applicable} used_ratio=${formatRatio(stats.usage.used_ratio)} follow_through=${formatRatio(stats.usage.follow_through_ratio)}\n`
  );
}

function formatRatio(value: number): string {
  if (!Number.isFinite(value)) {
    return "n/a";
  }
  return `${(value * 100).toFixed(1)}%`;
}

async function executeStatusCommand(
  ctx: AlayaCliContext,
  args: StatusArgs,
  deps: StatusCommandDependencies
): Promise<AlayaCliResult> {
  const reportResult = await buildStatusReport(ctx, args, deps);
  if (!reportResult.ok) {
    return reportResult.result;
  }
  if (ctx.jsonRequested !== true) {
    writeHumanSummary(ctx.stdout, reportResult.report);
  }
  return {
    exitCode: reportResult.daemonUp ? ALAYA_SYSEXITS.OK : ALAYA_SYSEXITS.TEMPFAIL,
    json: reportResult.report
  };
}

async function buildStatusReport(
  ctx: AlayaCliContext,
  args: StatusArgs,
  deps: StatusCommandDependencies
): Promise<
  | Readonly<{ ok: true; daemonUp: boolean; report: StatusReport }>
  | Readonly<{ ok: false; result: AlayaCliResult }>
> {
  const now = deps.clock ?? (() => new Date().toISOString());
  const daemonStatus = summarizeDaemonStatus(ctx, deps);
  const configuredTargets = args.agentTargets.length > 0
    ? args.agentTargets
    : await normalizeAgentTargets(deps.resolveAgentTargets);
  const trustSummaries = await Promise.all(
    configuredTargets.map(async (target) => await deps.trustStateSummaryProvider(target))
  );
  const recallStatsResult = await maybeLoadRecallStats(ctx, args, deps, now);
  if (!recallStatsResult.ok) {
    return recallStatsResult;
  }
  const gardenBase = deps.getGardenStatus ? await deps.getGardenStatus() : { last_pass_at: null };
  const sourceGroundingDefers = deps.getSourceGroundingDeferStats
    ? await deps.getSourceGroundingDeferStats()
    : undefined;
  const report: StatusReport = {
    checked_at: now(),
    daemon: daemonStatus.summary,
    trust: trustSummaries,
    garden: {
      ...gardenBase,
      ...(sourceGroundingDefers === undefined
        ? {}
        : { source_grounding_defers: sourceGroundingDefers })
    },
    ...(recallStatsResult.recallStats === undefined ? {} : { recall_stats: recallStatsResult.recallStats })
  };
  return { ok: true, daemonUp: daemonStatus.summary.up, report };
}

function summarizeDaemonStatus(
  ctx: Pick<AlayaCliContext, "daemon">,
  deps: StatusCommandDependencies
): Readonly<{ summary: StatusReport["daemon"] }> {
  const startupSteps = deps.startupStepsProvider?.(ctx) ?? ctx.daemon.startupSteps;
  const completedSteps = startupSteps.map((step) => step.step);
  const missingSteps = STARTUP_STEPS.filter((step) => !completedSteps.includes(step));
  return {
    summary: {
      up: missingSteps.length === 0,
      completed_steps: completedSteps,
      missing_steps: missingSteps
    }
  };
}

async function maybeLoadRecallStats(
  ctx: AlayaCliContext,
  args: StatusArgs,
  deps: StatusCommandDependencies,
  now: () => string
): Promise<
  | Readonly<{ ok: true; recallStats?: RecallUtilizationStats }>
  | Readonly<{ ok: false; result: AlayaCliResult }>
> {
  if (!args.recallStats) {
    return { ok: true };
  }
  if (args.recallStatsWorkspaceId === null) {
    ctx.stderr.write("--recall-stats requires --workspace <id>.\n");
    return { ok: false, result: { exitCode: ALAYA_SYSEXITS.USAGE } };
  }
  const checkedAt = now();
  const sinceDefault = new Date(Date.parse(checkedAt) - DEFAULT_RECALL_STATS_LOOKBACK_MS).toISOString();
  return {
    ok: true,
    recallStats: await deps.recallUtilizationService.getStats({
      workspaceId: args.recallStatsWorkspaceId,
      since: args.recallStatsSince ?? sinceDefault,
      until: args.recallStatsUntil ?? checkedAt
    })
  };
}

function safeParseStatusArgs(input: unknown):
  | { readonly success: true; readonly data: StatusArgs }
  | { readonly success: false; readonly error: { readonly issues: readonly { readonly path: readonly number[]; readonly message: string }[] } } {
  if (!Array.isArray(input) || input.some((token) => typeof token !== "string")) {
    return {
      success: false,
      error: { issues: [{ path: [], message: "Expected a string argument list." }] }
    };
  }
  return parseStatusArgs(input);
}

function parseStatusArgs(
  input: readonly string[]
):
  | { readonly success: true; readonly data: StatusArgs }
  | { readonly success: false; readonly error: { readonly issues: readonly { readonly path: readonly number[]; readonly message: string }[] } } {
  const state = {
    agentTargets: [] as string[],
    recallStats: false,
    recallStatsWorkspaceId: null as string | null,
    recallStatsSince: null as string | null,
    recallStatsUntil: null as string | null
  };
  for (let index = 0; index < input.length; index += 1) {
    const token = input[index]!;
    if (token === "--recall-stats") {
      state.recallStats = true;
      continue;
    }
    const optionResult = applyStatusOption(state, token, input[index + 1], index);
    if (!optionResult.ok) {
      return { success: false, error: { issues: [{ path: optionResult.path, message: optionResult.message }] } };
    }
    if (!optionResult.handled) {
      return { success: false, error: { issues: [{ path: [index], message: `Unknown argument: ${token}` }] } };
    }
    index += 1;
  }
  if (!state.recallStats && (state.recallStatsWorkspaceId !== null || state.recallStatsSince !== null || state.recallStatsUntil !== null)) {
    return {
      success: false,
      error: { issues: [{ path: [], message: "--workspace / --since / --until require --recall-stats." }] }
    };
  }
  return { success: true, data: state };
}

function applyStatusOption(
  state: {
    agentTargets: string[];
    recallStats: boolean;
    recallStatsWorkspaceId: string | null;
    recallStatsSince: string | null;
    recallStatsUntil: string | null;
  },
  token: string,
  value: string | undefined,
  index: number
):
  | Readonly<{ ok: true; handled: false }>
  | Readonly<{ ok: true; handled: true }>
  | Readonly<{ ok: false; path: readonly number[]; message: string }> {
  if (token !== "--workspace" && token !== "--since" && token !== "--until" && token !== "--agent") {
    return { ok: true, handled: false };
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, path: [index + 1], message: `Missing value for ${token}.` };
  }
  if (token === "--agent") {
    state.agentTargets.push(value.trim());
    return { ok: true, handled: true };
  }
  if (token === "--workspace") {
    state.recallStatsWorkspaceId = value.trim();
    return { ok: true, handled: true };
  }
  if (Number.isNaN(Date.parse(value))) {
    return {
      ok: false,
      path: [index + 1],
      message: token === "--since" ? "--since requires an ISO datetime." : "--until requires an ISO datetime."
    };
  }
  if (token === "--since") {
    state.recallStatsSince = value;
  } else {
    state.recallStatsUntil = value;
  }
  return { ok: true, handled: true };
}
