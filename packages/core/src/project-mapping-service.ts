import { randomUUID } from "node:crypto";
import {
  ConfirmationPolicy,
  ObjectKind,
  ObjectLifecycleState,
  Phase4CEventType,
  ProjectMappingState,
  SoulProjectMappingStateChangedPayloadSchema,
  SoulProjectMappingSuggestedPayloadSchema,
  getConfirmationPolicy as getProtocolConfirmationPolicy,
  type AcceptedBy as AcceptedByType,
  type ConfirmationPolicy as ConfirmationPolicyType,
  type EventLogEntry,
  type MemoryEntry,
  type ProjectMappingAnchor,
  type ProjectMappingState as ProjectMappingStateType
} from "@do-soul/alaya-protocol";
import { CoreError } from "./errors.js";
import { getNextRevision } from "./shared/event-utils.js";

export interface ProjectMappingServiceEventLogRepoPort {
  append(entry: Omit<EventLogEntry, "event_id" | "created_at">): Promise<EventLogEntry>;
  queryByEntity(entityType: string, entityId: string): Promise<readonly EventLogEntry[]>;
}

export interface ProjectMappingServiceProjectMappingRepoPort {
  create(anchor: ProjectMappingAnchor): Promise<void>;
  findById(id: string): Promise<Readonly<ProjectMappingAnchor> | null>;
  findByIds(ids: readonly string[]): Promise<readonly Readonly<ProjectMappingAnchor>[]>;
  findByWorkspace(
    workspaceId: string,
    state?: ProjectMappingStateType
  ): Promise<readonly Readonly<ProjectMappingAnchor>[]>;
  findByGlobalObjectId(
    globalObjectId: string,
    workspaceId: string
  ): Promise<Readonly<ProjectMappingAnchor> | null>;
  updateState(
    id: string,
    newState: ProjectMappingStateType,
    acceptedBy: AcceptedByType | null,
    at: string
  ): Promise<void>;
  listPending(workspaceId: string): Promise<readonly Readonly<ProjectMappingAnchor>[]>;
}

export interface ProjectMappingServiceMemoryRepoPort {
  findById(id: string): Promise<Readonly<MemoryEntry> | null>;
  findByIds(ids: readonly string[]): Promise<readonly Readonly<MemoryEntry>[]>;
}

export interface ProjectMappingServiceDependencies {
  readonly projectMappingRepo: ProjectMappingServiceProjectMappingRepoPort;
  readonly memoryRepo: ProjectMappingServiceMemoryRepoPort;
  readonly eventLogRepo: ProjectMappingServiceEventLogRepoPort;
  readonly runtimeNotifier?: ProjectMappingServiceRuntimeNotifierPort;
  readonly generateObjectId?: () => string;
  readonly now?: () => string;
}

export interface ProjectMappingServiceRuntimeNotifierPort {
  notifyEntry(entry: EventLogEntry): void | Promise<void>;
}

export class StrictConfirmationRequired extends Error {
  public readonly mappingIds: readonly string[];

  public constructor(mappingIds: readonly string[]) {
    super(`Anchors [${mappingIds.join(", ")}] require strict (per-item) confirmation`);
    this.name = "StrictConfirmationRequired";
    this.mappingIds = Object.freeze([...mappingIds]);
  }
}

export class ProjectMappingService {
  private readonly generateObjectId: () => string;
  private readonly now: () => string;
  private readonly pendingAnchorCreations = new Map<string, Promise<Readonly<ProjectMappingAnchor>>>();
  private readonly pendingAnchorRevivals = new Map<string, Promise<Readonly<ProjectMappingAnchor>>>();

  public constructor(private readonly dependencies: ProjectMappingServiceDependencies) {
    this.generateObjectId = dependencies.generateObjectId ?? (() => randomUUID());
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  public async findByWorkspace(
    workspaceId: string,
    state?: ProjectMappingStateType
  ): Promise<readonly Readonly<ProjectMappingAnchor>[]> {
    return await this.dependencies.projectMappingRepo.findByWorkspace(workspaceId, state);
  }

  public async suggest(
    globalObjectId: string,
    workspaceId: string,
    createdBy: string
  ): Promise<Readonly<ProjectMappingAnchor>> {
    const existing = await this.dependencies.projectMappingRepo.findByGlobalObjectId(
      globalObjectId,
      workspaceId
    );

    if (existing !== null) {
      if (existing.mapping_state === ProjectMappingState.REJECTED) {
        return await this.transitionExistingAnchor(existing, {
          targetState: ProjectMappingState.SUGGESTED,
          acceptedBy: null,
          causedBy: createdBy,
          fallbackFromState: ProjectMappingState.REJECTED
        });
      }

      return existing;
    }

    const memory = await this.dependencies.memoryRepo.findById(globalObjectId);

    if (memory === null || memory.lifecycle_state === ObjectLifecycleState.TOMBSTONE) {
      throw new CoreError("NOT_FOUND", `Global memory ${globalObjectId} was not found.`);
    }

    return await this.createSuggestedAnchor(globalObjectId, workspaceId, createdBy);
  }

  public async ensureSuggestedAnchors(
    globalObjectIds: readonly string[],
    workspaceId: string,
    createdBy: string
  ): Promise<readonly Readonly<ProjectMappingAnchor>[]> {
    const dedupedGlobalObjectIds = [...new Set(globalObjectIds)];

    return Object.freeze(
      await Promise.all(
        dedupedGlobalObjectIds.map(
          async (globalObjectId) =>
            await this.ensureAnchor(globalObjectId, workspaceId, createdBy, {
              reviveRejected: false
            })
        )
      )
    );
  }

  public async ensureAdoptableAnchor(
    globalObjectId: string,
    workspaceId: string,
    createdBy: string
  ): Promise<Readonly<ProjectMappingAnchor>> {
    return await this.ensureAnchor(globalObjectId, workspaceId, createdBy, {
      reviveRejected: true
    });
  }

  private async createSuggestedAnchor(
    globalObjectId: string,
    workspaceId: string,
    createdBy: string
  ): Promise<Readonly<ProjectMappingAnchor>> {
    const timestamp = this.now();
    const anchor = Object.freeze<ProjectMappingAnchor>({
      object_id: this.generateObjectId(),
      object_kind: ObjectKind.PROJECT_MAPPING_ANCHOR,
      schema_version: 1,
      lifecycle_state: ObjectLifecycleState.ACTIVE,
      created_at: timestamp,
      updated_at: timestamp,
      created_by: createdBy,
      global_object_id: globalObjectId,
      project_id: workspaceId,
      workspace_id: workspaceId,
      mapping_state: ProjectMappingState.SUGGESTED,
      accepted_by: null,
      last_transition_at: timestamp
    });

    const revision = await getNextRevision(
      this.dependencies.eventLogRepo,
      ObjectKind.PROJECT_MAPPING_ANCHOR,
      anchor.object_id
    );

    // EventLog-first is intentional: project-mapping writes are at-least-once. If repo persistence
    // fails after append, reconciliation should treat the EventLog as the source of truth.
    const event = await this.dependencies.eventLogRepo.append({
      event_type: Phase4CEventType.PROJECT_MAPPING_SUGGESTED,
      entity_type: ObjectKind.PROJECT_MAPPING_ANCHOR,
      entity_id: anchor.object_id,
      workspace_id: workspaceId,
      run_id: null,
      caused_by: createdBy,
      revision,
      payload_json: SoulProjectMappingSuggestedPayloadSchema.parse({
        mapping_id: anchor.object_id,
        global_object_id: globalObjectId,
        workspace_id: workspaceId,
        initial_state: ProjectMappingState.SUGGESTED,
        suggested_at: timestamp
      })
    });

    await this.dependencies.projectMappingRepo.create(anchor);
    await this.dependencies.runtimeNotifier?.notifyEntry(event);

    return anchor;
  }

  private async ensureAnchor(
    globalObjectId: string,
    workspaceId: string,
    createdBy: string,
    options: {
      readonly reviveRejected: boolean;
    }
  ): Promise<Readonly<ProjectMappingAnchor>> {
    const existing = await this.dependencies.projectMappingRepo.findByGlobalObjectId(
      globalObjectId,
      workspaceId
    );

    if (existing !== null) {
      if (existing.mapping_state === ProjectMappingState.REJECTED && options.reviveRejected) {
        return await this.reviveRejectedAnchor(existing, createdBy);
      }

      return existing;
    }

    return await this.runPendingAnchorOperation(
      this.pendingAnchorCreations,
      this.getAnchorOperationKey(globalObjectId, workspaceId),
      async () => {
        const current = await this.dependencies.projectMappingRepo.findByGlobalObjectId(
          globalObjectId,
          workspaceId
        );

        if (current !== null) {
          if (current.mapping_state === ProjectMappingState.REJECTED && options.reviveRejected) {
            return await this.reviveRejectedAnchor(current, createdBy);
          }

          return current;
        }

        return await this.createSuggestedAnchor(globalObjectId, workspaceId, createdBy);
      }
    );
  }

  private async reviveRejectedAnchor(
    anchor: Readonly<ProjectMappingAnchor>,
    createdBy: string
  ): Promise<Readonly<ProjectMappingAnchor>> {
    return await this.runPendingAnchorOperation(
      this.pendingAnchorRevivals,
      this.getAnchorOperationKey(anchor.global_object_id, anchor.workspace_id),
      async () => {
        const current = await this.dependencies.projectMappingRepo.findByGlobalObjectId(
          anchor.global_object_id,
          anchor.workspace_id
        );

        if (current === null) {
          return await this.createSuggestedAnchor(anchor.global_object_id, anchor.workspace_id, createdBy);
        }

        if (current.mapping_state !== ProjectMappingState.REJECTED) {
          return current;
        }

        return await this.transitionExistingAnchor(current, {
          targetState: ProjectMappingState.SUGGESTED,
          acceptedBy: null,
          causedBy: createdBy,
          fallbackFromState: ProjectMappingState.REJECTED
        });
      }
    );
  }

  private getAnchorOperationKey(globalObjectId: string, workspaceId: string): string {
    return `${workspaceId}::${globalObjectId}`;
  }

  private async runPendingAnchorOperation(
    pendingOperations: Map<string, Promise<Readonly<ProjectMappingAnchor>>>,
    operationKey: string,
    factory: () => Promise<Readonly<ProjectMappingAnchor>>
  ): Promise<Readonly<ProjectMappingAnchor>> {
    const inFlight = pendingOperations.get(operationKey);

    if (inFlight !== undefined) {
      return await inFlight;
    }

    const operation = factory();
    pendingOperations.set(operationKey, operation);

    try {
      return await operation;
    } finally {
      if (pendingOperations.get(operationKey) === operation) {
        pendingOperations.delete(operationKey);
      }
    }
  }

  public async accept(
    mappingId: string,
    acceptedBy: AcceptedByType
  ): Promise<Readonly<ProjectMappingAnchor>> {
    const anchor = await this.getAnchorById(mappingId);

    return await this.transitionExistingAnchor(anchor, {
      targetState: ProjectMappingState.ACCEPTED,
      acceptedBy,
      causedBy: acceptedBy,
      allowedFromStates: [
        ProjectMappingState.SUGGESTED,
        ProjectMappingState.PROBATIONARY,
        ProjectMappingState.ADAPTED
      ],
      fallbackFromState: ProjectMappingState.SUGGESTED
    });
  }

  public async reject(mappingId: string): Promise<Readonly<ProjectMappingAnchor>> {
    const anchor = await this.getAnchorById(mappingId);

    return await this.transitionExistingAnchor(anchor, {
      targetState: ProjectMappingState.REJECTED,
      acceptedBy: null,
      causedBy: "system"
    });
  }

  public async adapt(mappingId: string): Promise<Readonly<ProjectMappingAnchor>> {
    const anchor = await this.getAnchorById(mappingId);

    return await this.transitionExistingAnchor(anchor, {
      targetState: ProjectMappingState.ADAPTED,
      acceptedBy: null,
      causedBy: "system",
      allowedFromStates: [ProjectMappingState.ACCEPTED],
      fallbackFromState: ProjectMappingState.ACCEPTED
    });
  }

  public async setNotApplicable(mappingId: string): Promise<Readonly<ProjectMappingAnchor>> {
    const anchor = await this.getAnchorById(mappingId);

    return await this.transitionExistingAnchor(anchor, {
      targetState: ProjectMappingState.NOT_APPLICABLE,
      acceptedBy: null,
      causedBy: "system"
    });
  }

  public async setProbationary(mappingId: string): Promise<Readonly<ProjectMappingAnchor>> {
    const anchor = await this.getAnchorById(mappingId);

    return await this.transitionExistingAnchor(anchor, {
      targetState: ProjectMappingState.PROBATIONARY,
      acceptedBy: null,
      causedBy: "system",
      allowedFromStates: [ProjectMappingState.SUGGESTED],
      fallbackFromState: ProjectMappingState.SUGGESTED
    });
  }

  public async batchAccept(
    mappingIds: readonly string[],
    acceptedBy: AcceptedByType
  ): Promise<readonly Readonly<ProjectMappingAnchor>[]> {
    const anchors = await this.getAnchorsByIds(mappingIds);
    const memoryById = new Map(
      (
        await this.dependencies.memoryRepo.findByIds(
          anchors.map((anchor) => anchor.global_object_id)
        )
      ).map((memory) => [memory.object_id, memory] as const)
    );
    const strictMappingIds: string[] = [];

    for (const anchor of anchors) {
      const policy = this.getConfirmationPolicyForLoadedMemory(memoryById.get(anchor.global_object_id) ?? null);

      if (policy === ConfirmationPolicy.STRICT) {
        strictMappingIds.push(anchor.object_id);
      }
    }

    if (strictMappingIds.length > 0) {
      throw new StrictConfirmationRequired(strictMappingIds);
    }

    return Object.freeze(
      await Promise.all(
        anchors.map(
          async (anchor) =>
            await this.transitionExistingAnchor(anchor, {
              targetState: ProjectMappingState.ACCEPTED,
              acceptedBy,
              causedBy: acceptedBy,
              allowedFromStates: [
                ProjectMappingState.SUGGESTED,
                ProjectMappingState.PROBATIONARY,
                ProjectMappingState.ADAPTED
              ],
              fallbackFromState: ProjectMappingState.SUGGESTED
            })
        )
      )
    );
  }

  public async getConfirmationPolicy(mappingId: string): Promise<ConfirmationPolicyType> {
    const anchor = await this.getAnchorById(mappingId);
    return await this.getConfirmationPolicyForAnchor(anchor);
  }

  private async getConfirmationPolicyForAnchor(
    anchor: Readonly<ProjectMappingAnchor>
  ): Promise<ConfirmationPolicyType> {
    const memory = await this.dependencies.memoryRepo.findById(anchor.global_object_id);
    return this.getConfirmationPolicyForLoadedMemory(memory);
  }

  private getConfirmationPolicyForLoadedMemory(
    memory: Readonly<MemoryEntry> | null
  ): ConfirmationPolicyType {
    if (memory === null || memory.lifecycle_state === ObjectLifecycleState.TOMBSTONE) {
      return ConfirmationPolicy.PER_ITEM;
    }

    return getProtocolConfirmationPolicy(memory.dimension);
  }

  private async getAnchorsByIds(mappingIds: readonly string[]): Promise<readonly Readonly<ProjectMappingAnchor>[]> {
    const anchors = await this.dependencies.projectMappingRepo.findByIds(mappingIds);
    const anchorsById = new Map(anchors.map((anchor) => [anchor.object_id, anchor] as const));

    return Object.freeze(
      mappingIds.map((mappingId) => {
        const anchor = anchorsById.get(mappingId);

        if (anchor === undefined) {
          throw new CoreError("NOT_FOUND", `Project mapping anchor ${mappingId} was not found.`);
        }

        return anchor;
      })
    );
  }

  private async getAnchorById(mappingId: string): Promise<Readonly<ProjectMappingAnchor>> {
    const anchor = await this.dependencies.projectMappingRepo.findById(mappingId);

    if (anchor === null) {
      throw new CoreError("NOT_FOUND", `Project mapping anchor ${mappingId} was not found.`);
    }

    return anchor;
  }

  private async transitionExistingAnchor(
    anchor: Readonly<ProjectMappingAnchor>,
    options: {
      readonly targetState: ProjectMappingStateType;
      readonly acceptedBy: AcceptedByType | null;
      readonly causedBy: string;
      readonly allowedFromStates?: readonly ProjectMappingStateType[];
      readonly fallbackFromState?: ProjectMappingStateType;
    }
  ): Promise<Readonly<ProjectMappingAnchor>> {
    const fromState = this.resolveFromState(anchor.mapping_state, options);
    const transitionedAt = this.now();
    const revision = await getNextRevision(
      this.dependencies.eventLogRepo,
      ObjectKind.PROJECT_MAPPING_ANCHOR,
      anchor.object_id
    );

    // EventLog-first is intentional: project-mapping transitions are at-least-once. If repo
    // persistence fails after append, recovery should replay from the EventLog entry.
    const event = await this.dependencies.eventLogRepo.append({
      event_type: Phase4CEventType.PROJECT_MAPPING_STATE_CHANGED,
      entity_type: ObjectKind.PROJECT_MAPPING_ANCHOR,
      entity_id: anchor.object_id,
      workspace_id: anchor.workspace_id,
      run_id: null,
      caused_by: options.causedBy,
      revision,
      payload_json: SoulProjectMappingStateChangedPayloadSchema.parse({
        mapping_id: anchor.object_id,
        global_object_id: anchor.global_object_id,
        workspace_id: anchor.workspace_id,
        from_state: fromState,
        to_state: options.targetState,
        accepted_by: options.acceptedBy,
        transitioned_at: transitionedAt
      })
    });

    await this.dependencies.projectMappingRepo.updateState(
      anchor.object_id,
      options.targetState,
      options.acceptedBy,
      transitionedAt
    );
    await this.dependencies.runtimeNotifier?.notifyEntry(event);

    return Object.freeze({
      ...anchor,
      mapping_state: options.targetState,
      accepted_by: options.acceptedBy,
      updated_at: transitionedAt,
      last_transition_at: transitionedAt
    });
  }

  private resolveFromState(
    currentState: ProjectMappingStateType,
    options: {
      readonly targetState: ProjectMappingStateType;
      readonly allowedFromStates?: readonly ProjectMappingStateType[];
      readonly fallbackFromState?: ProjectMappingStateType;
    }
  ): ProjectMappingStateType {
    if (options.allowedFromStates === undefined) {
      return currentState;
    }

    if (options.allowedFromStates.includes(currentState)) {
      return currentState;
    }

    if (currentState === options.targetState && options.fallbackFromState !== undefined) {
      return options.fallbackFromState;
    }

    throw new CoreError(
      "CONFLICT",
      `Project mapping transition ${currentState} -> ${options.targetState} is not allowed.`
    );
  }
}
