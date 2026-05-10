import {
  RecallContextEventType,
  parseRecallContextEventPayload,
  type EventLogEntry
} from "@do-soul/alaya-protocol";

// Agent targets excluded from agent-recall metrics. Inspector / CLI /
// tools-cli surfaces drive `soul.recall` for human-operated debugging
// and would inflate `total`, skew `miss_ratio`, and depress
// `follow_through_ratio` (no `report_context_usage` fires from those
// paths). `tools-cli` is the default agentTarget bound by `alaya tools
// call` (cli/tools.ts) — keep this set in sync with the human-reviewer
// surfaces guarded at handler boundaries.
const NON_AGENT_TARGETS: ReadonlySet<string> = new Set(["inspector", "cli", "tools-cli"]);

export interface RecallUtilizationStats {
  readonly window: Readonly<{
    readonly workspace_id: string;
    readonly since: string | null;
    readonly until: string | null;
    readonly excluded_agent_targets: readonly string[];
  }>;
  readonly recall: Readonly<{
    readonly total: number;
    readonly unique_sessions: number;
    readonly unique_runs: number;
    readonly null_run: number;
    readonly miss_count: number;
    readonly miss_ratio: number;
    readonly p50_pointer_count: number;
    readonly p50_latency_ms: number;
  }>;
  readonly usage: Readonly<{
    readonly total: number;
    readonly used: number;
    readonly skipped: number;
    readonly not_applicable: number;
    readonly used_ratio: number;
    /**
     * Approximation: total usage reports / total recalls. Can exceed 1.0
     * at window boundaries (a delivery emitted before the window can
     * receive its usage report inside the window) and under repeated
     * reports per delivery_id.
     */
    readonly follow_through_ratio: number;
  }>;
}

export interface RecallUtilizationService {
  /**
   * Aggregate agent-driven recall telemetry within a workspace + time
   * window. Inspector and CLI traffic is excluded by default so the
   * stats reflect what the attached CLI agents (Codex / Claude Code /
   * similar) actually do; pass `agentTargets` to override.
   */
  getStats(input: {
    readonly workspaceId: string;
    readonly since?: string | null;
    readonly until?: string | null;
    readonly excludeAgentTargets?: readonly string[];
  }): Promise<RecallUtilizationStats>;
}

export interface RecallUtilizationEventLogPort {
  queryByWorkspaceAndType(
    workspaceId: string,
    eventType: string,
    sinceIso?: string,
    untilIso?: string
  ): Promise<readonly EventLogEntry[]>;
}

export function createRecallUtilizationService(deps: {
  readonly eventLogRepo: RecallUtilizationEventLogPort;
}): RecallUtilizationService {
  return {
    async getStats({ workspaceId, since, until, excludeAgentTargets }) {
      const sinceArg = since ?? undefined;
      const untilArg = until ?? undefined;
      const exclusion = new Set(excludeAgentTargets ?? Array.from(NON_AGENT_TARGETS));
      const [deliveredRows, usageRows] = await Promise.all([
        deps.eventLogRepo.queryByWorkspaceAndType(
          workspaceId,
          RecallContextEventType.SOUL_RECALL_DELIVERED,
          sinceArg,
          untilArg
        ),
        deps.eventLogRepo.queryByWorkspaceAndType(
          workspaceId,
          RecallContextEventType.SOUL_CONTEXT_USAGE_REPORTED,
          sinceArg,
          untilArg
        )
      ]);

      const deliveredPayloads = deliveredRows
        .map((row) =>
          parseRecallContextEventPayload(
            RecallContextEventType.SOUL_RECALL_DELIVERED,
            row.payload_json as Record<string, unknown>
          )
        )
        .filter((payload) => !exclusion.has(payload.agent_target));
      const usagePayloads = usageRows
        .map((row) =>
          parseRecallContextEventPayload(
            RecallContextEventType.SOUL_CONTEXT_USAGE_REPORTED,
            row.payload_json as Record<string, unknown>
          )
        )
        .filter((payload) => !exclusion.has(payload.agent_target));

      const total = deliveredPayloads.length;
      const runIds = deliveredPayloads.map((payload) => payload.run_id);
      const uniqueSessions = new Set(deliveredPayloads.map((payload) => payload.session_id)).size;
      const uniqueRuns = new Set(runIds.filter((id): id is string => id !== null)).size;
      const nullRun = runIds.filter((id) => id === null).length;
      const pointerCounts = deliveredPayloads.map((payload) => payload.pointer_count);
      const latencies = deliveredPayloads.map((payload) => payload.latency_ms);
      const missCount = pointerCounts.filter((count) => count === 0).length;

      const totalUsage = usagePayloads.length;
      const used = usagePayloads.filter((payload) => payload.usage_state === "used").length;
      const skipped = usagePayloads.filter((payload) => payload.usage_state === "skipped").length;
      const notApplicable = usagePayloads.filter(
        (payload) => payload.usage_state === "not_applicable"
      ).length;

      return {
        window: {
          workspace_id: workspaceId,
          since: since ?? null,
          until: until ?? null,
          excluded_agent_targets: Array.from(exclusion).sort()
        },
        recall: {
          total,
          unique_sessions: uniqueSessions,
          unique_runs: uniqueRuns,
          null_run: nullRun,
          miss_count: missCount,
          miss_ratio: total === 0 ? 0 : missCount / total,
          p50_pointer_count: percentile50(pointerCounts),
          p50_latency_ms: percentile50(latencies)
        },
        usage: {
          total: totalUsage,
          used,
          skipped,
          not_applicable: notApplicable,
          used_ratio: used + skipped === 0 ? 0 : used / (used + skipped),
          follow_through_ratio: total === 0 ? 0 : totalUsage / total
        }
      };
    }
  };
}

function percentile50(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}
