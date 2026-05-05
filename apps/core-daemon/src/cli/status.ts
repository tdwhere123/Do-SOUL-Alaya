import type { TrustSummary } from "@do-soul/alaya-protocol";
import type { DaemonStartupStepRecord } from "../index.js";
import { ALAYA_SYSEXITS, type AlayaCliArgsSchema, type AlayaCliContext, type AlayaSubcommandSpec } from "./bridge.js";

export interface StatusCommandDependencies {
  readonly trustStateSummaryProvider: (agentTarget: string) => Promise<TrustSummary>;
  readonly resolveAgentTargets?: () => Promise<readonly string[]> | readonly string[];
  readonly getGardenStatus?: () => Promise<Readonly<{ last_pass_at: string | null }>>;
  readonly startupStepsProvider?: (
    context: Pick<AlayaCliContext, "daemon">
  ) => readonly DaemonStartupStepRecord[];
  readonly clock?: () => string;
}

interface StatusArgs {
  readonly agentTargets: readonly string[];
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

      const report: StatusReport = {
        checked_at: now(),
        daemon: {
          up: daemonUp,
          completed_steps: completedSteps,
          missing_steps: missingSteps
        },
        trust: trustSummaries,
        garden: gardenStatus
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
      for (let index = 0; index < input.length; index += 1) {
        const token = input[index];
        if (token !== "--agent") {
          return {
            success: false,
            error: {
              issues: [{ path: [index], message: "Unknown argument. Use --agent <target>." }]
            }
          } as const;
        }

        const value = input[index + 1];
        if (typeof value !== "string" || value.trim().length === 0) {
          return {
            success: false,
            error: { issues: [{ path: [index + 1], message: "Missing agent target value." }] }
          } as const;
        }

        agentTargets.push(value.trim());
        index += 1;
      }

      return {
        success: true,
        data: { agentTargets }
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
}
