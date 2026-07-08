import {
  ProjectMappingState,
  type AcceptedBy as AcceptedByType,
  type ProjectMappingAnchor,
  type ProjectMappingState as ProjectMappingStateType
} from "@do-soul/alaya-protocol";

import type { ProjectMappingServiceProjectMappingRepoPort } from "./project-mapping-service-types.js";

interface ProjectMappingTransitionOptions {
  readonly targetState: ProjectMappingStateType;
  readonly acceptedBy: AcceptedByType | null;
  readonly causedBy: string;
  readonly allowedFromStates?: readonly ProjectMappingStateType[];
  readonly fallbackFromState?: ProjectMappingStateType;
}

export interface ProjectMappingAnchorEnsurerDependencies {
  readonly projectMappingRepo: ProjectMappingServiceProjectMappingRepoPort;
  readonly createSuggestedAnchor: (
    globalObjectId: string,
    workspaceId: string,
    createdBy: string
  ) => Promise<Readonly<ProjectMappingAnchor>>;
  readonly transitionExistingAnchor: (
    anchor: Readonly<ProjectMappingAnchor>,
    options: ProjectMappingTransitionOptions
  ) => Promise<Readonly<ProjectMappingAnchor>>;
}

export class ProjectMappingAnchorEnsurer {
  private readonly pendingAnchorCreations = new Map<string, Promise<Readonly<ProjectMappingAnchor>>>();
  private readonly pendingAnchorRevivals = new Map<string, Promise<Readonly<ProjectMappingAnchor>>>();

  public constructor(private readonly dependencies: ProjectMappingAnchorEnsurerDependencies) {}

  public async ensureAnchor(
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

        return await this.dependencies.createSuggestedAnchor(globalObjectId, workspaceId, createdBy);
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
          return await this.dependencies.createSuggestedAnchor(anchor.global_object_id, anchor.workspace_id, createdBy);
        }

        if (current.mapping_state !== ProjectMappingState.REJECTED) {
          return current;
        }

        return await this.dependencies.transitionExistingAnchor(current, {
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
}
