import {
  RuntimeGovernanceEventType,
  SecurityPassthroughInitializationFailedPayloadSchema,
  SecurityPassthroughStatusChangedPayloadSchema,
  type EventLogEntry,
  type SecurityStatusContract
} from "@do-soul/alaya-protocol";
import type { EventPublisher } from "./event-publisher.js";
import { SYSTEM_ACTOR } from "./shared/actors.js";
import { readNow } from "./shared/time.js";
import type {
  ZeroDaySecurityLayer,
  ZeroDaySecurityStatusEvaluationObserver
} from "./zero-day-security-layer.js";

export interface SecurityStatusServiceDependencies {
  readonly zeroDayLayer: Pick<
    ZeroDaySecurityLayer,
    "getSecurityStatus" | "initializeWorkspaceSecurity" | "subscribeStatusEvaluations"
  >;
  readonly eventPublisher: Pick<EventPublisher, "publish">;
  readonly now?: () => string;
}

export class SecurityStatusService {
  private readonly observedStatuses = new Map<string, ObservedSecurityStatus>();
  private readonly unsubscribeStatusEvaluations: () => void;

  public constructor(private readonly deps: SecurityStatusServiceDependencies) {
    this.unsubscribeStatusEvaluations = this.deps.zeroDayLayer.subscribeStatusEvaluations(
      this.observeEvaluatedStatus
    );
  }

  public close(): void {
    this.unsubscribeStatusEvaluations();
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
    this.observedStatuses.set(status.workspace_id, snapshotStatus(status));
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
      return;
    }

    await this.publishStatusChange(status, reason);
  }

  private async readFailureTimestamp(workspaceId: string): Promise<string> {
    try {
      return (await this.deps.zeroDayLayer.getSecurityStatus(workspaceId)).last_assessment_at;
    } catch {
      return readNow(this.deps.now);
    }
  }
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
): Omit<EventLogEntry, "event_id" | "created_at"> {
  return {
    event_type: RuntimeGovernanceEventType.SECURITY_PASSTHROUGH_STATUS_CHANGED,
    entity_type: "workspace",
    entity_id: status.workspace_id,
    workspace_id: status.workspace_id,
    run_id: null,
    caused_by: SYSTEM_ACTOR,
    revision: 0,
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
): Omit<EventLogEntry, "event_id" | "created_at"> {
  return {
    event_type: RuntimeGovernanceEventType.SECURITY_PASSTHROUGH_INITIALIZATION_FAILED,
    entity_type: "workspace",
    entity_id: workspaceId,
    workspace_id: workspaceId,
    run_id: null,
    caused_by: SYSTEM_ACTOR,
    revision: 0,
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
