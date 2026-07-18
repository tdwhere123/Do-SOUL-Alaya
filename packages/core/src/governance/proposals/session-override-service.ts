import { randomUUID } from "node:crypto";
import {
  ControlPlaneObjectKind,
  GreenGovernanceEventType,
  RetentionPolicy,
  RunMessageAppendedPayloadSchema,
  SessionOverrideSchema,
  SoulSessionOverrideAppliedPayloadSchema,
  type EventLogEntry,
  type SessionOverride
} from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import { isExpired } from "../../shared/time.js";
import { parseNonEmptyString } from "../../shared/validators.js";
import { EventLogBackedCache } from "../cache/event-log-backed-cache.js";
import { assertGovernanceRunWorkspace, type GovernanceRunWorkspaceLookup } from "../policy/run-workspace-guard.js";

const OVERRIDE_REHYDRATE_FAILED_WARNING_CODE = "ALAYA_SESSION_OVERRIDE_REHYDRATE_FAILED";

export interface SessionOverrideServiceEventLogPort {
  append(entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry | Promise<EventLogEntry>;
  queryByEntity(entityType: string, entityId: string): Promise<readonly EventLogEntry[]>;
  queryByRunAndEntityType(runId: string, entityType: string): Promise<readonly EventLogEntry[]>;
  getLatestUserRunMessageByRun(runId: string): Promise<EventLogEntry | null>;
}

export interface SessionOverrideServiceDependencies {
  readonly eventLogRepo: SessionOverrideServiceEventLogPort;
  readonly runLookup: GovernanceRunWorkspaceLookup;
  readonly generateRuntimeId?: () => string;
  readonly now?: () => string;
}

/**
 * Session overrides are ephemeral control-plane objects.
 * The in-memory store is a cache over EventLog-backed truth so overrides can
 * be reconstructed after daemon restart.
 */
export class SessionOverrideService {
  private readonly cache = new EventLogBackedCache<readonly Readonly<SessionOverride>[]>();
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
    await assertGovernanceRunWorkspace(this.dependencies.runLookup, runId, workspaceId);
    const derivedFrom = await this.resolveDerivedFrom(runId, params.derivedFrom);
    const existing = await this.resolveStoredOverrides(runId);
    const override = this.buildSessionOverride(params, derivedFrom, occurredAt);
    await this.appendAppliedOverrideEvent(runId, workspaceId, occurredAt, override);

    this.clearExpiredAt(occurredAt);
    this.cache.set(runId, Object.freeze([...existing, override].sort(compareOverrides)));

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

    this.cache.delete(parsedRunId);
  }

  public clearExpired(): void {
    this.clearExpiredAt(this.now());
  }

  private buildSessionOverride(
    params: {
      readonly targetObject: string;
      readonly correction: string;
      readonly priority?: number;
      readonly expiresAt?: string;
    },
    derivedFrom: string | null,
    occurredAt: string
  ): Readonly<SessionOverride> {
    return parseSessionOverride({
      runtime_id: this.generateRuntimeId(),
      object_kind: ControlPlaneObjectKind.SESSION_OVERRIDE,
      task_surface_ref: null,
      expires_at: normalizeExpiresAt(params.expiresAt ?? addHours(occurredAt, 1)),
      derived_from: derivedFrom,
      retention_policy: RetentionPolicy.SESSION_ONLY,
      scope: "session_only",
      target_object: parseNonEmptyString(params.targetObject, "targetObject"),
      correction: parseNonEmptyString(params.correction, "correction"),
      priority: parsePriority(params.priority ?? 0)
    });
  }

  private async appendAppliedOverrideEvent(
    runId: string,
    workspaceId: string,
    occurredAt: string,
    override: Readonly<SessionOverride>
  ): Promise<void> {
    await this.dependencies.eventLogRepo.append({
      event_type: GreenGovernanceEventType.SOUL_SESSION_OVERRIDE_APPLIED,
      entity_type: "session_override",
      entity_id: override.runtime_id,
      workspace_id: workspaceId,
      run_id: runId,
      caused_by: "user_action",
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
  }

  private async resolveDerivedFrom(
    runId: string,
    explicitDerivedFrom: string | null | undefined
  ): Promise<string | null> {
    if (explicitDerivedFrom !== undefined) {
      const trimmed = explicitDerivedFrom?.trim() ?? "";
      return trimmed.length === 0 ? null : trimmed;
    }

    const latestUserMessage = await this.dependencies.eventLogRepo.getLatestUserRunMessageByRun(runId);

    if (latestUserMessage === null) {
      return null;
    }

    const parsed = RunMessageAppendedPayloadSchema.safeParse(latestUserMessage.payload_json);

    if (parsed.success && parsed.data.role === "user") {
      return parsed.data.message_id;
    }

    return null;
  }

  private clearExpiredAt(referenceTime: string): void {
    for (const [runId] of this.cache.entries()) {
      this.cache.refresh(runId, (overrides) => this.activeOverridesOrUndefined(overrides, referenceTime));
    }
  }

  private async resolveStoredOverrides(runId: string): Promise<readonly Readonly<SessionOverride>[]> {
    const referenceTime = this.now();
    const resolved = await this.cache.resolve(
      runId,
      async () => await this.rehydrateFromEventLog(runId),
      (overrides) => this.activeOverridesOrUndefined(overrides, referenceTime)
    );
    return resolved ?? Object.freeze([]);
  }

  private async rehydrateFromEventLog(runId: string): Promise<readonly Readonly<SessionOverride>[]> {
    let events: readonly EventLogEntry[];
    try {
      events = await queryRunEventLog(this.dependencies.eventLogRepo, runId);
    } catch (error) {
      // Fail-closed: a read failure must not silently drop an operator hard-stop override.
      process.emitWarning("[SessionOverrideService] Failed to rehydrate overrides from EventLog", {
        code: OVERRIDE_REHYDRATE_FAILED_WARNING_CODE,
        detail: JSON.stringify({
          run_id: runId,
          error: error instanceof Error ? error.message : String(error)
        })
      });
      throw new CoreError("CONFLICT", `Failed to rehydrate session overrides for run ${runId}.`, {
        subCode: "CONCURRENT_MODIFICATION",
        cause: error instanceof Error ? error : undefined
      });
    }
    const overrides = events
      .filter((event) => event.event_type === GreenGovernanceEventType.SOUL_SESSION_OVERRIDE_APPLIED)
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

  private activeOverridesOrUndefined(
    overrides: readonly Readonly<SessionOverride>[],
    referenceTime: string
  ): readonly Readonly<SessionOverride>[] | undefined {
    const active = overrides.filter((override) => !isExpired(override.expires_at, referenceTime));

    if (active.length === overrides.length) {
      return overrides;
    }
    return active.length === 0 ? undefined : Object.freeze(active);
  }
}

function parseSessionOverride(value: SessionOverride): Readonly<SessionOverride> {
  try {
    return Object.freeze(SessionOverrideSchema.parse(value));
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid session override payload", { cause: error });
  }
}

async function queryRunEventLog(
  eventLogRepo: SessionOverrideServiceEventLogPort,
  runId: string
): Promise<readonly EventLogEntry[]> {
  return await eventLogRepo.queryByRunAndEntityType(runId, "session_override");
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

function compareOverrides(left: Readonly<SessionOverride>, right: Readonly<SessionOverride>): number {
  const priorityDelta = right.priority - left.priority;

  if (priorityDelta !== 0) {
    return priorityDelta;
  }

  return left.runtime_id.localeCompare(right.runtime_id);
}
