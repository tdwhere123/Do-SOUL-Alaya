import { randomUUID } from "node:crypto";
import {
  BindingState,
  BindingStateSchema,
  canonicalGovernanceSubject,
  CrossCuttingState,
  type DriftType,
  type DriftAlert,
  type DriftClassification,
  type GovernanceDriftLease,
  Phase2BEventType,
  SoulSurfaceBindingCreatedPayloadSchema,
  SoulSurfaceBindingStateChangedPayloadSchema,
  SurfaceBindingSchema,
  type BindingState as BindingStateType,
  type CrossCuttingPermission,
  type EventLogEntry,
  type SurfaceDriftOperationType,
  type SurfaceBinding
} from "@do-what/protocol";
import { CoreError } from "./errors.js";
import type { EventPublisher } from "./event-publisher.js";
import { SYSTEM_ACTOR } from "./shared/actors.js";
import { isUniqueConstraintError } from "./shared/event-utils.js";
import { parseSurfaceUri } from "./shared/surface-uri.js";
import { parseNonEmptyString, parseObjectId } from "./shared/validators.js";
import { DEFAULT_SURFACE_DRIFT_LEASE_TTL_MS } from "./surface-drift-service.js";

const BINDING_STATE_TRANSITIONS: Readonly<Record<BindingStateType, readonly BindingStateType[]>> = {
  [BindingState.ACTIVE]: [BindingState.STALE, BindingState.DETACHED],
  [BindingState.STALE]: [BindingState.ACTIVE, BindingState.DETACHED],
  [BindingState.DETACHED]: []
};
const SURFACE_BINDING_GOVERNANCE_SUBJECT = canonicalGovernanceSubject("surface_governance", {
  entity: "binding"
}).canonical_key;

type SurfaceBindingEventDraft = Omit<EventLogEntry, "event_id" | "created_at">;

export interface SurfaceBindingRecordView {
  readonly binding_id: string;
  readonly binding: Readonly<SurfaceBinding>;
}

export interface SurfaceBindingServiceCrossCuttingPermissionLookupRecord {
  readonly permission_id: string;
  readonly permission: Readonly<CrossCuttingPermission>;
}

export interface SurfaceBindingServiceSurfaceBindingRepoPort {
  create(binding: Readonly<SurfaceBinding>, bindingId: string): Promise<Readonly<SurfaceBindingRecordView>>;
  findByBindingId(bindingId: string): Promise<Readonly<SurfaceBindingRecordView> | null>;
  findByObjectId(objectId: string, workspaceId: string): Promise<readonly Readonly<SurfaceBindingRecordView>[]>;
  findPrimaryBinding(objectId: string, workspaceId: string): Promise<Readonly<SurfaceBindingRecordView> | null>;
  findBySurfaceId(surfaceId: string, workspaceId: string): Promise<readonly Readonly<SurfaceBindingRecordView>[]>;
  findDetachableBySurfaceId(
    surfaceId: string,
    workspaceId: string
  ): Promise<readonly Readonly<SurfaceBindingRecordView>[]>;
  findByWorkspace(workspaceId: string): Promise<readonly Readonly<SurfaceBindingRecordView>[]>;
  updateState(
    bindingId: string,
    bindingState: BindingStateType,
    updatedAt: string
  ): Promise<Readonly<SurfaceBindingRecordView>>;
  cascadeDetachBySurfaceId(
    surfaceId: string,
    workspaceId: string,
    updatedAt: string
  ): Promise<readonly Readonly<SurfaceBindingRecordView>[]>;
}

export interface SurfaceBindingServiceCrossCuttingLookupPort {
  findByObjectId(
    objectId: string,
    workspaceId: string
  ): Promise<Readonly<SurfaceBindingServiceCrossCuttingPermissionLookupRecord> | null>;
}

export interface SurfaceBindingSseBroadcaster {
  broadcastEntry(entry: EventLogEntry): void | Promise<void>;
}

export interface SurfaceBindingEventPublisherPort
  extends Pick<EventPublisher, "publishManyWithMutation" | "publishWithMutation"> {}

export interface SurfaceBindingServiceDependencies {
  readonly surfaceBindingRepo: SurfaceBindingServiceSurfaceBindingRepoPort;
  readonly crossCuttingPermissionLookup: SurfaceBindingServiceCrossCuttingLookupPort;
  readonly eventPublisher: SurfaceBindingEventPublisherPort;
  readonly sseBroadcaster?: SurfaceBindingSseBroadcaster;
  readonly surfaceDriftService?: SurfaceBindingDriftGovernancePort;
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
  readonly generateObjectId?: () => string;
  readonly now?: () => string;
}

interface SurfaceBindingDriftGovernancePort {
  acquireLease(params: {
    readonly workspaceId: string;
    readonly operationType: SurfaceDriftOperationType;
    readonly grantedTo: string;
    readonly ttlMs: number;
    readonly driftId?: string | null;
  }): Promise<Readonly<GovernanceDriftLease>>;
  releaseLease(leaseId: string, workspaceId: string, releasedBy: string): Promise<void>;
  classifyDrift(params: {
    readonly workspaceId: string;
    readonly driftType: DriftType;
    readonly affectedSubject: string;
    readonly description: string;
  }): Promise<Readonly<DriftClassification>>;
  alertOnCriticalDrift(
    classification: Readonly<DriftClassification>
  ): Promise<Readonly<DriftAlert> | null>;
}

export class SurfaceBindingService {
  private readonly generateObjectId: () => string;
  private readonly now: () => string;
  private readonly warn: (message: string, meta: Record<string, unknown>) => void;

  public constructor(private readonly dependencies: SurfaceBindingServiceDependencies) {
    this.generateObjectId = dependencies.generateObjectId ?? (() => randomUUID());
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.warn = dependencies.warn ?? (() => {});
  }

  public async bindObject(input: {
    readonly object_id: string;
    readonly surface_id: string;
    readonly is_primary: boolean;
    readonly workspace_id: string;
    readonly created_by: string;
  }): Promise<Readonly<SurfaceBindingRecordView>> {
    const parsedInput = parseBindObjectInput(input);

    await this.ensurePrimaryBindingAllowed(parsedInput.object_id, parsedInput.workspace_id, parsedInput.is_primary);
    await this.ensureCrossCuttingAllowsBinding(parsedInput.object_id, parsedInput.workspace_id, parsedInput.surface_id);

    const driftLeaseId = await this.acquireDriftLease(
      parsedInput.workspace_id,
      "surface.bind_object",
      parsedInput.created_by
    );
    let operationCompleted = false;

    try {
      const bindingId = this.generateObjectId();
      const timestamp = this.now();
      const binding = this.buildBinding(parsedInput, timestamp);
      const event = this.buildBindingCreatedEvent(bindingId, binding);
      const created = await this.persistBindingWithEvent(binding, bindingId, event);
      operationCompleted = true;
      await this.classifyBindingDriftSafely({
        workspaceId: created.binding.workspace_id,
        operationType: "surface.bind_object",
        driftType: "scope_change",
        description: `Bound object ${created.binding.object_id} to surface ${created.binding.surface_id}`
      });
      return created;
    } finally {
      await this.releaseDriftLeaseSafely({
        leaseId: driftLeaseId,
        workspaceId: parsedInput.workspace_id,
        operationType: "surface.bind_object",
        releasedBy: parsedInput.created_by,
        failureMessage: "Surface binding creation applied but drift lease release failed.",
        propagateFailure: operationCompleted
      });
    }
  }

  public async findBindingById(bindingId: string): Promise<Readonly<SurfaceBindingRecordView> | null> {
    return await this.dependencies.surfaceBindingRepo.findByBindingId(parseObjectId(bindingId, "binding_id"));
  }

  public async transitionBindingState(
    bindingId: string,
    newState: BindingStateType,
    reason: string,
    causedBy: string
  ): Promise<Readonly<SurfaceBindingRecordView>> {
    const parsedBindingId = parseObjectId(bindingId, "binding_id");
    const parsedNewState = parseBindingState(newState);
    const parsedReason = parseReason(reason);
    const parsedCausedBy = parseCausedBy(causedBy);

    const existing = await this.dependencies.surfaceBindingRepo.findByBindingId(parsedBindingId);

    if (existing === null) {
      throw new CoreError("NOT_FOUND", "Surface binding not found");
    }

    ensureValidBindingTransition(existing.binding.binding_state, parsedNewState);
    const driftLeaseId = await this.acquireDriftLease(
      existing.binding.workspace_id,
      "surface.transition_binding_state",
      parsedCausedBy
    );
    let operationCompleted = false;

    try {
      const occurredAt = this.now();
      const event: SurfaceBindingEventDraft = {
        event_type: Phase2BEventType.SOUL_SURFACE_BINDING_STATE_CHANGED,
        entity_type: "surface_binding",
      entity_id: existing.binding_id,
      workspace_id: existing.binding.workspace_id,
      run_id: null,
      caused_by: parsedCausedBy,
      revision: 0,
      payload_json: SoulSurfaceBindingStateChangedPayloadSchema.parse({
          binding_id: existing.binding_id,
          object_id: existing.binding.object_id,
          surface_id: existing.binding.surface_id,
          from_state: existing.binding.binding_state,
          to_state: parsedNewState,
          reason: parsedReason,
          occurred_at: occurredAt,
          workspace_id: existing.binding.workspace_id
        })
      };

      const updated = await this.requireEventPublisher().publishWithMutation(event, async () =>
        await this.dependencies.surfaceBindingRepo.updateState(
          existing.binding_id,
          parsedNewState,
          occurredAt
        )
      );
      operationCompleted = true;

      await this.classifyBindingDriftSafely({
        workspaceId: existing.binding.workspace_id,
        operationType: "surface.transition_binding_state",
        driftType: parsedNewState === BindingState.DETACHED ? "policy_override" : "scope_change",
        description: `Surface binding ${existing.binding_id} changed from ${existing.binding.binding_state} to ${parsedNewState}`
      });
      return updated;
    } finally {
      await this.releaseDriftLeaseSafely({
        leaseId: driftLeaseId,
        workspaceId: existing.binding.workspace_id,
        operationType: "surface.transition_binding_state",
        releasedBy: parsedCausedBy,
        failureMessage: "Surface binding transition applied but drift lease release failed.",
        propagateFailure: operationCompleted
      });
    }
  }

  public async cascadeDetachBySurfaceId(surfaceId: string, workspaceId: string): Promise<void> {
    const parsedSurfaceId = parseNonEmptyString(surfaceId, "surface_id");
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace_id");

    const detachTargets = await this.dependencies.surfaceBindingRepo.findDetachableBySurfaceId(
      parsedSurfaceId,
      parsedWorkspaceId
    );

    if (detachTargets.length === 0) {
      return;
    }

    const occurredAt = this.now();
    const events: SurfaceBindingEventDraft[] = detachTargets.map((target) => ({
      event_type: Phase2BEventType.SOUL_SURFACE_BINDING_STATE_CHANGED,
      entity_type: "surface_binding",
      entity_id: target.binding_id,
      workspace_id: target.binding.workspace_id,
      run_id: null,
      caused_by: SYSTEM_ACTOR,
      revision: 0,
      payload_json: SoulSurfaceBindingStateChangedPayloadSchema.parse({
        binding_id: target.binding_id,
        object_id: target.binding.object_id,
        surface_id: target.binding.surface_id,
        from_state: target.binding.binding_state,
        to_state: BindingState.DETACHED,
        reason: "surface_revoked_cascade",
        occurred_at: occurredAt,
        workspace_id: target.binding.workspace_id
      })
    }));

    await this.requireEventPublisher().publishManyWithMutation(events, async () =>
      await this.dependencies.surfaceBindingRepo.cascadeDetachBySurfaceId(
        parsedSurfaceId,
        parsedWorkspaceId,
        occurredAt
      )
    );
  }

  public async findBindingsByObject(
    objectId: string,
    workspaceId: string
  ): Promise<readonly Readonly<SurfaceBindingRecordView>[]> {
    return await this.dependencies.surfaceBindingRepo.findByObjectId(
      parseNonEmptyString(objectId, "object_id"),
      parseNonEmptyString(workspaceId, "workspace_id")
    );
  }

  public async findBindingsBySurface(
    surfaceId: string,
    workspaceId: string
  ): Promise<readonly Readonly<SurfaceBindingRecordView>[]> {
    return await this.dependencies.surfaceBindingRepo.findBySurfaceId(
      parseNonEmptyString(surfaceId, "surface_id"),
      parseNonEmptyString(workspaceId, "workspace_id")
    );
  }

  public async findBindingsByWorkspace(
    workspaceId: string
  ): Promise<readonly Readonly<SurfaceBindingRecordView>[]> {
    return await this.dependencies.surfaceBindingRepo.findByWorkspace(
      parseNonEmptyString(workspaceId, "workspace_id")
    );
  }

  private async ensurePrimaryBindingAllowed(
    objectId: string,
    workspaceId: string,
    isPrimary: boolean
  ): Promise<void> {
    if (!isPrimary) {
      return;
    }

    const existingPrimary = await this.dependencies.surfaceBindingRepo.findPrimaryBinding(objectId, workspaceId);

    if (existingPrimary !== null) {
      throw new CoreError("CONFLICT", "Object already has a primary surface binding");
    }
  }

  private async ensureCrossCuttingAllowsBinding(
    objectId: string,
    workspaceId: string,
    surfaceId: string
  ): Promise<void> {
    const existingBindings = await this.dependencies.surfaceBindingRepo.findByObjectId(objectId, workspaceId);
    const effectiveBindings = existingBindings.filter(
      (record) => record.binding.binding_state !== BindingState.DETACHED
    );

    if (effectiveBindings.length === 0) {
      return;
    }

    const permissionRecord = await this.dependencies.crossCuttingPermissionLookup.findByObjectId(
      objectId,
      workspaceId
    );

    if (permissionRecord === null || permissionRecord.permission.cross_cutting_state !== CrossCuttingState.ACTIVE) {
      throw new CoreError("CONFLICT", "Object requires cross_cutting_state = active for multi-surface binding");
    }

    const allowedSurfaceSet = new Set(permissionRecord.permission.allowed_surfaces);
    if (!allowedSurfaceSet.has(surfaceId)) {
      throw new CoreError("VALIDATION", "surface_id is not in allowed_surfaces");
    }
  }

  private buildBinding(
    input: ReturnType<typeof parseBindObjectInput>,
    timestamp: string
  ): Readonly<SurfaceBinding> {
    return parseSurfaceBinding({
      object_id: input.object_id,
      object_kind: "surface_binding",
      schema_version: 1,
      lifecycle_state: "active",
      created_at: timestamp,
      updated_at: timestamp,
      created_by: input.created_by,
      surface_id: input.surface_id,
      is_primary: input.is_primary,
      binding_state: BindingState.ACTIVE,
      workspace_id: input.workspace_id
    });
  }

  private buildBindingCreatedEvent(
    bindingId: string,
    binding: Readonly<SurfaceBinding>
  ): SurfaceBindingEventDraft {
    return {
      event_type: Phase2BEventType.SOUL_SURFACE_BINDING_CREATED,
      entity_type: "surface_binding",
      entity_id: bindingId,
      workspace_id: binding.workspace_id,
      run_id: null,
      caused_by: binding.created_by,
      revision: 0,
      payload_json: SoulSurfaceBindingCreatedPayloadSchema.parse({
        binding_id: bindingId,
        object_id: binding.object_id,
        object_kind: binding.object_kind,
        workspace_id: binding.workspace_id,
        run_id: null,
        surface_id: binding.surface_id,
        is_primary: binding.is_primary,
        binding_state: binding.binding_state
      })
    };
  }

  private async persistBindingWithEvent(
    binding: Readonly<SurfaceBinding>,
    bindingId: string,
    event: SurfaceBindingEventDraft
  ): Promise<Readonly<SurfaceBindingRecordView>> {
    try {
      return await this.requireEventPublisher().publishWithMutation(event, async () =>
        await this.dependencies.surfaceBindingRepo.create(binding, bindingId)
      );
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new CoreError("CONFLICT", "Surface binding violates uniqueness constraints", { cause: error });
      }

      throw error;
    }
  }

  private async acquireDriftLease(
    workspaceId: string,
    operationType: SurfaceDriftOperationType,
    grantedTo: string
  ): Promise<string | null> {
    const driftService = this.dependencies.surfaceDriftService;

    if (driftService === undefined) {
      return null;
    }

    const lease = await driftService.acquireLease({
      workspaceId,
      operationType,
      grantedTo,
      ttlMs: DEFAULT_SURFACE_DRIFT_LEASE_TTL_MS
    });

    return lease.lease_id;
  }

  private async releaseDriftLeaseSafely(params: {
    readonly leaseId: string | null;
    readonly workspaceId: string;
    readonly operationType: SurfaceDriftOperationType;
    readonly releasedBy: string;
    readonly failureMessage: string;
    readonly propagateFailure: boolean;
  }): Promise<void> {
    if (params.leaseId === null || this.dependencies.surfaceDriftService === undefined) {
      return;
    }

    try {
      await this.dependencies.surfaceDriftService.releaseLease(
        params.leaseId,
        params.workspaceId,
        params.releasedBy
      );
    } catch (error) {
      this.warn("Surface binding drift lease release failed after durable mutation", {
        operationType: params.operationType,
        workspaceId: params.workspaceId,
        leaseId: params.leaseId,
        error
      });
    }
  }

  private async classifyBindingDriftSafely(params: {
    readonly workspaceId: string;
    readonly operationType: SurfaceDriftOperationType;
    readonly driftType: DriftType;
    readonly description: string;
  }): Promise<void> {
    try {
      await this.classifyBindingDrift(params);
    } catch (error) {
      this.warn("Surface binding drift telemetry failed after durable mutation", {
        operationType: params.operationType,
        workspaceId: params.workspaceId,
        driftType: params.driftType,
        error
      });
    }
  }

  private async classifyBindingDrift(params: {
    readonly workspaceId: string;
    readonly driftType: DriftType;
    readonly description: string;
  }): Promise<void> {
    const driftService = this.dependencies.surfaceDriftService;

    if (driftService === undefined) {
      return;
    }

    const classification = await driftService.classifyDrift({
      workspaceId: params.workspaceId,
      driftType: params.driftType,
      affectedSubject: SURFACE_BINDING_GOVERNANCE_SUBJECT,
      description: params.description
    });

    await driftService.alertOnCriticalDrift(classification);
  }

  private requireEventPublisher(): SurfaceBindingEventPublisherPort {
    return this.dependencies.eventPublisher;
  }
}

function parseBindObjectInput(input: {
  readonly object_id: string;
  readonly surface_id: string;
  readonly is_primary: boolean;
  readonly workspace_id: string;
  readonly created_by: string;
}) {
  return {
    object_id: parseNonEmptyString(input.object_id, "object_id"),
    surface_id: parseSurfaceUri(input.surface_id, "surface_id"),
    is_primary: input.is_primary,
    workspace_id: parseNonEmptyString(input.workspace_id, "workspace_id"),
    created_by: parseNonEmptyString(input.created_by, "created_by")
  };
}

function parseBindingState(value: BindingStateType): BindingStateType {
  try {
    return BindingStateSchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid binding state", { cause: error });
  }
}

function parseSurfaceBinding(value: SurfaceBinding): SurfaceBinding {
  try {
    return SurfaceBindingSchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid surface binding payload", { cause: error });
  }
}

function parseReason(value: string): string {
  return parseNonEmptyString(value, "reason");
}

function parseCausedBy(value: string): string {
  return parseNonEmptyString(value, "caused_by");
}

function ensureValidBindingTransition(from: BindingStateType, to: BindingStateType): void {
  if (from === to) {
    throw new CoreError("VALIDATION", "Binding state transition must change state");
  }

  if (!BINDING_STATE_TRANSITIONS[from].includes(to)) {
    throw new CoreError("VALIDATION", `Invalid binding state transition: ${from} -> ${to}`);
  }
}
