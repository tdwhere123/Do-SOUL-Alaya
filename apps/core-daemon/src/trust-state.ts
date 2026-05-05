import {
  ContextDeliveryRecordSchema,
  IsoDatetimeStringSchema,
  NonEmptyStringSchema,
  TrustStateEventType,
  TrustSummarySchema,
  type ContextDeliveryRecord,
  type EventLogEntry,
  type TrustSummary,
  type UsageProofRecord,
  UsageProofRecordSchema
} from "@do-soul/alaya-protocol";
import {
  collectCounts,
  reduceTrustState,
  type SummaryCounts,
  type TrustCounterName
} from "@do-soul/alaya-core";

const DEFAULT_WORKSPACE_ID = "trust-state";
const DEFAULT_REVISION = 0;
const DELIVERY_ENTITY_TYPE = "trust_context_delivery";
const USAGE_ENTITY_TYPE = "trust_usage_proof";
const COUNTER_ENTITY_TYPE = "trust_state_counter";
const PLACEHOLDER_AUDIT_EVENT_ID = "pending";

type TrustEventInput = Omit<EventLogEntry, "event_id" | "created_at">;

interface TrustStateEventPublisherPort {
  /**
   * Atomic append + sync mutation primitive (#BL-022). Trust-state migrated
   * to this in A2 so audit_event_id is captured inside the same SQLite
   * transaction as the delivery / usage row, eliminating the orphan-window
   * formerly registered as #BL-021.
   */
  appendManyWithMutation<T>(
    inputs: readonly TrustEventInput[],
    mutate: (entries: readonly EventLogEntry[]) => T
  ): Promise<T>;
}

export interface TrustStatePersistenceRepoPort {
  createDelivery(record: ContextDeliveryRecord): Promise<Readonly<ContextDeliveryRecord>>;
  /** Synchronous variant required by `appendManyWithMutation`-based recorder methods. */
  createDeliverySync(record: ContextDeliveryRecord): Readonly<ContextDeliveryRecord>;
  createUsage(record: UsageProofRecord): Promise<Readonly<UsageProofRecord>>;
  /** Synchronous variant required by `appendManyWithMutation`-based recorder methods. */
  createUsageSync(record: UsageProofRecord): Readonly<UsageProofRecord>;
  findDeliveryById(deliveryId: string): Promise<Readonly<ContextDeliveryRecord> | null>;
  listDeliveriesByAgentTarget(agentTarget: string): Promise<readonly Readonly<ContextDeliveryRecord>[]>;
  listUsageByDeliveryIds(deliveryIds: readonly string[]): Promise<readonly Readonly<UsageProofRecord>[]>;
}

export interface TrustStateRecorderDependencies {
  readonly eventPublisher: TrustStateEventPublisherPort;
  readonly repo?: TrustStatePersistenceRepoPort;
  readonly clock?: () => string;
  readonly ready?: boolean;
}

export class TrustStateRecorderNotReady extends Error {
  public constructor(message = "TrustStateRecorder is not ready.") {
    super(message);
    this.name = "TrustStateRecorderNotReady";
  }
}

export class TrustStateUnknownDeliveryError extends Error {
  // D2 codex-fixloop-B3 follow-up: classify as NOT_FOUND so the MCP handler
  // returns 404 (not 500 INTERNAL) for both legitimate unknown-delivery
  // and the cross-workspace mismatch (MERGED-B3) which throws the same
  // error. Both cases observably present as 404 — no information leak
  // between the two scenarios for an attacker probing delivery_ids.
  public readonly code = "NOT_FOUND" as const;
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
  private readonly repo: TrustStatePersistenceRepoPort;
  private readonly clock: () => string;
  private ready: boolean;

  // Counter maps are runtime projections. Daemon startup replays their
  // EventLog rows before markReady so status remains restart-stable.
  private readonly installedCountsByTarget = new Map<string, number>();
  private readonly configuredCountsByTarget = new Map<string, number>();
  private readonly unverifiableCountsByTarget = new Map<string, number>();

  public constructor(deps: TrustStateRecorderDependencies) {
    this.eventPublisher = deps.eventPublisher;
    this.repo = deps.repo ?? new InMemoryTrustStateRepo();
    this.clock = deps.clock ?? (() => new Date().toISOString());
    this.ready = deps.ready ?? false;
  }

  public markReady(): void {
    this.ready = true;
  }

  public replayCounterIncrement(counterName: TrustCounterName, agent_target: string): void {
    const target = NonEmptyStringSchema.parse(agent_target);

    switch (counterName) {
      case "installed":
        incrementCounter(this.installedCountsByTarget, target);
        break;
      case "configured":
        incrementCounter(this.configuredCountsByTarget, target);
        break;
      case "unverifiable":
        incrementCounter(this.unverifiableCountsByTarget, target);
        break;
    }
  }

  public async recordDelivery(
    input: Omit<ContextDeliveryRecord, "audit_event_id">
  ): Promise<ContextDeliveryRecord> {
    this.assertReady();

    const draftRecord = ContextDeliveryRecordSchema.parse({
      ...input,
      audit_event_id: PLACEHOLDER_AUDIT_EVENT_ID
    });
    return await this.eventPublisher.appendManyWithMutation(
      [
        {
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
        }
      ],
      (entries) => {
        // Atomic with the EventLog INSERT (#BL-022); audit_event_id is the
        // exact persisted event_id (#BL-021 closure).
        const auditEntry = entries[0];
        const finalRecord = ContextDeliveryRecordSchema.parse({
          ...draftRecord,
          audit_event_id: auditEntry.event_id
        });
        return this.repo.createDeliverySync(finalRecord);
      }
    );
  }

  public async recordUsage(
    input: Omit<UsageProofRecord, "audit_event_id">,
    options?: { readonly expectedWorkspaceId?: string }
  ): Promise<UsageProofRecord> {
    this.assertReady();

    const linkedDelivery = await this.repo.findDeliveryById(input.delivery_id);
    if (linkedDelivery === null) {
      throw new TrustStateUnknownDeliveryError(input.delivery_id);
    }

    // Cross-workspace guard (D2 MERGED-B3): when the caller supplies a
    // workspace context, refuse to record usage against a delivery from a
    // different workspace. Without this guard, an attached agent in
    // `attacker_ws` could call `soul.report_context_usage` with any
    // `delivery_id` it observed (e.g. via SSE) and write a
    // `MEMORY_USAGE_REPORTED` row that flows into A3 plasticity in
    // `victim_ws`. The error mirrors UnknownDelivery so cross-workspace
    // probes leak no observable difference vs unknown deliveries.
    if (
      options?.expectedWorkspaceId !== undefined &&
      linkedDelivery.workspace_id !== options.expectedWorkspaceId
    ) {
      throw new TrustStateUnknownDeliveryError(input.delivery_id);
    }

    const draftRecord = UsageProofRecordSchema.parse({
      ...input,
      audit_event_id: PLACEHOLDER_AUDIT_EVENT_ID
    });
    return await this.eventPublisher.appendManyWithMutation(
      [
        {
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
        }
      ],
      (entries) => {
        // Atomic with the EventLog INSERT (#BL-022); audit_event_id is the
        // exact persisted event_id (#BL-021 closure).
        const auditEntry = entries[0];
        const finalRecord = UsageProofRecordSchema.parse({
          ...draftRecord,
          audit_event_id: auditEntry.event_id
        });
        return this.repo.createUsageSync(finalRecord);
      }
    );
  }

  public async recordInstalled(agent_target: string): Promise<void> {
    this.assertReady();
    const target = NonEmptyStringSchema.parse(agent_target);
    await this.recordCounter({
      eventType: TrustStateEventType.TRUST_STATE_INSTALLED_RECORDED,
      counterName: "installed",
      target,
      mutate: () => {
        // Process-local counter; durable persistence is tracked by #BL-020.
        incrementCounter(this.installedCountsByTarget, target);
      }
    });
  }

  public async recordConfigured(agent_target: string): Promise<void> {
    this.assertReady();
    const target = NonEmptyStringSchema.parse(agent_target);
    await this.recordCounter({
      eventType: TrustStateEventType.TRUST_STATE_CONFIGURED_RECORDED,
      counterName: "configured",
      target,
      mutate: () => {
        // Process-local counter; durable persistence is tracked by #BL-020.
        incrementCounter(this.configuredCountsByTarget, target);
      }
    });
  }

  public async recordUnverifiable(agent_target: string, session_id: string): Promise<void> {
    this.assertReady();
    const target = NonEmptyStringSchema.parse(agent_target);
    const sessionId = NonEmptyStringSchema.parse(session_id);

    if ((await this.repo.listDeliveriesByAgentTarget(target)).length === 0) {
      throw new TrustStateUnverifiableRequiresDeliveryError(target);
    }

    await this.recordCounter({
      eventType: TrustStateEventType.TRUST_STATE_UNVERIFIABLE_RECORDED,
      counterName: "unverifiable",
      target,
      sessionId,
      mutate: () => {
        // Process-local counter; durable persistence is tracked by #BL-020.
        incrementCounter(this.unverifiableCountsByTarget, target);
      }
    });
  }

  public async summarize(agent_target: string): Promise<TrustSummary> {
    this.assertReady();
    const target = NonEmptyStringSchema.parse(agent_target);
    const deliveries = await this.repo.listDeliveriesByAgentTarget(target);
    const usages = await this.repo.listUsageByDeliveryIds(deliveries.map((delivery) => delivery.delivery_id));
    const usageByDeliveryId = new Map(usages.map((usage) => [usage.delivery_id, usage]));
    const counts: SummaryCounts & Readonly<{
      last_delivery_at: string | null;
      last_usage_report_at: string | null;
    }> = collectCounts(deliveries, usageByDeliveryId, {
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

  private async recordCounter(input: {
    readonly eventType:
      | typeof TrustStateEventType.TRUST_STATE_INSTALLED_RECORDED
      | typeof TrustStateEventType.TRUST_STATE_CONFIGURED_RECORDED
      | typeof TrustStateEventType.TRUST_STATE_UNVERIFIABLE_RECORDED;
    readonly counterName: "installed" | "configured" | "unverifiable";
    readonly target: string;
    readonly sessionId?: string;
    readonly mutate: () => void;
  }): Promise<void> {
    const recordedAt = this.nowIso();
    await this.eventPublisher.appendManyWithMutation(
      [
        {
          event_type: input.eventType,
          entity_type: COUNTER_ENTITY_TYPE,
          entity_id: `${input.target}:${input.counterName}`,
          workspace_id: DEFAULT_WORKSPACE_ID,
          run_id: null,
          caused_by: input.target,
          revision: DEFAULT_REVISION,
          payload_json: {
            agent_target: input.target,
            counter_name: input.counterName,
            session_id: input.sessionId ?? null,
            recorded_at: recordedAt
          }
        }
      ],
      () => {
        // Counter mutate is in-process map mutation, already synchronous.
        input.mutate();
      }
    );
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

class InMemoryTrustStateRepo implements TrustStatePersistenceRepoPort {
  private readonly deliveriesById = new Map<string, ContextDeliveryRecord>();
  private readonly usageByDeliveryId = new Map<string, UsageProofRecord>();

  public async createDelivery(record: ContextDeliveryRecord): Promise<Readonly<ContextDeliveryRecord>> {
    return this.createDeliverySync(record);
  }

  public createDeliverySync(record: ContextDeliveryRecord): Readonly<ContextDeliveryRecord> {
    const parsed = ContextDeliveryRecordSchema.parse(record);
    this.deliveriesById.set(parsed.delivery_id, parsed);
    return parsed;
  }

  public async createUsage(record: UsageProofRecord): Promise<Readonly<UsageProofRecord>> {
    return this.createUsageSync(record);
  }

  public createUsageSync(record: UsageProofRecord): Readonly<UsageProofRecord> {
    const parsed = UsageProofRecordSchema.parse(record);
    this.usageByDeliveryId.set(parsed.delivery_id, parsed);
    return parsed;
  }

  public async findDeliveryById(deliveryId: string): Promise<Readonly<ContextDeliveryRecord> | null> {
    return this.deliveriesById.get(NonEmptyStringSchema.parse(deliveryId)) ?? null;
  }

  public async listDeliveriesByAgentTarget(agentTarget: string): Promise<readonly Readonly<ContextDeliveryRecord>[]> {
    const target = NonEmptyStringSchema.parse(agentTarget);
    return [...this.deliveriesById.values()].filter((delivery) => delivery.agent_target === target);
  }

  public async listUsageByDeliveryIds(deliveryIds: readonly string[]): Promise<readonly Readonly<UsageProofRecord>[]> {
    return deliveryIds
      .map((deliveryId) => this.usageByDeliveryId.get(NonEmptyStringSchema.parse(deliveryId)))
      .filter((usage): usage is UsageProofRecord => usage !== undefined);
  }
}
