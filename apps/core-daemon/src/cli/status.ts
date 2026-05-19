import type { TrustSummary } from "@do-soul/alaya-protocol";
import type { DaemonStartupStepRecord } from "../index.js";
import type { RecallUtilizationService, RecallUtilizationStats } from "../services/recall-utilization-service.js";
import { ALAYA_SYSEXITS, type AlayaCliArgsSchema, type AlayaCliContext, type AlayaSubcommandSpec } from "./bridge.js";

const DEFAULT_RECALL_STATS_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

export interface StatusCommandDependencies {
  readonly trustStateSummaryProvider: (agentTarget: string) => Promise<TrustSummary>;
  readonly resolveAgentTargets?: () => Promise<readonly string[]> | readonly string[];
  readonly getGardenStatus?: () => Promise<Readonly<{ last_pass_at: string | null }>>;
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
  const now = deps.clock ?? (() => new Date().toISOString());

  return {
    name: "status",
    description: "Report daemon readiness, trust summaries, and Garden status.",
    argsSchema: statusArgsSchema(),
    requiresDaemonReady: false,
    handler: async (ctx, args) => {
      const startupSteps =
        deps.startupStepsProvider?.(ctx) ?? ctx.daemon.startupSteps;
      const completedSteps = startupSteps.map((step) => step.step);
      const missingSteps = STARTUP_STEPS.filter((step) => !completedSteps.includes(step));
      const daemonUp = missingSteps.length === 0;

      const configuredTargets = args.agentTargets.length > 0
        ? args.agentTargets
        : await normalizeAgentTargets(deps.resolveAgentTargets);
      const trustSummaries = await Promise.all(
        configuredTargets.map(async (target) => await deps.trustStateSummaryProvider(target))
      );
      const gardenStatus = deps.getGardenStatus
        ? await deps.getGardenStatus()
        : { last_pass_at: null };

      let recallStats: RecallUtilizationStats | undefined;
      if (args.recallStats) {
        if (args.recallStatsWorkspaceId === null) {
          ctx.stderr.write("--recall-stats requires --workspace <id>.\n");
          return { exitCode: ALAYA_SYSEXITS.USAGE };
        }
        const checkedAt = now();
        const sinceDefault = new Date(Date.parse(checkedAt) - DEFAULT_RECALL_STATS_LOOKBACK_MS).toISOString();
        recallStats = await deps.recallUtilizationService.getStats({
          workspaceId: args.recallStatsWorkspaceId,
          since: args.recallStatsSince ?? sinceDefault,
          until: args.recallStatsUntil ?? checkedAt
        });
      }

      const report: StatusReport = {
        checked_at: now(),
        daemon: {
          up: daemonUp,
          completed_steps: completedSteps,
          missing_steps: missingSteps
        },
        trust: trustSummaries,
        garden: gardenStatus,
        ...(recallStats === undefined ? {} : { recall_stats: recallStats })
      };

      if (ctx.jsonRequested !== true) {
        writeHumanSummary(ctx.stdout, report);
      }

      return {
        exitCode: daemonUp ? ALAYA_SYSEXITS.OK : ALAYA_SYSEXITS.TEMPFAIL,
        json: report
      };
    }
  };
}

function statusArgsSchema(): AlayaCliArgsSchema<StatusArgs> {
  return {
    safeParse(input) {
      if (!Array.isArray(input) || input.some((token) => typeof token !== "string")) {
        return {
          success: false,
          error: { issues: [{ path: [], message: "Expected a string argument list." }] }
        } as const;
      }

      const agentTargets: string[] = [];
      let recallStats = false;
      let recallStatsWorkspaceId: string | null = null;
      let recallStatsSince: string | null = null;
      let recallStatsUntil: string | null = null;

      for (let index = 0; index < input.length; index += 1) {
        const token = input[index];

        if (token === "--recall-stats") {
          recallStats = true;
          continue;
        }

        if (token === "--workspace" || token === "--since" || token === "--until" || token === "--agent") {
          const value = input[index + 1];
          if (typeof value !== "string" || value.trim().length === 0) {
            return {
              success: false,
              error: { issues: [{ path: [index + 1], message: `Missing value for ${token}.` }] }
            } as const;
          }
          if (token === "--agent") {
            agentTargets.push(value.trim());
          } else if (token === "--workspace") {
            recallStatsWorkspaceId = value.trim();
          } else if (token === "--since") {
            if (Number.isNaN(Date.parse(value))) {
              return {
                success: false,
                error: { issues: [{ path: [index + 1], message: "--since requires an ISO datetime." }] }
              } as const;
            }
            recallStatsSince = value;
          } else {
            if (Number.isNaN(Date.parse(value))) {
              return {
                success: false,
                error: { issues: [{ path: [index + 1], message: "--until requires an ISO datetime." }] }
              } as const;
            }
            recallStatsUntil = value;
          }
          index += 1;
          continue;
        }

        return {
          success: false,
          error: {
            issues: [{ path: [index], message: `Unknown argument: ${token}` }]
          }
        } as const;
      }

      if (!recallStats && (recallStatsWorkspaceId !== null || recallStatsSince !== null || recallStatsUntil !== null)) {
        return {
          success: false,
          error: {
            issues: [{ path: [], message: "--workspace / --since / --until require --recall-stats." }]
          }
        } as const;
      }

      return {
        success: true,
        data: {
          agentTargets,
          recallStats,
          recallStatsWorkspaceId,
          recallStatsSince,
          recallStatsUntil
        }
      } as const;
    }
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
