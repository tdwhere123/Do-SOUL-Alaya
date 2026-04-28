import { randomUUID } from "node:crypto";
import {
  ControlPlaneObjectKind,
  Phase0EventType,
  Phase3BEventType,
  RetentionPolicy,
  RunMessageAppendedPayloadSchema,
  SessionOverrideSchema,
  SoulSessionOverrideAppliedPayloadSchema,
  type EventLogEntry,
  type SessionOverride
} from "@do-what/protocol";
import { CoreError } from "./errors.js";
import { getNextRevision } from "./shared/event-utils.js";
import { parseNonEmptyString } from "./shared/validators.js";

export interface SessionOverrideServiceEventLogPort {
  append(entry: Omit<EventLogEntry, "event_id" | "created_at">): Promise<EventLogEntry>;
  queryByEntity(entityType: string, entityId: string): Promise<readonly EventLogEntry[]>;
  queryByRun(runId: string): Promise<readonly EventLogEntry[]>;
}

export interface SessionOverrideServiceDependencies {
  readonly eventLogRepo: SessionOverrideServiceEventLogPort;
  readonly generateRuntimeId?: () => string;
  readonly now?: () => string;
}

/**
 * Session overrides are ephemeral control-plane objects in Phase 3B.
 * The in-memory store is a cache over EventLog-backed truth so overrides can
 * be reconstructed after daemon restart.
 */
export class SessionOverrideService {
  private readonly store: Map<string, readonly Readonly<SessionOverride>[]> = new Map();
  private readonly pendingLoads = new Map<string, Promise<readonly Readonly<SessionOverride>[]>>();
  private readonly cacheVersions = new Map<string, number>();
  private readonly generateRuntimeId: () => string;
  private readonly now: () => string;

  public constructor(private readonly dependencies: SessionOverrideServiceDependencies) {
    this.generateRuntimeId = dependencies.generateRuntimeId ?? (() => randomUUID());
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  public async apply(params: {
    readonly runId: string;
    readonly workspaceId: string;
    readonly targetObject: string;
    readonly correction: string;
    readonly priority?: number;
    readonly expiresAt?: string;
    readonly derivedFrom?: string | null;
  }): Promise<Readonly<SessionOverride>> {
    const occurredAt = this.now();
    const runId = parseNonEmptyString(params.runId, "runId");
    const workspaceId = parseNonEmptyString(params.workspaceId, "workspaceId");
    const targetObject = parseNonEmptyString(params.targetObject, "targetObject");
    const correction = parseNonEmptyString(params.correction, "correction");
    const priority = parsePriority(params.priority ?? 0);
    const expiresAt = normalizeExpiresAt(params.expiresAt ?? addHours(occurredAt, 1));
    const derivedFrom = await this.resolveDerivedFrom(runId, params.derivedFrom);
    const existing = await this.resolveStoredOverrides(runId);

    const override = parseSessionOverride({
      runtime_id: this.generateRuntimeId(),
      object_kind: ControlPlaneObjectKind.SESSION_OVERRIDE,
      task_surface_ref: null,
      expires_at: expiresAt,
      derived_from: derivedFrom,
      retention_policy: RetentionPolicy.SESSION_ONLY,
      scope: "session_only",
      target_object: targetObject,
      correction,
      priority
    });

    const revision = await getNextRevision(this.dependencies.eventLogRepo, "session_override", override.runtime_id);
    await this.dependencies.eventLogRepo.append({
      event_type: Phase3BEventType.SOUL_SESSION_OVERRIDE_APPLIED,
      entity_type: "session_override",
      entity_id: override.runtime_id,
      workspace_id: workspaceId,
      run_id: runId,
      caused_by: "user_action",
      revision,
      payload_json: SoulSessionOverrideAppliedPayloadSchema.parse({
        override_id: override.runtime_id,
        target_object: override.target_object,
        correction: override.correction,
        priority: override.priority,
        run_id: runId,
        expires_at: override.expires_at,
        derived_from: override.derived_from,
        occurred_at: occurredAt
      })
    });

    this.clearExpiredAt(occurredAt);
    this.bumpCacheVersion(runId);
    this.store.set(runId, Object.freeze([...existing, override].sort(compareOverrides)));

    return override;
  }

  public async getActiveFor(runId: string): Promise<readonly Readonly<SessionOverride>[]> {
    const parsedRunId = runId.trim();

    if (parsedRunId.length === 0) {
      return Object.freeze([]);
    }

    return this.resolveStoredOverrides(parsedRunId);
  }

  public clearRun(runId: string): void {
    const parsedRunId = runId.trim();

    if (parsedRunId.length === 0) {
      return;
    }

    this.bumpCacheVersion(parsedRunId);
    this.store.delete(parsedRunId);
    this.clearCacheMetadataIfIdle(parsedRunId);
  }

  public clearExpired(): void {
    this.clearExpiredAt(this.now());
  }

  private async resolveDerivedFrom(
    runId: string,
    explicitDerivedFrom: string | null | undefined
  ): Promise<string | null> {
    if (explicitDerivedFrom !== undefined) {
      const trimmed = explicitDerivedFrom?.trim() ?? "";
      return trimmed.length === 0 ? null : trimmed;
    }

    const events = await this.dependencies.eventLogRepo.queryByRun(runId);

    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];

      if (event.event_type !== Phase0EventType.RUN_MESSAGE_APPENDED) {
        continue;
      }

      const parsed = RunMessageAppendedPayloadSchema.safeParse(event.payload_json);

      if (parsed.success && parsed.data.role === "user") {
        return parsed.data.message_id;
      }
    }

    return null;
  }

  private clearExpiredAt(referenceTime: string): void {
    for (const [runId, overrides] of this.store.entries()) {
      const active = overrides.filter((override) => !isExpired(override.expires_at, referenceTime));

      if (active.length === 0) {
        this.bumpCacheVersion(runId);
        this.store.delete(runId);
        this.clearCacheMetadataIfIdle(runId);
        continue;
      }

      if (active.length !== overrides.length) {
        this.bumpCacheVersion(runId);
        this.store.set(runId, Object.freeze(active));
      }
    }
  }

  private async resolveStoredOverrides(runId: string): Promise<readonly Readonly<SessionOverride>[]> {
    const referenceTime = this.now();
    const cached = this.store.get(runId);

    if (cached !== undefined) {
      return this.normalizeStoredOverrides(runId, cached, referenceTime);
    }

    const pending = this.pendingLoads.get(runId);

    if (pending !== undefined) {
      return pending;
    }

    const versionBeforeLoad = this.getCacheVersion(runId);
    const loadPromise = this.rehydrateFromEventLog(runId)
      .then((rehydrated) => {
        const normalized = this.activeOverridesAt(rehydrated, referenceTime);

        if (this.getCacheVersion(runId) !== versionBeforeLoad) {
          return this.normalizeStoredOverrides(runId, this.store.get(runId) ?? Object.freeze([]), referenceTime);
        }

        const cachedAfterLoad = this.store.get(runId);

        if (cachedAfterLoad !== undefined) {
          return this.normalizeStoredOverrides(runId, cachedAfterLoad, referenceTime);
        }

        if (normalized.length === 0) {
          this.clearCacheMetadataIfIdle(runId);
          return normalized;
        }

        this.store.set(runId, normalized);
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

  private async rehydrateFromEventLog(runId: string): Promise<readonly Readonly<SessionOverride>[]> {
    const events = await this.dependencies.eventLogRepo.queryByRun(runId);
    const overrides = events
      .filter((event) => event.event_type === Phase3BEventType.SOUL_SESSION_OVERRIDE_APPLIED)
      .flatMap((event) => {
        const parsed = SoulSessionOverrideAppliedPayloadSchema.safeParse(event.payload_json);

        if (!parsed.success) {
          return [];
        }

        return [parseSessionOverride({
          runtime_id: parsed.data.override_id,
          object_kind: ControlPlaneObjectKind.SESSION_OVERRIDE,
          task_surface_ref: null,
          expires_at: parsed.data.expires_at,
          derived_from: parsed.data.derived_from ?? null,
          retention_policy: RetentionPolicy.SESSION_ONLY,
          scope: "session_only",
          target_object: parsed.data.target_object,
          correction: parsed.data.correction,
          priority: parsed.data.priority
        })];
      });

    return Object.freeze(overrides.sort(compareOverrides));
  }

  private getCacheVersion(runId: string): number {
    return this.cacheVersions.get(runId) ?? 0;
  }

  private bumpCacheVersion(runId: string): void {
    this.cacheVersions.set(runId, this.getCacheVersion(runId) + 1);
  }

  private activeOverridesAt(
    overrides: readonly Readonly<SessionOverride>[],
    referenceTime: string
  ): readonly Readonly<SessionOverride>[] {
    return Object.freeze(overrides.filter((override) => !isExpired(override.expires_at, referenceTime)));
  }

  private normalizeStoredOverrides(
    runId: string,
    overrides: readonly Readonly<SessionOverride>[],
    referenceTime: string
  ): readonly Readonly<SessionOverride>[] {
    const active = this.activeOverridesAt(overrides, referenceTime);

    if (active.length === overrides.length) {
      return overrides;
    }

    this.bumpCacheVersion(runId);

    if (active.length === 0) {
      this.store.delete(runId);
      this.clearCacheMetadataIfIdle(runId);
      return active;
    }

    this.store.set(runId, active);
    return active;
  }

  private clearCacheMetadataIfIdle(runId: string): void {
    if (!this.store.has(runId) && !this.pendingLoads.has(runId)) {
      this.cacheVersions.delete(runId);
    }
  }
}

function parseSessionOverride(value: SessionOverride): Readonly<SessionOverride> {
  try {
    return Object.freeze(SessionOverrideSchema.parse(value));
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid session override payload", { cause: error });
  }
}

function parsePriority(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new CoreError("VALIDATION", "priority must be a non-negative integer");
  }

  return value;
}

function normalizeExpiresAt(value: string): string {
  const epoch = Date.parse(value);

  if (!Number.isFinite(epoch)) {
    throw new CoreError("VALIDATION", "expiresAt must be a valid ISO timestamp");
  }

  return new Date(epoch).toISOString();
}

function addHours(iso: string, hours: number): string {
  const epoch = Date.parse(iso);

  if (!Number.isFinite(epoch)) {
    throw new CoreError("VALIDATION", "now must return a valid ISO timestamp");
  }

  return new Date(epoch + hours * 60 * 60 * 1000).toISOString();
}

function isExpired(expiresAt: string | null, referenceTime: string): boolean {
  if (expiresAt === null) {
    return false;
  }

  const expiryEpoch = Date.parse(expiresAt);
  const referenceEpoch = Date.parse(referenceTime);

  if (!Number.isFinite(expiryEpoch) || !Number.isFinite(referenceEpoch)) {
    return false;
  }

  return expiryEpoch <= referenceEpoch;
}

function compareOverrides(left: Readonly<SessionOverride>, right: Readonly<SessionOverride>): number {
  const priorityDelta = right.priority - left.priority;

  if (priorityDelta !== 0) {
    return priorityDelta;
  }

  return left.runtime_id.localeCompare(right.runtime_id);
}
