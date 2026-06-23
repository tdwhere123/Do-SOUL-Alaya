import {
  RuntimeGovernanceEventType,
  SecurityPassthroughInitializationFailedPayloadSchema,
  SecurityPassthroughStatusChangedPayloadSchema,
  type EventLogEntry,
  type SecurityStatusContract
} from "@do-soul/alaya-protocol";
import type { EventPublisher } from "../runtime/event-publisher.js";
import { SYSTEM_ACTOR } from "../shared/actors.js";
import type {
  ZeroDaySecurityLayer,
  ZeroDaySecurityStatusEvaluationObserver
} from "./zero-day-security-layer.js";

const STATUS_READ_FAILED_WARNING_CODE = "ALAYA_SECURITY_STATUS_READ_FAILED";
// Epoch sentinel: a failed probe read must not masquerade as a fresh assessment in the freshness gate.
const DEGRADED_ASSESSMENT_AT = new Date(0).toISOString();

export interface SecurityStatusServiceDependencies {
  readonly zeroDayLayer: Pick<
    ZeroDaySecurityLayer,
    "getSecurityStatus" | "initializeWorkspaceSecurity" | "subscribeStatusEvaluations"
  >;
  readonly eventPublisher: Pick<EventPublisher, "publish">;
  readonly observedStatusCacheLimit?: number;
}

const DEFAULT_OBSERVED_STATUS_CACHE_LIMIT = 10_000;

export class SecurityStatusService {
  private readonly observedStatuses = new Map<string, ObservedSecurityStatus>();
  private readonly observedStatusCacheLimit: number;
  private readonly unsubscribeStatusEvaluations: () => void;

  public constructor(private readonly deps: SecurityStatusServiceDependencies) {
    this.observedStatusCacheLimit = parsePositiveIntegerLimit(
      deps.observedStatusCacheLimit,
      DEFAULT_OBSERVED_STATUS_CACHE_LIMIT,
      "observedStatusCacheLimit"
    );
    this.unsubscribeStatusEvaluations = this.deps.zeroDayLayer.subscribeStatusEvaluations(
      this.observeEvaluatedStatus
    );
  }

  public close(): void {
    this.unsubscribeStatusEvaluations();
    this.observedStatuses.clear();
  }

  public async getStatus(workspaceId: string): Promise<SecurityStatusContract> {
    return await this.deps.zeroDayLayer.getSecurityStatus(workspaceId);
  }

  public async initializeWorkspace(workspaceId: string): Promise<SecurityStatusContract> {
    const initializedNow = await this.deps.zeroDayLayer.initializeWorkspaceSecurity(workspaceId);
    const status = await this.getStatus(workspaceId);

    if (initializedNow) {
      await this.reconcileObservedStatus(status, "workspace_initialized");
    }

    return status;
  }

  public async reconcileStatusChange(
    workspaceId: string,
    reason: string
  ): Promise<SecurityStatusContract> {
    const status = await this.getStatus(workspaceId);
    await this.reconcileObservedStatus(status, reason);
    return status;
  }

  public async emitStatusChange(workspaceId: string, reason: string): Promise<void> {
    const status = await this.getStatus(workspaceId);
    await this.publishStatusChange(status, reason);
  }

  public async recordInitializationFailure(
    workspaceId: string,
    operation: SecurityInitializationOperation,
    reason?: string | null,
    errorCode?: string | null
  ): Promise<void> {
    const parsedWorkspaceId = workspaceId.trim();
    const failedAt = await this.readFailureTimestamp(parsedWorkspaceId);

    await this.deps.eventPublisher.publish(
      createInitializationFailedEvent(parsedWorkspaceId, operation, failedAt, reason, errorCode)
    );
  }

  private async publishStatusChange(
    status: Readonly<SecurityStatusContract>,
    reason: string
  ): Promise<void> {
    await this.deps.eventPublisher.publish(createStatusChangedEvent(status, reason));
    this.cacheObservedStatus(status.workspace_id, snapshotStatus(status));
  }

  private readonly observeEvaluatedStatus: ZeroDaySecurityStatusEvaluationObserver = async (
    status,
    reason
  ) => {
    await this.reconcileObservedStatus(status, reason);
  };

  private async reconcileObservedStatus(
    status: Readonly<SecurityStatusContract>,
    reason: string
  ): Promise<void> {
    const observedStatus = this.observedStatuses.get(status.workspace_id);

    if (observedStatus !== undefined && statusesMatch(observedStatus, status)) {
      this.cacheObservedStatus(status.workspace_id, observedStatus);
      return;
    }

    await this.publishStatusChange(status, reason);
  }

  private cacheObservedStatus(
    workspaceId: string,
    status: ObservedSecurityStatus
  ): void {
    this.observedStatuses.delete(workspaceId);
    this.observedStatuses.set(workspaceId, status);
    this.pruneObservedStatuses();
  }

  private pruneObservedStatuses(): void {
    while (this.observedStatuses.size > this.observedStatusCacheLimit) {
      const oldestWorkspaceId = this.observedStatuses.keys().next().value as string | undefined;
      if (oldestWorkspaceId === undefined) {
        return;
      }
      this.observedStatuses.delete(oldestWorkspaceId);
    }
  }

  private async readFailureTimestamp(workspaceId: string): Promise<string> {
    try {
      return (await this.deps.zeroDayLayer.getSecurityStatus(workspaceId)).last_assessment_at;
    } catch (error) {
      process.emitWarning("[SecurityStatusService] Failed to read security status for failure timestamp", {
        code: STATUS_READ_FAILED_WARNING_CODE,
        detail: JSON.stringify({
          workspace_id: workspaceId,
          error: error instanceof Error ? error.message : String(error)
        })
      });
      return DEGRADED_ASSESSMENT_AT;
    }
  }
}

function parsePositiveIntegerLimit(
  value: number | undefined,
  fallback: number,
  name: string
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`${name} must be a positive finite integer`);
  }
  return Math.floor(value);
}

type SecurityInitializationOperation = "create" | "list" | "get_by_id";

type ObservedSecurityStatus = Readonly<{
  posture: SecurityStatusContract["posture"];
  zero_day_active: SecurityStatusContract["zero_day_active"];
  active_security_locks: SecurityStatusContract["active_security_locks"];
  active_protections: readonly string[];
}>;

function createStatusChangedEvent(
  status: Readonly<SecurityStatusContract>,
  reason: string
): Omit<EventLogEntry, "event_id" | "created_at" | "revision"> {
  return {
    event_type: RuntimeGovernanceEventType.SECURITY_PASSTHROUGH_STATUS_CHANGED,
    entity_type: "workspace",
    entity_id: status.workspace_id,
    workspace_id: status.workspace_id,
    run_id: null,
    caused_by: SYSTEM_ACTOR,
    payload_json: SecurityPassthroughStatusChangedPayloadSchema.parse({
      workspace_id: status.workspace_id,
      posture: status.posture,
      zero_day_active: status.zero_day_active,
      active_security_locks: status.active_security_locks,
      reason,
      changed_at: status.last_assessment_at
    })
  };
}

function createInitializationFailedEvent(
  workspaceId: string,
  operation: SecurityInitializationOperation,
  failedAt: string,
  reason?: string | null,
  errorCode?: string | null
): Omit<EventLogEntry, "event_id" | "created_at" | "revision"> {
  return {
    event_type: RuntimeGovernanceEventType.SECURITY_PASSTHROUGH_INITIALIZATION_FAILED,
    entity_type: "workspace",
    entity_id: workspaceId,
    workspace_id: workspaceId,
    run_id: null,
    caused_by: SYSTEM_ACTOR,
    payload_json: SecurityPassthroughInitializationFailedPayloadSchema.parse({
      workspace_id: workspaceId,
      operation,
      failed_at: failedAt,
      reason: reason ?? null,
      error_code: errorCode ?? null
    })
  };
}

function snapshotStatus(status: Readonly<SecurityStatusContract>): ObservedSecurityStatus {
  return {
    posture: status.posture,
    zero_day_active: status.zero_day_active,
    active_security_locks: status.active_security_locks,
    active_protections: [...status.active_protections]
  };
}

function statusesMatch(
  observedStatus: Readonly<ObservedSecurityStatus>,
  nextStatus: Readonly<SecurityStatusContract>
): boolean {
  if (observedStatus.posture !== nextStatus.posture) {
    return false;
  }

  if (observedStatus.zero_day_active !== nextStatus.zero_day_active) {
    return false;
  }

  if (observedStatus.active_security_locks !== nextStatus.active_security_locks) {
    return false;
  }

  if (observedStatus.active_protections.length !== nextStatus.active_protections.length) {
    return false;
  }

  const observedProtections = [...observedStatus.active_protections].sort();
  const nextProtections = [...nextStatus.active_protections].sort();

  return observedProtections.every(
    (protection, index) => protection === nextProtections[index]
  );
}
