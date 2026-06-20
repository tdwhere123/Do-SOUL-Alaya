import {
  BootstrappingPathsPlantedPayloadSchema,
  RuntimeGovernanceEventType,
  WorkspaceState,
  type BootstrappingRecord,
  type PathRelation,
  type Workspace,
  type WorkspaceCreateInput
} from "@do-soul/alaya-protocol";

import { CoreError } from "../shared/errors.js";
import type { EventPublisher, EventPublisherInput } from "../runtime/event-publisher.js";

import type {
  WorkspaceBootstrapReconcileResult,
  WorkspaceBootstrappingPlannerPort,
  WorkspaceBootstrappingRecordRepoPort,
  WorkspacePathRelationRepoPort,
  WorkspaceRepoPort
} from "./workspace-service-ports.js";

interface WorkspaceBootstrappingDependencies {
  readonly bootstrappingPlanner: WorkspaceBootstrappingPlannerPort;
  readonly pathRelationRepo: WorkspacePathRelationRepoPort;
  readonly bootstrappingRecordRepo: WorkspaceBootstrappingRecordRepoPort;
}

interface BootstrapReconcileState {
  readonly bootstrappingDeps: WorkspaceBootstrappingDependencies;
}

interface BootstrapPlantResult {
  readonly plantedCount: number;
  readonly racedRecordId: string | null;
}

type WorkspaceCreateArgs = Parameters<WorkspaceRepoPort["create"]>[0];
type WorkspaceBootstrapPlan = Awaited<ReturnType<WorkspaceBootstrappingPlannerPort["planBootstrap"]>>;

interface WorkspaceBootstrapEventPublisherPort
  extends Pick<EventPublisher, "appendManyWithMutation"> {}

export interface WorkspaceBootstrapCoordinatorDependencies {
  readonly workspaceRepo: Pick<WorkspaceRepoPort, "create" | "getById">;
  readonly eventPublisher: WorkspaceBootstrapEventPublisherPort;
  readonly bootstrappingPlanner?: WorkspaceBootstrappingPlannerPort;
  readonly pathRelationRepo?: WorkspacePathRelationRepoPort;
  readonly bootstrappingRecordRepo?: WorkspaceBootstrappingRecordRepoPort;
}

class BootstrapReconcileRaceError extends Error {
  public readonly racedRecord: Readonly<BootstrappingRecord>;
  public constructor(racedRecord: Readonly<BootstrappingRecord>) {
    super("bootstrap_reconcile_race");
    this.racedRecord = racedRecord;
  }
}

// EventPublisher may wrap mutate-callback throws (e.g. inside
// EventPublisherPropagationError); unwrap a bounded cause chain so the
// race sentinel survives.
function extractBootstrapReconcileRaceError(error: unknown): BootstrapReconcileRaceError | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    if (current instanceof BootstrapReconcileRaceError) {
      return current;
    }
    current = (current as { readonly cause?: unknown }).cause;
  }
  return null;
}

function buildWorkspaceCreateArgs(parsed: WorkspaceCreateInput, workspaceId: string): WorkspaceCreateArgs {
  return {
    workspace_id: workspaceId,
    name: parsed.name,
    root_path: parsed.root_path,
    workspace_kind: parsed.workspace_kind,
    repo_path: parsed.repo_path ?? null,
    default_engine_binding: parsed.default_engine_binding ?? null,
    default_engine_class: null,
    workspace_state: WorkspaceState.ACTIVE
  };
}

async function loadWorkspaceBootstrapPlan(
  bootstrappingDeps: WorkspaceBootstrappingDependencies,
  workspaceId: string
): Promise<WorkspaceBootstrapPlan | null> {
  const existingBootstrappingRecord =
    bootstrappingDeps.bootstrappingRecordRepo.findByWorkspace(workspaceId);
  return existingBootstrappingRecord === null
    ? await bootstrappingDeps.bootstrappingPlanner.planBootstrap(workspaceId)
    : null;
}

function classifyExistingBootstrapState(
  workspaceId: string,
  existingRecord: Readonly<BootstrappingRecord> | null,
  existingRelations: readonly Readonly<PathRelation>[]
): WorkspaceBootstrapReconcileResult | null {
  if (existingRecord !== null && existingRelations.length === 0) {
    return corruptBootstrapRecordResult(workspaceId, existingRecord.record_id);
  }
  if (existingRecord !== null || existingRelations.length > 0) {
    return {
      status: "already_planted",
      workspace_id: workspaceId,
      record_id: existingRecord === null ? null : existingRecord.record_id,
      relation_count: existingRelations.length
    };
  }
  return null;
}

function corruptBootstrapRecordResult(workspaceId: string, recordId: string): WorkspaceBootstrapReconcileResult {
  return {
    status: "corrupt_partial",
    workspace_id: workspaceId,
    record_id: recordId,
    relation_count: 0,
    reason: "bootstrapping_record_without_relations"
  };
}

async function resolveBootstrapRaceResult(
  bootstrappingDeps: WorkspaceBootstrappingDependencies,
  workspaceId: string,
  racedRecordId: string
): Promise<WorkspaceBootstrapReconcileResult> {
  const racedRelations = await bootstrappingDeps.pathRelationRepo.findByWorkspace(workspaceId);
  if (racedRelations.length === 0) {
    return corruptBootstrapRecordResult(workspaceId, racedRecordId);
  }
  return {
    status: "already_planted",
    workspace_id: workspaceId,
    record_id: racedRecordId,
    relation_count: racedRelations.length
  };
}

function buildBootstrappingPathsPlantedEvent(
  record: Readonly<BootstrappingRecord>,
  causedBy: "system" | "user_action" = "system"
) {
  return {
    event_type: RuntimeGovernanceEventType.BOOTSTRAPPING_PATHS_PLANTED,
    entity_type: "workspace" as const,
    entity_id: record.workspace_id,
    workspace_id: record.workspace_id,
    run_id: null,
    caused_by: causedBy,
    payload_json: BootstrappingPathsPlantedPayloadSchema.parse({
      record_id: record.record_id,
      workspace_id: record.workspace_id,
      paths_planted: record.paths_planted,
      template_ids: record.template_ids_used,
      planted_at: record.planted_at
    })
  };
}

export class WorkspaceBootstrapCoordinator {
  private readonly dependencies: WorkspaceBootstrapCoordinatorDependencies;

  public constructor(dependencies: WorkspaceBootstrapCoordinatorDependencies) {
    this.dependencies = dependencies;
  }

  public async createWorkspace(
    parsed: WorkspaceCreateInput,
    workspaceId: string,
    workspaceCreatedEvent: EventPublisherInput
  ): Promise<Workspace> {
    const bootstrappingDeps = this.resolveBootstrappingDependencies();
    const createWorkspaceArgs = buildWorkspaceCreateArgs(parsed, workspaceId);

    if (bootstrappingDeps === null) {
      return await this.createWorkspaceWithoutBootstrap(createWorkspaceArgs, workspaceCreatedEvent);
    }

    const bootstrapPlan = await loadWorkspaceBootstrapPlan(bootstrappingDeps, workspaceId);
    const shouldPlantBootstrapPlan = bootstrapPlan !== null && bootstrapPlan.relations.length > 0;
    const events = shouldPlantBootstrapPlan
      ? [workspaceCreatedEvent, buildBootstrappingPathsPlantedEvent(bootstrapPlan.record)]
      : [workspaceCreatedEvent];

    return await this.createWorkspaceWithBootstrapPlan({
      createWorkspaceArgs,
      bootstrappingDeps,
      bootstrapPlan,
      shouldPlantBootstrapPlan,
      events
    });
  }

  public async reconcileBootstrapPaths(
    workspaceId: string,
    options?: { readonly causedBy?: "system" | "user_action" }
  ): Promise<WorkspaceBootstrapReconcileResult> {
    const state = await this.loadBootstrapReconcileState(workspaceId);
    if ("status" in state) {
      return state;
    }

    const bootstrapPlan = await state.bootstrappingDeps.bootstrappingPlanner.planBootstrap(workspaceId);
    if (bootstrapPlan.relations.length === 0) {
      return {
        status: "skipped_no_templates",
        workspace_id: workspaceId,
        template_ids: bootstrapPlan.record.template_ids_used
      };
    }

    const plantResult = await this.plantBootstrapPlan({
      workspaceId,
      bootstrappingDeps: state.bootstrappingDeps,
      bootstrapPlan,
      causedBy: options?.causedBy ?? "system"
    });
    if (plantResult.racedRecordId !== null) {
      return await resolveBootstrapRaceResult(
        state.bootstrappingDeps,
        workspaceId,
        plantResult.racedRecordId
      );
    }

    return {
      status: "planted",
      workspace_id: workspaceId,
      paths_planted: plantResult.plantedCount,
      record_id: bootstrapPlan.record.record_id,
      template_ids: bootstrapPlan.record.template_ids_used
    };
  }

  private resolveBootstrappingDependencies(): WorkspaceBootstrappingDependencies | null {
    if (
      this.dependencies.bootstrappingPlanner === undefined ||
      this.dependencies.pathRelationRepo === undefined ||
      this.dependencies.bootstrappingRecordRepo === undefined
    ) {
      return null;
    }

    return {
      bootstrappingPlanner: this.dependencies.bootstrappingPlanner,
      pathRelationRepo: this.dependencies.pathRelationRepo,
      bootstrappingRecordRepo: this.dependencies.bootstrappingRecordRepo
    };
  }

  private async createWorkspaceWithoutBootstrap(
    createWorkspaceArgs: WorkspaceCreateArgs,
    workspaceCreatedEvent: EventPublisherInput
  ): Promise<Workspace> {
    return await this.dependencies.eventPublisher.appendManyWithMutation([workspaceCreatedEvent], () =>
      this.dependencies.workspaceRepo.create(createWorkspaceArgs)
    );
  }

  private async createWorkspaceWithBootstrapPlan(
    params: Readonly<{
      readonly createWorkspaceArgs: WorkspaceCreateArgs;
      readonly bootstrappingDeps: WorkspaceBootstrappingDependencies;
      readonly bootstrapPlan: WorkspaceBootstrapPlan | null;
      readonly shouldPlantBootstrapPlan: boolean;
      readonly events: readonly EventPublisherInput[];
    }>
  ): Promise<Workspace> {
    return await this.dependencies.eventPublisher.appendManyWithMutation(params.events, () => {
      const createdWorkspace = this.dependencies.workspaceRepo.create(params.createWorkspaceArgs);
      const persistedBootstrappingRecord =
        params.bootstrappingDeps.bootstrappingRecordRepo.findByWorkspace(createdWorkspace.workspace_id);
      if (persistedBootstrappingRecord !== null || !params.shouldPlantBootstrapPlan || params.bootstrapPlan === null) {
        return createdWorkspace;
      }
      for (const relation of params.bootstrapPlan.relations) {
        params.bootstrappingDeps.pathRelationRepo.create(relation);
      }
      params.bootstrappingDeps.bootstrappingRecordRepo.create(params.bootstrapPlan.record);
      return createdWorkspace;
    });
  }

  private async loadBootstrapReconcileState(
    workspaceId: string
  ): Promise<WorkspaceBootstrapReconcileResult | BootstrapReconcileState> {
    const bootstrappingDeps = this.resolveBootstrappingDependencies();
    if (bootstrappingDeps === null) {
      return { status: "skipped_no_planner", workspace_id: workspaceId };
    }
    const workspace = await this.dependencies.workspaceRepo.getById(workspaceId);
    if (workspace === null) {
      throw new CoreError("NOT_FOUND", "Workspace not found");
    }
    const existingRecord = bootstrappingDeps.bootstrappingRecordRepo.findByWorkspace(workspaceId);
    const existingRelations = await bootstrappingDeps.pathRelationRepo.findByWorkspace(workspaceId);
    const existingResult = classifyExistingBootstrapState(workspaceId, existingRecord, existingRelations);
    return existingResult ?? Object.freeze({ bootstrappingDeps });
  }

  private async plantBootstrapPlan(
    params: Readonly<{
      readonly workspaceId: string;
      readonly bootstrappingDeps: WorkspaceBootstrappingDependencies;
      readonly bootstrapPlan: WorkspaceBootstrapPlan;
      readonly causedBy: "system" | "user_action";
    }>
  ): Promise<BootstrapPlantResult> {
    const plantedEvent = buildBootstrappingPathsPlantedEvent(params.bootstrapPlan.record, params.causedBy);
    let plantedCount = 0;
    let racedRecordId: string | null = null;
    try {
      await this.dependencies.eventPublisher.appendManyWithMutation([plantedEvent], () => {
        const racedRecord = params.bootstrappingDeps.bootstrappingRecordRepo.findByWorkspace(params.workspaceId);
        if (racedRecord !== null) {
          throw new BootstrapReconcileRaceError(racedRecord);
        }
        for (const relation of params.bootstrapPlan.relations) {
          params.bootstrappingDeps.pathRelationRepo.create(relation);
          plantedCount += 1;
        }
        params.bootstrappingDeps.bootstrappingRecordRepo.create(params.bootstrapPlan.record);
      });
    } catch (error) {
      const raceError = extractBootstrapReconcileRaceError(error);
      if (raceError === null) {
        throw error;
      }
      racedRecordId = raceError.racedRecord.record_id;
    }
    return Object.freeze({ plantedCount, racedRecordId });
  }
}
