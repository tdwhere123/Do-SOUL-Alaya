import { randomUUID } from "node:crypto";
import {
  ObjectKind,
  ObjectLifecycleState,
  ProjectMappingEventType,
  ProjectMappingState,
  SoulProjectMappingStateChangedPayloadSchema,
  SoulProjectMappingSuggestedPayloadSchema,
  type AcceptedBy as AcceptedByType,
  type ConfirmationPolicy as ConfirmationPolicyType,
  type ProjectMappingAnchor,
  type ProjectMappingState as ProjectMappingStateType
} from "@do-soul/alaya-protocol";
import { CoreError } from "../shared/errors.js";
import { ProjectMappingAnchorEnsurer } from "./project-mapping-anchor-ensurer.js";
import {
  findStrictConfirmationMappingIds,
  resolveProjectMappingConfirmationPolicy
} from "./project-mapping-confirmation.js";
import {
  StrictConfirmationRequired,
  type ProjectMappingServiceDependencies
} from "./project-mapping-service-types.js";
import { resolveProjectMappingFromState } from "./project-mapping-transition.js";
export type {
  ProjectMappingServiceDependencies,
  ProjectMappingServiceEventLogRepoPort,
  ProjectMappingServiceMemoryRepoPort,
  ProjectMappingServiceProjectMappingRepoPort,
  ProjectMappingServiceRuntimeNotifierPort
} from "./project-mapping-service-types.js";
export { StrictConfirmationRequired } from "./project-mapping-service-types.js";

export class ProjectMappingService {
  private readonly generateObjectId: () => string;
  private readonly now: () => string;
  private readonly anchorEnsurer: ProjectMappingAnchorEnsurer;

  public constructor(private readonly dependencies: ProjectMappingServiceDependencies) {
    this.generateObjectId = dependencies.generateObjectId ?? (() => randomUUID());
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.anchorEnsurer = new ProjectMappingAnchorEnsurer({
      projectMappingRepo: dependencies.projectMappingRepo,
      createSuggestedAnchor: async (globalObjectId, workspaceId, createdBy) =>
        await this.createSuggestedAnchor(globalObjectId, workspaceId, createdBy),
      transitionExistingAnchor: async (anchor, options) => await this.transitionExistingAnchor(anchor, options)
    });
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

    // EventLog-first is intentional: project-mapping writes are at-least-once. If repo persistence
    // fails after append, reconciliation should treat the EventLog as the source of truth.
    const event = await this.dependencies.eventLogRepo.append({
      event_type: ProjectMappingEventType.PROJECT_MAPPING_SUGGESTED,
      entity_type: ObjectKind.PROJECT_MAPPING_ANCHOR,
      entity_id: anchor.object_id,
      workspace_id: workspaceId,
      run_id: null,
      caused_by: createdBy,
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
    return await this.anchorEnsurer.ensureAnchor(globalObjectId, workspaceId, createdBy, options);
  }

  public async accept(
    mappingId: string,
    acceptedBy: AcceptedByType,
    workspaceId?: string
  ): Promise<Readonly<ProjectMappingAnchor>> {
    const anchor = await this.getAnchorById(mappingId, workspaceId);

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

  public async reject(mappingId: string, workspaceId?: string): Promise<Readonly<ProjectMappingAnchor>> {
    const anchor = await this.getAnchorById(mappingId, workspaceId);

    return await this.transitionExistingAnchor(anchor, {
      targetState: ProjectMappingState.REJECTED,
      acceptedBy: null,
      causedBy: "system"
    });
  }

  public async adapt(mappingId: string, workspaceId?: string): Promise<Readonly<ProjectMappingAnchor>> {
    const anchor = await this.getAnchorById(mappingId, workspaceId);

    return await this.transitionExistingAnchor(anchor, {
      targetState: ProjectMappingState.ADAPTED,
      acceptedBy: null,
      causedBy: "system",
      allowedFromStates: [ProjectMappingState.ACCEPTED],
      fallbackFromState: ProjectMappingState.ACCEPTED
    });
  }

  public async setNotApplicable(mappingId: string, workspaceId?: string): Promise<Readonly<ProjectMappingAnchor>> {
    const anchor = await this.getAnchorById(mappingId, workspaceId);

    return await this.transitionExistingAnchor(anchor, {
      targetState: ProjectMappingState.NOT_APPLICABLE,
      acceptedBy: null,
      causedBy: "system"
    });
  }

  public async setProbationary(mappingId: string, workspaceId?: string): Promise<Readonly<ProjectMappingAnchor>> {
    const anchor = await this.getAnchorById(mappingId, workspaceId);

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
    const memoryIdsByWorkspace = new Map<string, Set<string>>();
    for (const anchor of anchors) {
      const ids = memoryIdsByWorkspace.get(anchor.workspace_id) ?? new Set<string>();
      ids.add(anchor.global_object_id);
      memoryIdsByWorkspace.set(anchor.workspace_id, ids);
    }
    const memories = (
      await Promise.all(
        [...memoryIdsByWorkspace.entries()].map(async ([workspaceId, ids]) =>
          await this.dependencies.memoryRepo.findByIds(workspaceId, [...ids])
        )
      )
    ).flat();
    const memoryById = new Map(memories.map((memory) => [memory.object_id, memory] as const));
    const strictMappingIds = findStrictConfirmationMappingIds(anchors, memoryById);

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
    return resolveProjectMappingConfirmationPolicy(memory);
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

  private async getAnchorById(
    mappingId: string,
    workspaceId?: string
  ): Promise<Readonly<ProjectMappingAnchor>> {
    const anchor = await this.dependencies.projectMappingRepo.findById(mappingId);

    // When a workspace is bound, cross-workspace anchors are indistinguishable
    // from missing ones.
    if (anchor === null || (workspaceId !== undefined && anchor.workspace_id !== workspaceId)) {
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
    const fromState = resolveProjectMappingFromState(anchor.mapping_state, options);
    const transitionedAt = this.now();

    // EventLog-first is intentional: project-mapping transitions are at-least-once. If repo
    // persistence fails after append, recovery should replay from the EventLog entry.
    const event = await this.dependencies.eventLogRepo.append({
      event_type: ProjectMappingEventType.PROJECT_MAPPING_STATE_CHANGED,
      entity_type: ObjectKind.PROJECT_MAPPING_ANCHOR,
      entity_id: anchor.object_id,
      workspace_id: anchor.workspace_id,
      run_id: null,
      caused_by: options.causedBy,
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

}
