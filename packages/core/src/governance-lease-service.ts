import { randomUUID } from "node:crypto";
import {
  ControlPlaneObjectKind,
  GovernanceLeasePiercingConditionKind as GovernanceLeasePiercingConditionKindValue,
  GovernanceLeaseSchema,
  GovernanceLeasePiercingConditionKindSchema,
  GreenGovernanceEventType,
  RetentionPolicy,
  SoulGovernanceLeaseAcquiredPayloadSchema,
  SoulGovernanceLeaseReleasedPayloadSchema,
  SoulGovernanceLeasePiercedPayloadSchema,
  type EventLogEntry,
  type GovernanceLease,
  type GovernanceLeasePiercingConditionKind,
  type GreenGovernanceEventTypeValue,
  type PiercingCondition
} from "@do-soul/alaya-protocol";
import { CoreError } from "./errors.js";
import { SYSTEM_ACTOR } from "./shared/actors.js";
import { addDuration, readNow } from "./shared/time.js";
import { normalizeOptionalNonEmptyString, parseNonEmptyString } from "./shared/validators.js";

const LEASE_DURATION_MS = 5 * 60 * 1000;

const HIGH_SIGNAL_PIERCING_CONDITIONS: readonly Readonly<PiercingCondition>[] = Object.freeze([
  Object.freeze({
    condition_kind: GovernanceLeasePiercingConditionKindValue.UNSUBMITTED_CHANGES,
    description: "Critical unsubmitted changes persist across run boundaries"
  }),
  Object.freeze({
    condition_kind: GovernanceLeasePiercingConditionKindValue.SEVERE_DIAGNOSTIC_JUMP,
    description: "Diagnostic severity jumped 2+ levels"
  }),
  Object.freeze({
    condition_kind: GovernanceLeasePiercingConditionKindValue.EXPLICIT_LIFECYCLE_EVENT,
    description: "Explicit lifecycle action: commit, branch switch, or session end"
  })
]);

export interface GovernanceLeaseServiceEventLogPort {
  append(entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry | Promise<EventLogEntry>;
  queryByEntity(entityType: string, entityId: string): Promise<readonly EventLogEntry[]>;
  queryByRun(runId: string): Promise<readonly EventLogEntry[]>;
}

export interface GovernanceLeaseServiceDependencies {
  readonly eventLogRepo: GovernanceLeaseServiceEventLogPort;
  readonly generateRuntimeId?: () => string;
  readonly now?: () => string;
}

/**
 * Governance leases are ephemeral control-plane objects in Phase 3B.
 * The in-memory store is a cache over EventLog-backed truth so leases can be
 * reconstructed after daemon restart.
 */
export class GovernanceLeaseService {
  private readonly store = new Map<string, StoredLease>();
  private readonly pendingLoads = new Map<string, Promise<StoredLease | null>>();
  private readonly cacheVersions = new Map<string, number>();
  private readonly generateRuntimeId: () => string;

  public constructor(private readonly dependencies: GovernanceLeaseServiceDependencies) {
    this.generateRuntimeId = dependencies.generateRuntimeId ?? (() => randomUUID());
  }

  public async acquire(params: {
    readonly runId: string;
    readonly workspaceId: string;
    readonly turnId?: string;
    readonly expiresAt?: string;
  }): Promise<Readonly<GovernanceLease>> {
    const occurredAt = readNow(this.dependencies.now);
    const runId = parseNonEmptyString(params.runId, "runId");
    const workspaceId = parseNonEmptyString(params.workspaceId, "workspaceId");
    const runtimeId = this.generateRuntimeId();
    const expiresAt = normalizeExpiresAt(params.expiresAt ?? addDuration(occurredAt, LEASE_DURATION_MS));
    const turnId = normalizeOptionalNonEmptyString(params.turnId);
    const lease = parseGovernanceLease({
      runtime_id: runtimeId,
      object_kind: ControlPlaneObjectKind.GOVERNANCE_LEASE,
      task_surface_ref: null,
      expires_at: expiresAt,
      derived_from: null,
      retention_policy: RetentionPolicy.SESSION_ONLY,
      lease_id: runtimeId,
      holder: buildHolder(runId, turnId ?? runtimeId),
      piercing_conditions: HIGH_SIGNAL_PIERCING_CONDITIONS
    });

    this.clearExpiredAt(occurredAt);
    await this.dependencies.eventLogRepo.append({
      event_type: GreenGovernanceEventType.SOUL_GOVERNANCE_LEASE_ACQUIRED,
      entity_type: "governance_lease",
      entity_id: lease.runtime_id,
      workspace_id: workspaceId,
      run_id: runId,
      caused_by: SYSTEM_ACTOR,
      payload_json: SoulGovernanceLeaseAcquiredPayloadSchema.parse({
        lease_id: lease.lease_id,
        holder: lease.holder,
        run_id: runId,
        expires_at: lease.expires_at,
        occurred_at: occurredAt
      })
    });

    this.bumpCacheVersion(runId);
    this.store.set(runId, { lease, workspaceId });
    return lease;
  }

  public async release(runId: string): Promise<void> {
    const parsedRunId = parseNonEmptyString(runId, "runId");
    const active = await this.resolveStoredLease(parsedRunId);

    if (active === null) {
      this.bumpCacheVersion(parsedRunId);
      this.store.delete(parsedRunId);
      this.clearCacheMetadataIfIdle(parsedRunId);
      return;
    }

    const occurredAt = readNow(this.dependencies.now);
    await this.dependencies.eventLogRepo.append({
      event_type: GreenGovernanceEventType.SOUL_GOVERNANCE_LEASE_RELEASED,
      entity_type: "governance_lease",
      entity_id: active.lease.runtime_id,
      workspace_id: active.workspaceId,
      run_id: parsedRunId,
      caused_by: SYSTEM_ACTOR,
      payload_json: SoulGovernanceLeaseReleasedPayloadSchema.parse({
        lease_id: active.lease.lease_id,
        run_id: parsedRunId,
        occurred_at: occurredAt
      })
    });

    this.bumpCacheVersion(parsedRunId);
    this.store.delete(parsedRunId);
    this.clearCacheMetadataIfIdle(parsedRunId);
  }

  public async pierce(params: {
    readonly runId: string;
    readonly conditionKind: string;
    readonly description: string;
    readonly workspaceId: string;
  }): Promise<void> {
    const runId = parseNonEmptyString(params.runId, "runId");
    const workspaceId = parseNonEmptyString(params.workspaceId, "workspaceId");
    const conditionKind = parseConditionKind(params.conditionKind);
    parseNonEmptyString(params.description, "description");
    const active = await this.getActive(runId);

    if (active === null) {
      return;
    }

    const occurredAt = readNow(this.dependencies.now);
    await this.dependencies.eventLogRepo.append({
      event_type: GreenGovernanceEventType.SOUL_GOVERNANCE_LEASE_PIERCED,
      entity_type: "governance_lease",
      entity_id: active.runtime_id,
      workspace_id: workspaceId,
      run_id: runId,
      caused_by: SYSTEM_ACTOR,
      payload_json: SoulGovernanceLeasePiercedPayloadSchema.parse({
        lease_id: active.lease_id,
        piercing_condition_kind: conditionKind,
        run_id: runId,
        occurred_at: occurredAt
      })
    });

    this.bumpCacheVersion(runId);
    this.store.delete(runId);
    this.clearCacheMetadataIfIdle(runId);
  }

  public async isHeld(runId: string): Promise<boolean> {
    return (await this.getActive(runId)) !== null;
  }

  public async getActive(runId: string): Promise<Readonly<GovernanceLease> | null> {
    const parsedRunId = normalizeOptionalNonEmptyString(runId);

    if (parsedRunId === null) {
      return null;
    }

    return (await this.resolveStoredLease(parsedRunId))?.lease ?? null;
  }

  public clearExpired(): void {
    this.clearExpiredAt(readNow(this.dependencies.now));
  }

  private clearExpiredAt(referenceTime: string): void {
    for (const [runId, stored] of this.store.entries()) {
      if (isExpired(stored.lease.expires_at, referenceTime)) {
        this.bumpCacheVersion(runId);
        this.store.delete(runId);
        this.clearCacheMetadataIfIdle(runId);
      }
    }
  }

  private async resolveStoredLease(runId: string): Promise<StoredLease | null> {
    const referenceTime = readNow(this.dependencies.now);
    const cached = this.store.get(runId) ?? null;

    if (cached !== null) {
      if (isExpired(cached.lease.expires_at, referenceTime)) {
        this.bumpCacheVersion(runId);
        this.store.delete(runId);
        this.clearCacheMetadataIfIdle(runId);
        return null;
      }

      return cached;
    }

    const pending = this.pendingLoads.get(runId);

    if (pending !== undefined) {
      return pending;
    }

    const versionBeforeLoad = this.getCacheVersion(runId);
    const loadPromise = this.rehydrateFromEventLog(runId)
      .then((rehydrated) => {
        const normalized =
          rehydrated !== null && isExpired(rehydrated.lease.expires_at, referenceTime)
            ? null
            : rehydrated;

        if (this.getCacheVersion(runId) !== versionBeforeLoad) {
          // A concurrent acquire/release already updated process-local truth.
          return this.store.get(runId) ?? null;
        }

        const cachedAfterLoad = this.store.get(runId) ?? null;

        if (cachedAfterLoad !== null) {
          return cachedAfterLoad;
        }

        if (normalized !== null) {
          this.store.set(runId, normalized);
        }

        return normalized;
      })
      .finally(() => {
        if (this.pendingLoads.get(runId) === loadPromise) {
          this.pendingLoads.delete(runId);
        }

        this.clearCacheMetadataIfIdle(runId);
      });

    this.pendingLoads.set(runId, loadPromise);
    return loadPromise;
  }

  private async rehydrateFromEventLog(runId: string): Promise<StoredLease | null> {
    const events = await this.dependencies.eventLogRepo.queryByRun(runId);
    let active: StoredLease | null = null;

    for (const event of events) {
      if (event.entity_type !== "governance_lease") {
        continue;
      }

      if (event.event_type === GreenGovernanceEventType.SOUL_GOVERNANCE_LEASE_ACQUIRED) {
        const parsed = parsePersistedGovernanceLeasePayload(
          SoulGovernanceLeaseAcquiredPayloadSchema,
          event,
          GreenGovernanceEventType.SOUL_GOVERNANCE_LEASE_ACQUIRED
        );

        active = {
          workspaceId: event.workspace_id,
          lease: parseGovernanceLease({
            runtime_id: parsed.lease_id,
            object_kind: ControlPlaneObjectKind.GOVERNANCE_LEASE,
            task_surface_ref: null,
            expires_at: parsed.expires_at,
            derived_from: null,
            retention_policy: RetentionPolicy.SESSION_ONLY,
            lease_id: parsed.lease_id,
            holder: parsed.holder,
            piercing_conditions: HIGH_SIGNAL_PIERCING_CONDITIONS
          })
        };
        continue;
      }

      if (event.event_type === GreenGovernanceEventType.SOUL_GOVERNANCE_LEASE_RELEASED) {
        const parsed = parsePersistedGovernanceLeasePayload(
          SoulGovernanceLeaseReleasedPayloadSchema,
          event,
          GreenGovernanceEventType.SOUL_GOVERNANCE_LEASE_RELEASED
        );
        if (active?.lease.lease_id === parsed.lease_id) {
          active = null;
        }
        continue;
      }

      if (event.event_type === GreenGovernanceEventType.SOUL_GOVERNANCE_LEASE_PIERCED) {
        const parsed = parsePersistedGovernanceLeasePayload(
          SoulGovernanceLeasePiercedPayloadSchema,
          event,
          GreenGovernanceEventType.SOUL_GOVERNANCE_LEASE_PIERCED
        );
        if (active?.lease.lease_id === parsed.lease_id) {
          active = null;
        }
      }
    }

    return active;
  }

  private getCacheVersion(runId: string): number {
    return this.cacheVersions.get(runId) ?? 0;
  }

  private bumpCacheVersion(runId: string): void {
    this.cacheVersions.set(runId, this.getCacheVersion(runId) + 1);
  }

  private clearCacheMetadataIfIdle(runId: string): void {
    if (!this.store.has(runId) && !this.pendingLoads.has(runId)) {
      this.cacheVersions.delete(runId);
    }
  }
}

interface StoredLease {
  readonly lease: Readonly<GovernanceLease>;
  readonly workspaceId: string;
}

function parseGovernanceLease(value: GovernanceLease): Readonly<GovernanceLease> {
  try {
    return Object.freeze(GovernanceLeaseSchema.parse(value));
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid governance lease payload", { cause: error });
  }
}

function parsePersistedGovernanceLeasePayload<T>(
  schema: {
    parse(value: unknown): T;
  },
  event: Readonly<EventLogEntry>,
  eventType: GreenGovernanceEventTypeValue
): T {
  try {
    return schema.parse(event.payload_json);
  } catch (error) {
    throw new CoreError(
      "CONFLICT",
      `Malformed ${eventType} payload persisted at ${event.event_id}.`,
      { cause: error instanceof Error ? error : undefined }
    );
  }
}

function buildHolder(runId: string, turnId: string): string {
  return `run:${runId}:turn:${turnId}`;
}

function parseConditionKind(value: string): GovernanceLeasePiercingConditionKind {
  try {
    return GovernanceLeasePiercingConditionKindSchema.parse(parseNonEmptyString(value, "conditionKind"));
  } catch (error) {
    throw new CoreError("VALIDATION", "conditionKind must be a supported governance lease piercing condition", {
      cause: error
    });
  }
}

function normalizeExpiresAt(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  return readNow(() => value, "expiresAt");
}

function isExpired(expiresAt: string | null, referenceTime: string): boolean {
  if (expiresAt === null) {
    return false;
  }

  return Date.parse(expiresAt) <= Date.parse(referenceTime);
}
