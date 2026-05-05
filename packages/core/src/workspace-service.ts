import { randomUUID } from "node:crypto";
import {
  BootstrappingPathsPlantedPayloadSchema,
  EngineBindingInputSchema,
  RuntimeGovernanceEventType,
  WorkspaceRunEventType,
  WorkspaceCreatedPayloadSchema,
  WorkspaceEngineConfigSchema,
  WorkspaceEngineBindingUpdatedPayloadSchema,
  WorkspaceDefaultEngineClassUpdatedPayloadSchema,
  WorkspaceDeletedPayloadSchema,
  WorkspaceCreateInputSchema,
  WorkspaceSchema,
  WorkspaceState,
  type BootstrappingRecord,
  type EngineBindingInput,
  type EngineBindingRecord,
  type PathRelation,
  type Workspace,
  type WorkspaceCreateInput,
  type WorkspaceEngineConfig
} from "@do-soul/alaya-protocol";
import { CoreError } from "./errors.js";
import type { EventPublisher } from "./event-publisher.js";

export interface WorkspaceRepoPort {
  create(data: {
    readonly workspace_id: string;
    readonly name: string;
    readonly root_path: string;
    readonly workspace_kind: Workspace["workspace_kind"];
    readonly repo_path?: Workspace["repo_path"];
    readonly default_engine_binding: Workspace["default_engine_binding"];
    readonly default_engine_class: Workspace["default_engine_class"];
    readonly workspace_state: Workspace["workspace_state"];
  }): Workspace;
  getById(id: string): Promise<Workspace | null>;
  list(): Promise<readonly Workspace[]>;
  delete(id: string): void;
  updateDefaultEngineClass(id: string, engineClass: Workspace["default_engine_class"]): Workspace;
}

export interface WorkspaceRunRepoPort {
  listByWorkspace(workspaceId: string): Promise<readonly { readonly run_id: string }[]>;
}

export interface WorkspaceEngineConfigRepoPort {
  upsertConversationBindingAndSetDefaultEngineClass(input: {
    readonly workspace_id: string;
    readonly binding_id: string;
    readonly binding: EngineBindingInput;
  }): {
    readonly workspace: Workspace;
    readonly binding: EngineBindingRecord;
  };
}

export interface WorkspaceBootstrappingPlannerPort {
  planBootstrap(workspaceId: string): Promise<{
    readonly relations: readonly Readonly<PathRelation>[];
    readonly record: Readonly<BootstrappingRecord>;
  }>;
}

export interface WorkspacePathRelationRepoPort {
  create(relation: PathRelation): Readonly<PathRelation>;
}

export interface WorkspaceBootstrappingRecordRepoPort {
  create(record: BootstrappingRecord): Readonly<BootstrappingRecord>;
  findByWorkspace(workspaceId: string): Readonly<BootstrappingRecord> | null;
}

export interface WorkspaceServiceDependencies {
  readonly workspaceRepo: WorkspaceRepoPort;
  readonly runRepo: WorkspaceRunRepoPort;
  readonly eventPublisher: EventPublisher;
  readonly engineConfigRepo?: WorkspaceEngineConfigRepoPort;
  readonly bootstrappingPlanner?: WorkspaceBootstrappingPlannerPort;
  readonly pathRelationRepo?: WorkspacePathRelationRepoPort;
  readonly bootstrappingRecordRepo?: WorkspaceBootstrappingRecordRepoPort;
}

export type CreateWorkspaceInput = WorkspaceCreateInput;

interface BuildWorkspaceEngineConfigInput {
  readonly workspace_id: string;
  readonly default_engine_class: Workspace["default_engine_class"];
  readonly conversation_binding: WorkspaceEngineConfig["conversation_binding"];
  readonly coding_engine_available: boolean;
}

export class WorkspaceService {
  public constructor(private readonly dependencies: WorkspaceServiceDependencies) {}

  public async create(input: unknown): Promise<Workspace> {
    const parsed = parseCreateWorkspaceInput(input);
    const workspaceId = `ws_${randomUUID()}`;
    const bootstrappingDeps = this.resolveBootstrappingDependencies();
    const createWorkspaceArgs = {
      workspace_id: workspaceId,
      name: parsed.name,
      root_path: parsed.root_path,
      workspace_kind: parsed.workspace_kind,
      repo_path: parsed.repo_path ?? null,
      default_engine_binding: parsed.default_engine_binding ?? null,
      default_engine_class: null,
      workspace_state: WorkspaceState.ACTIVE
    } as const;
    const workspaceCreatedEvent = this.buildWorkspaceCreatedEvent({
      workspaceId,
      name: parsed.name,
      workspaceKind: parsed.workspace_kind
    });

    if (bootstrappingDeps === null) {
      return await this.dependencies.eventPublisher.appendManyWithMutation(
        [workspaceCreatedEvent],
        () => this.dependencies.workspaceRepo.create(createWorkspaceArgs)
      );
    }

    // Pre-compute the bootstrap plan outside the SQLite transaction so its
    // async planner stays async. The findByWorkspace check inside the mutate
    // remains idempotent and now uses `findByWorkspace` so the whole
    // mutate is synchronous.
    const existingBootstrappingRecord = await bootstrappingDeps.bootstrappingRecordRepo.findByWorkspace(
      workspaceId
    );
    const bootstrapPlan =
      existingBootstrappingRecord === null
        ? await bootstrappingDeps.bootstrappingPlanner.planBootstrap(workspaceId)
        : null;
    const events =
      bootstrapPlan === null
        ? [workspaceCreatedEvent]
        : [workspaceCreatedEvent, this.buildBootstrappingPathsPlantedEvent(bootstrapPlan.record)];

    return await this.dependencies.eventPublisher.appendManyWithMutation(events, () => {
      // All four mutations (workspace.create, bootstrap.findByWorkspace,
      // path_relations.create xN, bootstrap.create) commit (or roll back)
      // in one SQLite transaction. The prior async manual rollback of
      // workspace.delete on bootstrap failure is no longer needed — any
      // throw inside this callback triggers the SQLite rollback, undoing
      // the workspace insert atomically.
      const createdWorkspace = this.dependencies.workspaceRepo.create(createWorkspaceArgs);
      const persistedBootstrappingRecord =
        bootstrappingDeps.bootstrappingRecordRepo.findByWorkspace(createdWorkspace.workspace_id);

      if (persistedBootstrappingRecord !== null || bootstrapPlan === null) {
        return createdWorkspace;
      }

      for (const relation of bootstrapPlan.relations) {
        bootstrappingDeps.pathRelationRepo.create(relation);
      }

      bootstrappingDeps.bootstrappingRecordRepo.create(bootstrapPlan.record);
      return createdWorkspace;
    });
  }

  public list(): Promise<readonly Workspace[]> {
    return this.dependencies.workspaceRepo.list();
  }

  public async getById(workspaceId: string): Promise<Workspace> {
    const workspace = await this.dependencies.workspaceRepo.getById(workspaceId);

    if (workspace === null) {
      throw new CoreError("NOT_FOUND", "Workspace not found");
    }

    return workspace;
  }

  public async delete(workspaceId: string): Promise<Workspace> {
    const workspace = await this.getById(workspaceId);
    const runs = await this.dependencies.runRepo.listByWorkspace(workspaceId);

    if (runs.length > 0) {
      throw new CoreError("CONFLICT", "Workspace has active runs");
    }

    await this.dependencies.eventPublisher.appendManyWithMutation(
      [
        {
          event_type: WorkspaceRunEventType.WORKSPACE_DELETED,
          entity_type: "workspace",
          entity_id: workspace.workspace_id,
          workspace_id: workspace.workspace_id,
          run_id: null,
          caused_by: "user_action",
          payload_json: WorkspaceDeletedPayloadSchema.parse({
            workspace_id: workspace.workspace_id
          })
        }
      ],
      () => {
        this.dependencies.workspaceRepo.delete(workspace.workspace_id);
      }
    );

    return workspace;
  }

  public async updateDefaultEngineClass(
    workspaceId: string,
    engineClass: Workspace["default_engine_class"]
  ): Promise<Workspace> {
    const workspace = await this.getById(workspaceId);

    return await this.dependencies.eventPublisher.appendManyWithMutation(
      [
        {
          event_type: WorkspaceRunEventType.WORKSPACE_DEFAULT_ENGINE_CLASS_UPDATED,
          entity_type: "workspace",
          entity_id: workspace.workspace_id,
          workspace_id: workspace.workspace_id,
          run_id: null,
          caused_by: "user_action",
          payload_json: WorkspaceDefaultEngineClassUpdatedPayloadSchema.parse({
            workspace_id: workspace.workspace_id,
            default_engine_class: engineClass ?? null
          })
        }
      ],
      () => this.dependencies.workspaceRepo.updateDefaultEngineClass(workspace.workspace_id, engineClass ?? null)
    );
  }

  public async updateConversationEngineConfig(
    workspaceId: string,
    bindingInput: unknown
  ): Promise<{
    readonly workspace: Workspace;
    readonly binding: EngineBindingRecord;
  }> {
    if (this.dependencies.engineConfigRepo === undefined) {
      throw new CoreError(
        "CONFLICT",
        "conversation_engine update is unavailable because backend engine-config persistence is not configured"
      );
    }

    const workspace = await this.getById(workspaceId);
    const parsedBinding = parseEngineBindingInput(bindingInput);
    const bindingId = `binding_${randomUUID()}`;

    return await this.dependencies.eventPublisher.appendManyWithMutation(
      [
        {
          event_type: WorkspaceRunEventType.WORKSPACE_ENGINE_BINDING_UPDATED,
          entity_type: "workspace",
          entity_id: workspace.workspace_id,
          workspace_id: workspace.workspace_id,
          run_id: null,
          caused_by: "user_action",
          payload_json: WorkspaceEngineBindingUpdatedPayloadSchema.parse({
            workspace_id: workspace.workspace_id,
            binding_id: bindingId,
            provider_type: parsedBinding.provider_type,
            model: parsedBinding.model,
            base_url: parsedBinding.base_url
          })
        },
        {
          event_type: WorkspaceRunEventType.WORKSPACE_DEFAULT_ENGINE_CLASS_UPDATED,
          entity_type: "workspace",
          entity_id: workspace.workspace_id,
          workspace_id: workspace.workspace_id,
          run_id: null,
          caused_by: "user_action",
          payload_json: WorkspaceDefaultEngineClassUpdatedPayloadSchema.parse({
            workspace_id: workspace.workspace_id,
            default_engine_class: "conversation_engine"
          })
        }
      ],
      () =>
        this.dependencies.engineConfigRepo!.upsertConversationBindingAndSetDefaultEngineClass({
          workspace_id: workspace.workspace_id,
          binding_id: bindingId,
          binding: parsedBinding
        })
    );
  }

  public buildEngineConfig(input: BuildWorkspaceEngineConfigInput): WorkspaceEngineConfig {
    return WorkspaceEngineConfigSchema.parse({
      workspace_id: input.workspace_id,
      default_engine_class: input.default_engine_class ?? null,
      conversation_binding: input.conversation_binding,
      coding_engine_available: input.coding_engine_available
    });
  }

  private resolveBootstrappingDependencies(): {
    readonly bootstrappingPlanner: WorkspaceBootstrappingPlannerPort;
    readonly pathRelationRepo: WorkspacePathRelationRepoPort;
    readonly bootstrappingRecordRepo: WorkspaceBootstrappingRecordRepoPort;
  } | null {
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

  private buildWorkspaceCreatedEvent(input: {
    readonly workspaceId: string;
    readonly name: string;
    readonly workspaceKind: Workspace["workspace_kind"];
  }) {
    return {
      event_type: WorkspaceRunEventType.WORKSPACE_CREATED,
      entity_type: "workspace",
      entity_id: input.workspaceId,
      workspace_id: input.workspaceId,
      run_id: null,
      caused_by: "user_action",
      payload_json: WorkspaceCreatedPayloadSchema.parse({
        workspace_id: input.workspaceId,
        name: input.name,
        workspace_kind: input.workspaceKind
      })
    } as const;
  }

  private buildBootstrappingPathsPlantedEvent(record: Readonly<BootstrappingRecord>) {
    return {
      event_type: RuntimeGovernanceEventType.BOOTSTRAPPING_PATHS_PLANTED,
      entity_type: "workspace",
      entity_id: record.workspace_id,
      workspace_id: record.workspace_id,
      run_id: null,
      caused_by: "system",
      payload_json: BootstrappingPathsPlantedPayloadSchema.parse({
        record_id: record.record_id,
        workspace_id: record.workspace_id,
        paths_planted: record.paths_planted,
        template_ids: record.template_ids_used,
        planted_at: record.planted_at
      })
    } as const;
  }
}

function parseCreateWorkspaceInput(input: unknown): CreateWorkspaceInput {
  try {
    return WorkspaceCreateInputSchema.parse(input);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid request body", { cause: error });
  }
}

function parseEngineBindingInput(input: unknown): EngineBindingInput {
  try {
    return EngineBindingInputSchema.parse(input);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid request body", { cause: error });
  }
}
