import { CoreError } from "@do-soul/alaya-core";
import {
  ComputeRecallGardenEventType,
  RecallContextEventType,
  parseComputeRecallGardenEventPayload,
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
const EMBEDDING_LATENCY_BUCKETS: readonly Readonly<{ label: string; upperMs: number }>[] = [
  { label: "<=150ms", upperMs: 150 },
  { label: "<=300ms", upperMs: 300 },
  { label: "<=800ms", upperMs: 800 },
  { label: "<=1100ms", upperMs: 1100 },
  { label: ">1100ms", upperMs: Number.POSITIVE_INFINITY }
];

export interface RecallLatencyBucket {
  readonly label: string;
  readonly count: number;
}

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
  readonly embedding: Readonly<{
    readonly total_queries: number;
    readonly returned_candidate_count: number;
    readonly p50_latency_ms: number;
    readonly p95_latency_ms: number;
    readonly p99_latency_ms: number;
    readonly latency_buckets: readonly RecallLatencyBucket[];
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

type RecallDeliveredPayload = ReturnType<typeof parseSoulRecallDeliveredPayload>;
type RecallUsagePayload = ReturnType<typeof parseSoulContextUsagePayload>;
type EmbeddingSupplementPayload = ReturnType<typeof parseEmbeddingSupplementPayload>;

export function createRecallUtilizationService(deps: {
  readonly eventLogRepo: RecallUtilizationEventLogPort;
}): RecallUtilizationService {
  return {
    async getStats({ workspaceId, since, until, excludeAgentTargets }) {
      const exclusion = new Set(excludeAgentTargets ?? Array.from(NON_AGENT_TARGETS));
      const payloads = await loadRecallUtilizationPayloads(
        deps.eventLogRepo,
        workspaceId,
        since,
        until,
        exclusion
      );
      return {
        window: {
          workspace_id: workspaceId,
          since: since ?? null,
          until: until ?? null,
          excluded_agent_targets: Array.from(exclusion).sort()
        },
        recall: buildRecallStats(payloads.delivered),
        embedding: buildEmbeddingStats(payloads.embedding),
        usage: buildUsageStats(payloads.delivered.length, payloads.usage)
      };
    }
  };
}

async function loadRecallUtilizationPayloads(
  eventLogRepo: RecallUtilizationEventLogPort,
  workspaceId: string,
  since: string | null | undefined,
  until: string | null | undefined,
  exclusion: ReadonlySet<string>
) {
  const sinceArg = since ?? undefined;
  const untilArg = until ?? undefined;
  const [deliveredRows, usageRows, embeddingRows] = await Promise.all([
    eventLogRepo.queryByWorkspaceAndType(
      workspaceId,
      RecallContextEventType.SOUL_RECALL_DELIVERED,
      sinceArg,
      untilArg
    ),
    eventLogRepo.queryByWorkspaceAndType(
      workspaceId,
      RecallContextEventType.SOUL_CONTEXT_USAGE_REPORTED,
      sinceArg,
      untilArg
    ),
    eventLogRepo.queryByWorkspaceAndType(
      workspaceId,
      ComputeRecallGardenEventType.RECALL_EMBEDDING_SUPPLEMENT_QUERIED,
      sinceArg,
      untilArg
    )
  ]);

  return {
    delivered: parseRecallDeliveredRows(deliveredRows, exclusion),
    usage: parseRecallUsageRows(usageRows, exclusion),
    embedding: embeddingRows.map((row) => parseEmbeddingSupplementPayload(row))
  };
}

function parseRecallDeliveredRows(
  rows: readonly EventLogEntry[],
  exclusion: ReadonlySet<string>
): readonly RecallDeliveredPayload[] {
  return rows
    .map((row) => parseSoulRecallDeliveredPayload(row))
    .filter((payload) => !exclusion.has(payload.agent_target));
}

function parseRecallUsageRows(
  rows: readonly EventLogEntry[],
  exclusion: ReadonlySet<string>
): readonly RecallUsagePayload[] {
  return rows
    .map((row) => parseSoulContextUsagePayload(row))
    .filter((payload) => !exclusion.has(payload.agent_target));
}

function buildRecallStats(
  deliveredPayloads: readonly RecallDeliveredPayload[]
): RecallUtilizationStats["recall"] {
  const total = deliveredPayloads.length;
  const runIds = deliveredPayloads.map((payload) => payload.run_id);
  const pointerCounts = deliveredPayloads.map((payload) => payload.pointer_count);
  const latencies = deliveredPayloads.map((payload) => payload.latency_ms);
  const missCount = pointerCounts.filter((count) => count === 0).length;
  return {
    total,
    unique_sessions: new Set(deliveredPayloads.map((payload) => payload.session_id)).size,
    unique_runs: new Set(runIds.filter((id): id is string => id !== null)).size,
    null_run: runIds.filter((id) => id === null).length,
    miss_count: missCount,
    miss_ratio: total === 0 ? 0 : missCount / total,
    p50_pointer_count: percentile50(pointerCounts),
    p50_latency_ms: percentile50(latencies)
  };
}

function buildEmbeddingStats(
  embeddingPayloads: readonly EmbeddingSupplementPayload[]
): RecallUtilizationStats["embedding"] {
  const embeddingLatencies = embeddingPayloads.map((payload) => payload.latency_ms);
  return {
    total_queries: embeddingPayloads.length,
    returned_candidate_count: embeddingPayloads.reduce(
      (sum, payload) => sum + payload.returned_candidate_count,
      0
    ),
    p50_latency_ms: percentile50(embeddingLatencies),
    p95_latency_ms: percentileNearestRank(embeddingLatencies, 95),
    p99_latency_ms: percentileNearestRank(embeddingLatencies, 99),
    latency_buckets: bucketEmbeddingLatencies(embeddingLatencies)
  };
}

function buildUsageStats(
  totalDeliveries: number,
  usagePayloads: readonly RecallUsagePayload[]
): RecallUtilizationStats["usage"] {
  const used = usagePayloads.filter((payload) => payload.usage_state === "used").length;
  const skipped = usagePayloads.filter((payload) => payload.usage_state === "skipped").length;
  const notApplicable = usagePayloads.filter(
    (payload) => payload.usage_state === "not_applicable"
  ).length;
  return {
    total: usagePayloads.length,
    used,
    skipped,
    not_applicable: notApplicable,
    used_ratio: used + skipped === 0 ? 0 : used / (used + skipped),
    follow_through_ratio: totalDeliveries === 0 ? 0 : usagePayloads.length / totalDeliveries
  };
}

function parseSoulRecallDeliveredPayload(row: EventLogEntry) {
  try {
    return parseRecallContextEventPayload(
      RecallContextEventType.SOUL_RECALL_DELIVERED,
      toPayloadRecord(row)
    );
  } catch (error) {
    throw invalidRecallUtilizationPayload(row, error);
  }
}

function parseSoulContextUsagePayload(row: EventLogEntry) {
  try {
    return parseRecallContextEventPayload(
      RecallContextEventType.SOUL_CONTEXT_USAGE_REPORTED,
      toPayloadRecord(row)
    );
  } catch (error) {
    throw invalidRecallUtilizationPayload(row, error);
  }
}

function parseEmbeddingSupplementPayload(row: EventLogEntry) {
  try {
    return parseComputeRecallGardenEventPayload(
      ComputeRecallGardenEventType.RECALL_EMBEDDING_SUPPLEMENT_QUERIED,
      toPayloadRecord(row)
    );
  } catch (error) {
    throw invalidRecallUtilizationPayload(row, error);
  }
}

function toPayloadRecord(row: EventLogEntry): Record<string, unknown> {
  if (row.payload_json === null || typeof row.payload_json !== "object" || Array.isArray(row.payload_json)) {
    throw new CoreError("VALIDATION", `Event ${row.event_id} payload must be an object`);
  }

  return row.payload_json;
}

function invalidRecallUtilizationPayload(row: EventLogEntry, cause: unknown): CoreError {
  return new CoreError(
    "VALIDATION",
    `Invalid recall utilization EventLog payload for ${row.event_type}`,
    { cause }
  );
}

function percentile50(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function percentileNearestRank(values: readonly number[], percentile: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1)
  );
  return sorted[index]!;
}

function bucketEmbeddingLatencies(values: readonly number[]): readonly RecallLatencyBucket[] {
  const buckets = EMBEDDING_LATENCY_BUCKETS.map((bucket) => ({
    label: bucket.label,
    upperMs: bucket.upperMs,
    count: 0
  }));
  for (const value of values) {
    const bucket = buckets.find((candidate) => value <= candidate.upperMs) ?? buckets[buckets.length - 1]!;
    bucket.count += 1;
  }
  return buckets.map(({ label, count }) => Object.freeze({ label, count }));
}
