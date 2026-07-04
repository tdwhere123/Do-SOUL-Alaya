import {
  NonEmptyStringSchema,
  TrustStateEventType,
  type ContextDeliveryRecord,
  type EventLogEntry,
  type TrustState,
  type UsageProofRecord
} from "@do-soul/alaya-protocol";

export type SummaryCounts = Readonly<{
  installed_count: number;
  configured_count: number;
  delivered_count: number;
  used_count: number;
  skipped_count: number;
  not_applicable_count: number;
  unverifiable_count: number;
}>;

export type TrustCounterName = "installed" | "configured" | "unverifiable";

export interface EventLogReader {
  queryByType(eventType: string): Promise<readonly EventLogEntry[]>;
}

export interface TrustCounterReplayRecorder {
  replayCounterIncrement(counterName: TrustCounterName, agentTarget: string): void;
}

export function collectCounts(
  deliveries: Iterable<Readonly<ContextDeliveryRecord>>,
  usageByDeliveryId: ReadonlyMap<string, Readonly<UsageProofRecord>>,
  seed: Readonly<{
    installed_count: number;
    configured_count: number;
    unverifiable_count: number;
  }>
): SummaryCounts & Readonly<{ last_delivery_at: string | null; last_usage_report_at: string | null }> {
  let deliveredCount = 0;
  const usageCounts = {
    usedCount: 0,
    skippedCount: 0,
    notApplicableCount: 0
  };
  let lastDeliveryAt: string | null = null;
  let lastUsageReportAt: string | null = null;

  for (const delivery of deliveries) {
    deliveredCount += 1;
    lastDeliveryAt = maxIso(lastDeliveryAt, delivery.delivered_at);

    const usage = usageByDeliveryId.get(delivery.delivery_id);
    if (usage === undefined) {
      continue;
    }

    recordUsageState(usageCounts, usage);
    lastUsageReportAt = maxIso(lastUsageReportAt, usage.reported_at);
  }

  return {
    installed_count: seed.installed_count,
    configured_count: seed.configured_count,
    delivered_count: deliveredCount,
    used_count: usageCounts.usedCount,
    skipped_count: usageCounts.skippedCount,
    not_applicable_count: usageCounts.notApplicableCount,
    unverifiable_count: seed.unverifiable_count,
    last_delivery_at: lastDeliveryAt,
    last_usage_report_at: lastUsageReportAt
  };
}

export function reduceTrustState(counts: SummaryCounts): TrustState {
  if (isInstalledOnlyState(counts)) {
    return "installed";
  }

  if (counts.configured_count > 0 && counts.delivered_count === 0) {
    return "configured";
  }

  if (hasDeliveryWithoutOutcome(counts)) {
    return "delivered";
  }

  if (counts.used_count > 0 && counts.skipped_count === 0) {
    return "used";
  }

  if (
    counts.skipped_count > 0 &&
    counts.used_count === 0 &&
    counts.not_applicable_count === 0
  ) {
    return "skipped";
  }

  if (
    counts.unverifiable_count > 0 &&
    counts.used_count === 0 &&
    counts.skipped_count === 0
  ) {
    return "unverifiable";
  }

  if (countOutcomeBuckets(counts) > 0) {
    return "mixed";
  }

  return "installed";
}

export async function rebuildCountersFromEventLog(
  eventLogReader: EventLogReader,
  recorder: TrustCounterReplayRecorder
): Promise<void> {
  for (const config of COUNTER_REPLAY_CONFIGS) {
    const events = await eventLogReader.queryByType(config.eventType);
    for (const event of events) {
      recorder.replayCounterIncrement(config.counterName, readAgentTarget(event));
    }
  }
}

const COUNTER_REPLAY_CONFIGS = [
  {
    eventType: TrustStateEventType.TRUST_STATE_INSTALLED_RECORDED,
    counterName: "installed"
  },
  {
    eventType: TrustStateEventType.TRUST_STATE_CONFIGURED_RECORDED,
    counterName: "configured"
  },
  {
    eventType: TrustStateEventType.TRUST_STATE_UNVERIFIABLE_RECORDED,
    counterName: "unverifiable"
  }
] as const satisfies readonly Readonly<{
  eventType: string;
  counterName: TrustCounterName;
}>[];

function readAgentTarget(event: Readonly<EventLogEntry>): string {
  const payloadTarget =
    typeof event.payload_json.agent_target === "string" ? event.payload_json.agent_target : null;
  return NonEmptyStringSchema.parse(payloadTarget ?? event.caused_by);
}

function maxIso(current: string | null, next: string): string {
  if (current === null) {
    return next;
  }

  return Date.parse(next) > Date.parse(current) ? next : current;
}

function recordUsageState(
  counts: {
    usedCount: number;
    skippedCount: number;
    notApplicableCount: number;
  },
  usage: Readonly<UsageProofRecord>
): void {
  switch (usage.usage_state) {
    case "used":
      counts.usedCount += 1;
      return;
    case "skipped":
      counts.skippedCount += 1;
      return;
    case "not_applicable":
      counts.notApplicableCount += 1;
  }
}

function isInstalledOnlyState(counts: SummaryCounts): boolean {
  return (
    (counts.delivered_count === 0 &&
      counts.configured_count === 0 &&
      counts.installed_count === 0) ||
    (counts.installed_count > 0 && counts.configured_count === 0)
  );
}

function hasDeliveryWithoutOutcome(counts: SummaryCounts): boolean {
  return (
    counts.delivered_count > 0 &&
    counts.used_count === 0 &&
    counts.skipped_count === 0 &&
    counts.not_applicable_count === 0 &&
    counts.unverifiable_count === 0
  );
}

function countOutcomeBuckets(counts: SummaryCounts): number {
  return [
    counts.used_count,
    counts.skipped_count,
    counts.not_applicable_count,
    counts.unverifiable_count
  ].filter((value) => value > 0).length;
}
