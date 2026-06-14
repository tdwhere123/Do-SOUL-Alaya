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
  WorkspaceKind,
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
import { CoreError } from "../shared/errors.js";
import type { EventPublisher } from "../runtime/event-publisher.js";

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
  list(page?: WorkspaceListPageOptions): Promise<readonly Workspace[]>;
  count?(): Promise<number>;
  delete(id: string): void;
  updateDefaultEngineClass(id: string, engineClass: Workspace["default_engine_class"]): Workspace;
}

export interface WorkspaceListPageOptions {
  readonly limit: number;
  readonly offset: number;
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
  // invariant: includes retired rows; reconcileBootstrapPaths uses this
  // as the "any relation present" signal.
  findByWorkspace(workspaceId: string): Promise<readonly Readonly<PathRelation>[]>;
}

export interface WorkspaceBootstrappingRecordRepoPort {
  create(record: BootstrappingRecord): Readonly<BootstrappingRecord>;
  findByWorkspace(workspaceId: string): Readonly<BootstrappingRecord> | null;
}

export type WorkspaceBootstrapReconcileResult = Readonly<
  | {
      readonly status: "planted";
      readonly workspace_id: string;
      readonly paths_planted: number;
      readonly record_id: string;
      readonly template_ids: readonly string[];
    }
  | {
      readonly status: "already_planted";
      readonly workspace_id: string;
      readonly record_id: string | null;
      // invariant: relation_count counts ALL relations for the workspace
      // including retired ones; reconcile uses any-relation-present as a
      // "do not re-plant" signal regardless of lifecycle status.
      readonly relation_count: number;
    }
  | {
      readonly status: "corrupt_partial";
      readonly workspace_id: string;
      readonly record_id: string;
      readonly relation_count: 0;
      readonly reason: "bootstrapping_record_without_relations";
    }
  | {
      readonly status: "skipped_no_templates";
      readonly workspace_id: string;
      readonly template_ids: readonly string[];
    }
  | {
      readonly status: "skipped_no_planner";
      readonly workspace_id: string;
    }
>;

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
    return await this.createWithId(parsed, workspaceId);
  }

  public async ensureLocalWorkspace(input: {
    readonly workspaceId: string;
    readonly name: string;
    readonly rootPath: string;
    readonly repoPath?: string | null;
  }): Promise<Workspace> {
    const workspaceId = parseRequiredString(input.workspaceId, "workspace_id");
    const rootPath = parseRequiredString(input.rootPath, "root_path");
    const existing = await this.dependencies.workspaceRepo.getById(workspaceId);
    if (existing !== null) {
      return existing;
    }

    try {
      return await this.createWithId(
        {
          name: input.name,
          root_path: rootPath,
          workspace_kind: WorkspaceKind.LOCAL_REPO,
          repo_path: input.repoPath ?? rootPath,
          default_engine_binding: null
        },
        workspaceId
      );
    } catch (error) {
      if (!isWorkspaceIdDuplicateCreateError(error)) {
        throw error;
      }

      const racedWorkspace = await this.dependencies.workspaceRepo.getById(workspaceId);
      if (racedWorkspace !== null) {
        return racedWorkspace;
      }

      throw error;
    }
  }

  private async createWithId(
    parsed: CreateWorkspaceInput,
    workspaceId: string
  ): Promise<Workspace> {
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
    const shouldPlantBootstrapPlan =
      bootstrapPlan !== null && bootstrapPlan.relations.length > 0;
    const events =
      !shouldPlantBootstrapPlan
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

      if (persistedBootstrappingRecord !== null || !shouldPlantBootstrapPlan) {
        return createdWorkspace;
      }

      for (const relation of bootstrapPlan.relations) {
        bootstrappingDeps.pathRelationRepo.create(relation);
      }

      bootstrappingDeps.bootstrappingRecordRepo.create(bootstrapPlan.record);
      return createdWorkspace;
    });
  }

  public async reconcileBootstrapPaths(
    workspaceId: string,
    options?: { readonly causedBy?: "system" | "user_action" }
  ): Promise<WorkspaceBootstrapReconcileResult> {
    const bootstrappingDeps = this.resolveBootstrappingDependencies();
    if (bootstrappingDeps === null) {
      return { status: "skipped_no_planner", workspace_id: workspaceId };
    }

    const workspace = await this.dependencies.workspaceRepo.getById(workspaceId);
    if (workspace === null) {
      throw new CoreError("NOT_FOUND", "Workspace not found");
    }

    const existingRecord =
      bootstrappingDeps.bootstrappingRecordRepo.findByWorkspace(workspaceId);
    const existingRelations =
      await bootstrappingDeps.pathRelationRepo.findByWorkspace(workspaceId);
    if (existingRecord !== null && existingRelations.length === 0) {
      return {
        status: "corrupt_partial",
        workspace_id: workspaceId,
        record_id: existingRecord.record_id,
        relation_count: 0,
        reason: "bootstrapping_record_without_relations"
      };
    }

    if (existingRecord !== null || existingRelations.length > 0) {
      return {
        status: "already_planted",
        workspace_id: workspaceId,
        record_id: existingRecord === null ? null : existingRecord.record_id,
        relation_count: existingRelations.length
      };
    }

    const bootstrapPlan =
      await bootstrappingDeps.bootstrappingPlanner.planBootstrap(workspaceId);
    if (bootstrapPlan.relations.length === 0) {
      return {
        status: "skipped_no_templates",
        workspace_id: workspaceId,
        template_ids: bootstrapPlan.record.template_ids_used
      };
    }

    const plantedEvent = this.buildBootstrappingPathsPlantedEvent(
      bootstrapPlan.record,
      options?.causedBy ?? "system"
    );

    let plantedCount = 0;
    let racedRecordId: string | null = null;
    try {
      await this.dependencies.eventPublisher.appendManyWithMutation(
        [plantedEvent],
        () => {
          // @anchor: race-guard mirrors createWithId:185-206 but throws so
          // SQLite rolls back the queued BOOTSTRAPPING_PATHS_PLANTED event
          // together with any partial inserts. Returning normally would
          // commit an event with no matching mutation.
          const racedRecord =
            bootstrappingDeps.bootstrappingRecordRepo.findByWorkspace(
              workspaceId
            );
          if (racedRecord !== null) {
            throw new BootstrapReconcileRaceError(racedRecord);
          }

          for (const relation of bootstrapPlan.relations) {
            bootstrappingDeps.pathRelationRepo.create(relation);
            plantedCount += 1;
          }
          bootstrappingDeps.bootstrappingRecordRepo.create(bootstrapPlan.record);
        }
      );
    } catch (error) {
      const raceError = extractBootstrapReconcileRaceError(error);
      if (raceError !== null) {
        racedRecordId = raceError.racedRecord.record_id;
      } else {
        throw error;
      }
    }

    if (racedRecordId !== null) {
      const racedRelations =
        await bootstrappingDeps.pathRelationRepo.findByWorkspace(workspaceId);
      if (racedRelations.length === 0) {
        return {
          status: "corrupt_partial",
          workspace_id: workspaceId,
          record_id: racedRecordId,
          relation_count: 0,
          reason: "bootstrapping_record_without_relations"
        };
      }

      return {
        status: "already_planted",
        workspace_id: workspaceId,
        record_id: racedRecordId,
        relation_count: racedRelations.length
      };
    }

    return {
      status: "planted",
      workspace_id: workspaceId,
      paths_planted: plantedCount,
      record_id: bootstrapPlan.record.record_id,
      template_ids: bootstrapPlan.record.template_ids_used
    };
  }

  public list(page?: WorkspaceListPageOptions): Promise<readonly Workspace[]> {
    return this.dependencies.workspaceRepo.list(page);
  }

  public async count(): Promise<number> {
    const count = this.dependencies.workspaceRepo.count;
    if (count !== undefined) {
      return await count.call(this.dependencies.workspaceRepo);
    }
    return (await this.dependencies.workspaceRepo.list()).length;
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

  private buildBootstrappingPathsPlantedEvent(
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
}

function parseCreateWorkspaceInput(input: unknown): CreateWorkspaceInput {
  try {
    return WorkspaceCreateInputSchema.parse(input);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid request body", { cause: error });
  }
}

function parseRequiredString(value: string, field: string): string {
  if (value.trim().length === 0) {
    throw new CoreError("VALIDATION", `${field} is required`);
  }
  return value;
}

function parseEngineBindingInput(input: unknown): EngineBindingInput {
  try {
    return EngineBindingInputSchema.parse(input);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid request body", { cause: error });
  }
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
function extractBootstrapReconcileRaceError(
  error: unknown
): BootstrapReconcileRaceError | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    if (current instanceof BootstrapReconcileRaceError) {
      return current;
    }
    current = (current as { readonly cause?: unknown }).cause;
  }
  return null;
}

// Prefer the structured DUPLICATE_KEY surfaced by SqliteWorkspaceRepo.create.
// Walk a few cause levels so future intermediary wrappers cannot silently
// bury the code by re-wrapping the StorageError.
function isWorkspaceIdDuplicateCreateError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    const codeValue = (current as { readonly code?: unknown }).code;
    if (codeValue === "DUPLICATE_KEY") {
      return true;
    }
    current = (current as { readonly cause?: unknown }).cause;
  }
  return false;
}
