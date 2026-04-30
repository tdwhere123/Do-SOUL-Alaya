import {
  ContextDeliveryRecordSchema,
  IsoDatetimeStringSchema,
  NonEmptyStringSchema,
  TrustStateEventType,
  TrustSummarySchema,
  type ContextDeliveryRecord,
  type EventLogEntry,
  type TrustState,
  type TrustSummary,
  type UsageProofRecord,
  UsageProofRecordSchema
} from "@do-soul/alaya-protocol";

const DEFAULT_WORKSPACE_ID = "trust-state";
const DEFAULT_REVISION = 0;
const DELIVERY_ENTITY_TYPE = "trust_context_delivery";
const USAGE_ENTITY_TYPE = "trust_usage_proof";
const PLACEHOLDER_AUDIT_EVENT_ID = "pending";

type TrustEventInput = Omit<EventLogEntry, "event_id" | "created_at">;

interface TrustStateEventPublisherPort {
  publish(input: TrustEventInput): Promise<Readonly<EventLogEntry>>;
}

export interface TrustStateRecorderDependencies {
  readonly eventPublisher: TrustStateEventPublisherPort;
  readonly clock?: () => string;
  readonly ready?: boolean;
}

type SummaryCounts = Readonly<{
  installed_count: number;
  configured_count: number;
  delivered_count: number;
  used_count: number;
  skipped_count: number;
  not_applicable_count: number;
  unverifiable_count: number;
}>;

export class TrustStateRecorderNotReady extends Error {
  public constructor(message = "TrustStateRecorder is not ready.") {
    super(message);
    this.name = "TrustStateRecorderNotReady";
  }
}

export class TrustStateUnknownDeliveryError extends Error {
  public constructor(public readonly deliveryId: string) {
    super(`Unknown delivery_id: ${deliveryId}`);
    this.name = "TrustStateUnknownDeliveryError";
  }
}

export class TrustStateUnverifiableRequiresDeliveryError extends Error {
  public constructor(public readonly agentTarget: string) {
    super(`Cannot record unverifiable trust state without prior delivery for agent ${agentTarget}.`);
    this.name = "TrustStateUnverifiableRequiresDeliveryError";
  }
}

export class TrustStateRecorder {
  private readonly eventPublisher: TrustStateEventPublisherPort;
  private readonly clock: () => string;
  private ready: boolean;

  private readonly deliveriesById = new Map<string, ContextDeliveryRecord>();
  private readonly usageByDeliveryId = new Map<string, UsageProofRecord>();
  private readonly installedCountsByTarget = new Map<string, number>();
  private readonly configuredCountsByTarget = new Map<string, number>();
  private readonly unverifiableCountsByTarget = new Map<string, number>();

  public constructor(deps: TrustStateRecorderDependencies) {
    this.eventPublisher = deps.eventPublisher;
    this.clock = deps.clock ?? (() => new Date().toISOString());
    this.ready = deps.ready ?? false;
  }

  public markReady(): void {
    this.ready = true;
  }

  public async recordDelivery(
    input: Omit<ContextDeliveryRecord, "audit_event_id">
  ): Promise<ContextDeliveryRecord> {
    this.assertReady();

    const draftRecord = ContextDeliveryRecordSchema.parse({
      ...input,
      audit_event_id: PLACEHOLDER_AUDIT_EVENT_ID
    });
    const auditEntry = await this.eventPublisher.publish({
      event_type: TrustStateEventType.MEMORY_DELIVERED,
      entity_type: DELIVERY_ENTITY_TYPE,
      entity_id: draftRecord.delivery_id,
      workspace_id: resolveWorkspaceId(draftRecord.workspace_id),
      run_id: draftRecord.run_id,
      caused_by: draftRecord.agent_target,
      revision: DEFAULT_REVISION,
      payload_json: {
        delivery_id: draftRecord.delivery_id,
        agent_target: draftRecord.agent_target,
        delivered_object_ids: draftRecord.delivered_object_ids,
        delivered_at: draftRecord.delivered_at,
        recorded_at: this.nowIso()
      }
    });

    const finalRecord = ContextDeliveryRecordSchema.parse({
      ...draftRecord,
      audit_event_id: auditEntry.event_id
    });
    this.deliveriesById.set(finalRecord.delivery_id, finalRecord);
    return finalRecord;
  }

  public async recordUsage(
    input: Omit<UsageProofRecord, "audit_event_id">
  ): Promise<UsageProofRecord> {
    this.assertReady();

    const linkedDelivery = this.deliveriesById.get(input.delivery_id);
    if (linkedDelivery === undefined) {
      throw new TrustStateUnknownDeliveryError(input.delivery_id);
    }

    const draftRecord = UsageProofRecordSchema.parse({
      ...input,
      audit_event_id: PLACEHOLDER_AUDIT_EVENT_ID
    });
    const auditEntry = await this.eventPublisher.publish({
      event_type: TrustStateEventType.MEMORY_USAGE_REPORTED,
      entity_type: USAGE_ENTITY_TYPE,
      entity_id: draftRecord.delivery_id,
      workspace_id: resolveWorkspaceId(linkedDelivery.workspace_id),
      run_id: linkedDelivery.run_id,
      caused_by: linkedDelivery.agent_target,
      revision: DEFAULT_REVISION,
      payload_json: {
        delivery_id: draftRecord.delivery_id,
        usage_state: draftRecord.usage_state,
        used_object_ids: draftRecord.used_object_ids,
        reason: draftRecord.reason,
        reported_at: draftRecord.reported_at,
        recorded_at: this.nowIso()
      }
    });

    const finalRecord = UsageProofRecordSchema.parse({
      ...draftRecord,
      audit_event_id: auditEntry.event_id
    });
    this.usageByDeliveryId.set(finalRecord.delivery_id, finalRecord);
    return finalRecord;
  }

  public async recordInstalled(agent_target: string): Promise<void> {
    this.assertReady();
    const target = NonEmptyStringSchema.parse(agent_target);
    incrementCounter(this.installedCountsByTarget, target);
  }

  public async recordConfigured(agent_target: string): Promise<void> {
    this.assertReady();
    const target = NonEmptyStringSchema.parse(agent_target);
    incrementCounter(this.configuredCountsByTarget, target);
  }

  public async recordUnverifiable(agent_target: string, session_id: string): Promise<void> {
    this.assertReady();
    const target = NonEmptyStringSchema.parse(agent_target);
    NonEmptyStringSchema.parse(session_id);

    if (!hasDeliveryForTarget(this.deliveriesById.values(), target)) {
      throw new TrustStateUnverifiableRequiresDeliveryError(target);
    }

    incrementCounter(this.unverifiableCountsByTarget, target);
  }

  public async summarize(agent_target: string): Promise<TrustSummary> {
    this.assertReady();
    const target = NonEmptyStringSchema.parse(agent_target);
    const counts = collectCounts(this.deliveriesById.values(), this.usageByDeliveryId, target, {
      installed_count: this.installedCountsByTarget.get(target) ?? 0,
      configured_count: this.configuredCountsByTarget.get(target) ?? 0,
      unverifiable_count: this.unverifiableCountsByTarget.get(target) ?? 0
    });

    return TrustSummarySchema.parse({
      agent_target: target,
      state: reduceTrustState(counts),
      installed_count: counts.installed_count,
      configured_count: counts.configured_count,
      delivered_count: counts.delivered_count,
      used_count: counts.used_count,
      skipped_count: counts.skipped_count,
      not_applicable_count: counts.not_applicable_count,
      unverifiable_count: counts.unverifiable_count,
      last_delivery_at: counts.last_delivery_at,
      last_usage_report_at: counts.last_usage_report_at
    });
  }

  private assertReady(): void {
    if (!this.ready) {
      throw new TrustStateRecorderNotReady();
    }
  }

  private nowIso(): string {
    return IsoDatetimeStringSchema.parse(this.clock());
  }
}

export function createTrustStateRecorder(deps: TrustStateRecorderDependencies): TrustStateRecorder {
  return new TrustStateRecorder(deps);
}

function resolveWorkspaceId(workspaceId: string | null): string {
  return workspaceId ?? DEFAULT_WORKSPACE_ID;
}

function incrementCounter(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function hasDeliveryForTarget(
  deliveries: IterableIterator<ContextDeliveryRecord>,
  agentTarget: string
): boolean {
  for (const delivery of deliveries) {
    if (delivery.agent_target === agentTarget) {
      return true;
    }
  }
  return false;
}

function collectCounts(
  deliveries: IterableIterator<ContextDeliveryRecord>,
  usageByDeliveryId: ReadonlyMap<string, UsageProofRecord>,
  agentTarget: string,
  seed: Readonly<{
    installed_count: number;
    configured_count: number;
    unverifiable_count: number;
  }>
): SummaryCounts & Readonly<{ last_delivery_at: string | null; last_usage_report_at: string | null }> {
  let deliveredCount = 0;
  let usedCount = 0;
  let skippedCount = 0;
  let notApplicableCount = 0;
  let lastDeliveryAt: string | null = null;
  let lastUsageReportAt: string | null = null;

  for (const delivery of deliveries) {
    if (delivery.agent_target !== agentTarget) {
      continue;
    }

    deliveredCount += 1;
    lastDeliveryAt = maxIso(lastDeliveryAt, delivery.delivered_at);

    const usage = usageByDeliveryId.get(delivery.delivery_id);
    if (usage === undefined) {
      continue;
    }

    switch (usage.usage_state) {
      case "used":
        usedCount += 1;
        break;
      case "skipped":
        skippedCount += 1;
        break;
      case "not_applicable":
        notApplicableCount += 1;
        break;
    }

    lastUsageReportAt = maxIso(lastUsageReportAt, usage.reported_at);
  }

  return {
    installed_count: seed.installed_count,
    configured_count: seed.configured_count,
    delivered_count: deliveredCount,
    used_count: usedCount,
    skipped_count: skippedCount,
    not_applicable_count: notApplicableCount,
    unverifiable_count: seed.unverifiable_count,
    last_delivery_at: lastDeliveryAt,
    last_usage_report_at: lastUsageReportAt
  };
}

function reduceTrustState(counts: SummaryCounts): TrustState {
  if (
    counts.delivered_count === 0 &&
    counts.configured_count === 0 &&
    counts.installed_count === 0
  ) {
    return "installed";
  }

  if (counts.installed_count > 0 && counts.configured_count === 0) {
    return "installed";
  }

  if (counts.configured_count > 0 && counts.delivered_count === 0) {
    return "configured";
  }

  if (
    counts.delivered_count > 0 &&
    counts.used_count === 0 &&
    counts.skipped_count === 0 &&
    counts.not_applicable_count === 0 &&
    counts.unverifiable_count === 0
  ) {
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

  const outcomes = [
    counts.used_count,
    counts.skipped_count,
    counts.not_applicable_count,
    counts.unverifiable_count
  ].filter((value) => value > 0).length;

  if (outcomes >= 2) {
    return "mixed";
  }

  if (outcomes > 0) {
    return "mixed";
  }

  return "installed";
}

function maxIso(current: string | null, next: string): string {
  if (current === null) {
    return next;
  }

  return Date.parse(next) > Date.parse(current) ? next : current;
}
