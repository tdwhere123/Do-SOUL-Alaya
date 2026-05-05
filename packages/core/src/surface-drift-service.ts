import { randomUUID } from "node:crypto";
import {
  DriftAlertSchema,
  DriftClassificationSchema,
  GovernanceDriftLeaseSchema,
  RuntimeGovernanceEventType,
  SurfaceDriftOperationTypeSchema,
  SurfaceDriftAlertPayloadSchema,
  SurfaceDriftDetectedPayloadSchema,
  SurfaceDriftLeaseAcquiredPayloadSchema,
  SurfaceDriftLeaseReleaseFailedPayloadSchema,
  SurfaceDriftLeaseReleasedPayloadSchema,
  classifyDriftSeverity,
  type DriftAlert,
  type DriftClassification,
  type DriftType,
  DriftTypeSchema,
  type EventLogEntry,
  type GovernanceDriftLease,
  type SurfaceDriftOperationType
} from "@do-soul/alaya-protocol";
import { CoreError } from "./errors.js";
import { EventPublisherPropagationError } from "./event-publisher.js";
import { SYSTEM_ACTOR } from "./shared/actors.js";
import { addDuration, readNow } from "./shared/time.js";
import { normalizeOptionalNonEmptyString, parseNonEmptyString } from "./shared/validators.js";

export const DEFAULT_SURFACE_DRIFT_LEASE_TTL_MS = 5 * 60 * 1000;

type SurfaceDriftEventInput = Omit<EventLogEntry, "event_id" | "created_at" | "revision">;

export interface DriftLeaseRepoPort {
  create(lease: Readonly<GovernanceDriftLease>): Readonly<GovernanceDriftLease>;
  findActive(workspaceId: string): Promise<readonly Readonly<GovernanceDriftLease>[]>;
  findActiveById(
    workspaceId: string,
    leaseId: string
  ): Promise<Readonly<GovernanceDriftLease> | null>;
  delete(leaseId: string): void;
  deleteExpired(beforeDate: string): number;
}

export interface SurfaceDriftEventPublisherPort {
  publish(event: SurfaceDriftEventInput): Promise<Readonly<EventLogEntry>>;
  /**
   * Atomic append + sync mutation (#BL-022). Surface-drift lease acquire/release
   * uses this to keep the EventLog row and the lease repo write in a single
   * SQLite transaction.
   */
  appendManyWithMutation<T>(
    inputs: readonly SurfaceDriftEventInput[],
    mutate: (entries: readonly EventLogEntry[]) => T
  ): Promise<T>;
}

export interface SurfaceDriftServiceDependencies {
  readonly leaseRepo: DriftLeaseRepoPort;
  readonly eventPublisher: SurfaceDriftEventPublisherPort;
  readonly generateId?: () => string;
  readonly now?: () => string;
}

export class SurfaceDriftService {
  private readonly generateId: () => string;

  public constructor(private readonly dependencies: SurfaceDriftServiceDependencies) {
    this.generateId = dependencies.generateId ?? (() => randomUUID());
  }

  public async classifyDrift(params: {
    readonly workspaceId: string;
    readonly driftType: DriftType;
    readonly affectedSubject: string;
    readonly description: string;
  }): Promise<Readonly<DriftClassification>> {
    const workspaceId = parseNonEmptyString(params.workspaceId, "workspaceId");
    const driftType = parseDriftType(params.driftType);
    const affectedSubject = parseNonEmptyString(params.affectedSubject, "affectedSubject");
    const description = parseNonEmptyString(params.description, "description");
    const detectedAt = readNow(this.dependencies.now);
    const classification = parseDriftClassification({
      drift_id: this.generateId(),
      workspace_id: workspaceId,
      drift_type: driftType,
      severity: classifyDriftSeverity(driftType),
      affected_subject: affectedSubject,
      description,
      detected_at: detectedAt
    });

    await this.dependencies.eventPublisher.publish({
      event_type: RuntimeGovernanceEventType.SURFACE_DRIFT_DETECTED,
      entity_type: "surface_drift",
      entity_id: classification.drift_id,
      workspace_id: classification.workspace_id,
      run_id: null,
      caused_by: SYSTEM_ACTOR,
      payload_json: SurfaceDriftDetectedPayloadSchema.parse({
        drift_id: classification.drift_id,
        workspace_id: classification.workspace_id,
        drift_type: classification.drift_type,
        severity: classification.severity,
        affected_subject: classification.affected_subject,
        detected_at: classification.detected_at
      })
    });

    return classification;
  }

  public async acquireLease(params: {
    readonly workspaceId: string;
    readonly operationType: SurfaceDriftOperationType;
    readonly grantedTo: string;
    readonly ttlMs: number;
    readonly driftId?: string | null;
  }): Promise<Readonly<GovernanceDriftLease>> {
    const workspaceId = parseNonEmptyString(params.workspaceId, "workspaceId");
    const operationType = parseOperationType(params.operationType);
    const grantedTo = parseNonEmptyString(params.grantedTo, "grantedTo");
    const ttlMs = parsePositiveTtlMs(params.ttlMs);
    const grantedAt = readNow(this.dependencies.now);
    const lease = parseGovernanceDriftLease({
      lease_id: this.generateId(),
      workspace_id: workspaceId,
      operation_type: operationType,
      granted_to: grantedTo,
      drift_id: normalizeOptionalNonEmptyString(params.driftId),
      expires_at: addDuration(grantedAt, ttlMs),
      granted_at: grantedAt
    });

    return await this.dependencies.eventPublisher.appendManyWithMutation(
      [
        {
          event_type: RuntimeGovernanceEventType.SURFACE_DRIFT_LEASE_ACQUIRED,
          entity_type: "surface_drift_lease",
          entity_id: lease.lease_id,
          workspace_id: lease.workspace_id,
          run_id: null,
          caused_by: grantedTo,
          payload_json: SurfaceDriftLeaseAcquiredPayloadSchema.parse({
            lease_id: lease.lease_id,
            workspace_id: lease.workspace_id,
            operation_type: lease.operation_type,
            granted_to: lease.granted_to,
            expires_at: lease.expires_at,
            granted_at: lease.granted_at
          })
        }
      ],
      () => {
        try {
          this.dependencies.leaseRepo.deleteExpired(grantedAt);
          return this.dependencies.leaseRepo.create(lease);
        } catch (error) {
          if (isConflictError(error)) {
            throw new CoreError(
              "CONFLICT",
              `Active drift lease already exists for workspace ${workspaceId} and operation ${operationType}.`,
              { cause: error }
            );
          }

          throw error;
        }
      }
    );
  }

  public async releaseLease(
    leaseId: string,
    workspaceId: string,
    releasedBy: string
  ): Promise<void> {
    const parsedLeaseId = parseNonEmptyString(leaseId, "leaseId");
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspaceId");
    const parsedReleasedBy = parseNonEmptyString(releasedBy, "releasedBy");
    const existingLease = await this.dependencies.leaseRepo.findActiveById(
      parsedWorkspaceId,
      parsedLeaseId
    );

    if (existingLease === null) {
      return;
    }

    if (existingLease.granted_to !== parsedReleasedBy) {
      throw new CoreError(
        "OBLIGATION_VIOLATION",
        `Only ${existingLease.granted_to} may release drift lease ${parsedLeaseId}.`
      );
    }

    const releasedAt = readNow(this.dependencies.now);
    try {
      await this.dependencies.eventPublisher.appendManyWithMutation(
        [
          {
            event_type: RuntimeGovernanceEventType.SURFACE_DRIFT_LEASE_RELEASED,
            entity_type: "surface_drift_lease",
            entity_id: existingLease.lease_id,
            workspace_id: existingLease.workspace_id,
            run_id: null,
            caused_by: parsedReleasedBy,
            payload_json: SurfaceDriftLeaseReleasedPayloadSchema.parse({
              lease_id: existingLease.lease_id,
              workspace_id: existingLease.workspace_id,
              operation_type: existingLease.operation_type,
              granted_to: existingLease.granted_to,
              released_by: parsedReleasedBy,
              released_at: releasedAt
            })
          }
        ],
        () => {
          this.dependencies.leaseRepo.delete(parsedLeaseId);
        }
      );
    } catch (error) {
      if (error instanceof EventPublisherPropagationError) {
        throw error;
      }

      await this.publishLeaseReleaseFailureWitness(existingLease, parsedReleasedBy, releasedAt);
    }
  }

  public async alertOnCriticalDrift(
    classification: Readonly<DriftClassification>
  ): Promise<Readonly<DriftAlert> | null> {
    const parsedClassification = parseDriftClassification(classification);

    if (parsedClassification.severity !== "governance_critical") {
      return null;
    }

    const alert = parseDriftAlert({
      alert_id: this.generateId(),
      workspace_id: parsedClassification.workspace_id,
      drift_id: parsedClassification.drift_id,
      severity: "governance_critical",
      message: `Governance-critical surface drift detected: ${parsedClassification.drift_type}`,
      alerted_at: readNow(this.dependencies.now)
    });

    await this.dependencies.eventPublisher.publish({
      event_type: RuntimeGovernanceEventType.SURFACE_DRIFT_ALERT,
      entity_type: "surface_drift_alert",
      entity_id: alert.alert_id,
      workspace_id: alert.workspace_id,
      run_id: null,
      caused_by: SYSTEM_ACTOR,
      payload_json: SurfaceDriftAlertPayloadSchema.parse({
        alert_id: alert.alert_id,
        drift_id: alert.drift_id,
        workspace_id: alert.workspace_id,
        severity: alert.severity,
        message: alert.message,
        alerted_at: alert.alerted_at
      })
    });

    return alert;
  }

  private async publishLeaseReleaseFailureWitness(
    lease: Readonly<GovernanceDriftLease>,
    releasedBy: string,
    failedAt: string
  ): Promise<void> {
    try {
      await this.dependencies.eventPublisher.publish({
        event_type: RuntimeGovernanceEventType.SURFACE_DRIFT_LEASE_RELEASE_FAILED,
        entity_type: "surface_drift_lease",
        entity_id: lease.lease_id,
        workspace_id: lease.workspace_id,
        run_id: null,
        caused_by: releasedBy,
        payload_json: SurfaceDriftLeaseReleaseFailedPayloadSchema.parse({
          lease_id: lease.lease_id,
          workspace_id: lease.workspace_id,
          operation_type: lease.operation_type,
          granted_to: lease.granted_to,
          released_by: releasedBy,
          failed_at: failedAt
        })
      });
    } catch {
      // Keep release non-fatal for already-applied durable mutations even if the witness publish fails.
    }
  }
}

function parseDriftClassification(value: DriftClassification): Readonly<DriftClassification> {
  try {
    return DriftClassificationSchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid surface drift classification payload", { cause: error });
  }
}

function parseDriftType(value: string): DriftType {
  try {
    return DriftTypeSchema.parse(parseNonEmptyString(value, "driftType"));
  } catch (error) {
    throw new CoreError("VALIDATION", "driftType must be a supported surface drift type", { cause: error });
  }
}

function parseGovernanceDriftLease(value: GovernanceDriftLease): Readonly<GovernanceDriftLease> {
  try {
    return GovernanceDriftLeaseSchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid governance drift lease payload", { cause: error });
  }
}

function parseOperationType(value: SurfaceDriftOperationType): SurfaceDriftOperationType {
  try {
    return SurfaceDriftOperationTypeSchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid surface drift operation type.", {
      cause: error
    });
  }
}

function parseDriftAlert(value: DriftAlert): Readonly<DriftAlert> {
  try {
    return DriftAlertSchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid surface drift alert payload", { cause: error });
  }
}

function parsePositiveTtlMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new CoreError("VALIDATION", "ttlMs must be a positive finite number");
  }

  return Math.floor(value);
}

function isConflictError(error: unknown): boolean {
  return (error as { code?: string })?.code === "CONFLICT";
}
