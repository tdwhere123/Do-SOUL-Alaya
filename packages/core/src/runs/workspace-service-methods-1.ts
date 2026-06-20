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
type WorkspaceServiceMethodOwner = {
  dependencies: WorkspaceServiceDependencies;
  [key: string]: any;
};

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

export async function workspaceServiceCreate(owner: WorkspaceServiceMethodOwner, input: unknown): Promise<Workspace> {
    const parsed = parseCreateWorkspaceInput(input);
    const workspaceId = `ws_${randomUUID()}`;
    return await owner.createWithId(parsed, workspaceId);
  }

export async function workspaceServiceEnsureLocalWorkspace(owner: WorkspaceServiceMethodOwner, input: {
    readonly workspaceId: string;
    readonly name: string;
    readonly rootPath: string;
    readonly repoPath?: string | null;
  }): Promise<Workspace> {
    const workspaceId = parseRequiredString(input.workspaceId, "workspace_id");
    const rootPath = parseRequiredString(input.rootPath, "root_path");
    const existing = await owner.dependencies.workspaceRepo.getById(workspaceId);
    if (existing !== null) {
      return existing;
    }

    try {
      return await owner.createWithId(
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

      const racedWorkspace = await owner.dependencies.workspaceRepo.getById(workspaceId);
      if (racedWorkspace !== null) {
        return racedWorkspace;
      }

      throw error;
    }
  }

export async function workspaceServiceCreateWithId(owner: WorkspaceServiceMethodOwner, parsed: CreateWorkspaceInput, workspaceId: string): Promise<Workspace> {
    const bootstrappingDeps = owner.resolveBootstrappingDependencies();
    const createWorkspaceArgs = buildWorkspaceCreateArgs(parsed, workspaceId);
    const workspaceCreatedEvent = owner.buildWorkspaceCreatedEvent({
      workspaceId,
      name: parsed.name,
      workspaceKind: parsed.workspace_kind
    });

    if (bootstrappingDeps === null) {
      return await createWorkspaceWithoutBootstrap(owner, createWorkspaceArgs, workspaceCreatedEvent);
    }

    const bootstrapPlan = await loadWorkspaceBootstrapPlan(bootstrappingDeps, workspaceId);
    const shouldPlantBootstrapPlan = bootstrapPlan !== null && bootstrapPlan.relations.length > 0;
    const events = shouldPlantBootstrapPlan
      ? [workspaceCreatedEvent, owner.buildBootstrappingPathsPlantedEvent(bootstrapPlan.record)]
      : [workspaceCreatedEvent];

    return await createWorkspaceWithBootstrapPlan(owner, {
      createWorkspaceArgs,
      bootstrappingDeps,
      bootstrapPlan,
      shouldPlantBootstrapPlan,
      events
    });
  }

function buildWorkspaceCreateArgs(parsed: CreateWorkspaceInput, workspaceId: string): WorkspaceCreateArgs {
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

async function createWorkspaceWithoutBootstrap(owner: WorkspaceServiceMethodOwner, createWorkspaceArgs: WorkspaceCreateArgs, workspaceCreatedEvent: ReturnType<WorkspaceServiceMethodOwner["buildWorkspaceCreatedEvent"]>): Promise<Workspace> {
    return await owner.dependencies.eventPublisher.appendManyWithMutation(
      [workspaceCreatedEvent],
      () => owner.dependencies.workspaceRepo.create(createWorkspaceArgs)
    );
  }

async function loadWorkspaceBootstrapPlan(bootstrappingDeps: WorkspaceBootstrappingDependencies, workspaceId: string): Promise<WorkspaceBootstrapPlan | null> {
    const existingBootstrappingRecord =
      await bootstrappingDeps.bootstrappingRecordRepo.findByWorkspace(workspaceId);
    return existingBootstrappingRecord === null
      ? await bootstrappingDeps.bootstrappingPlanner.planBootstrap(workspaceId)
      : null;
  }

async function createWorkspaceWithBootstrapPlan(owner: WorkspaceServiceMethodOwner, params: Readonly<{
  readonly createWorkspaceArgs: WorkspaceCreateArgs;
  readonly bootstrappingDeps: WorkspaceBootstrappingDependencies;
  readonly bootstrapPlan: WorkspaceBootstrapPlan | null;
  readonly shouldPlantBootstrapPlan: boolean;
  readonly events: readonly ReturnType<WorkspaceServiceMethodOwner["buildWorkspaceCreatedEvent"]>[];
}>): Promise<Workspace> {
    return await owner.dependencies.eventPublisher.appendManyWithMutation(params.events, () => {
      const createdWorkspace = owner.dependencies.workspaceRepo.create(params.createWorkspaceArgs);
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

export async function workspaceServiceReconcileBootstrapPaths(owner: WorkspaceServiceMethodOwner, workspaceId: string, options?: { readonly causedBy?: "system" | "user_action" }): Promise<WorkspaceBootstrapReconcileResult> {
    const state = await loadBootstrapReconcileState(owner, workspaceId);
    if ("status" in state) {
      return state;
    }

    const bootstrapPlan =
      await state.bootstrappingDeps.bootstrappingPlanner.planBootstrap(workspaceId);
    if (bootstrapPlan.relations.length === 0) {
      return {
        status: "skipped_no_templates",
        workspace_id: workspaceId,
        template_ids: bootstrapPlan.record.template_ids_used
      };
    }

    const plantResult = await plantBootstrapPlan({
      owner,
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

async function loadBootstrapReconcileState(owner: WorkspaceServiceMethodOwner, workspaceId: string): Promise<WorkspaceBootstrapReconcileResult | BootstrapReconcileState> {
    const bootstrappingDeps = owner.resolveBootstrappingDependencies();
    if (bootstrappingDeps === null) {
      return { status: "skipped_no_planner", workspace_id: workspaceId };
    }
    const workspace = await owner.dependencies.workspaceRepo.getById(workspaceId);
    if (workspace === null) {
      throw new CoreError("NOT_FOUND", "Workspace not found");
    }
    const existingRecord = bootstrappingDeps.bootstrappingRecordRepo.findByWorkspace(workspaceId);
    const existingRelations = await bootstrappingDeps.pathRelationRepo.findByWorkspace(workspaceId);
    const existingResult = classifyExistingBootstrapState(workspaceId, existingRecord, existingRelations);
    return existingResult ?? Object.freeze({ bootstrappingDeps });
  }

function classifyExistingBootstrapState(workspaceId: string, existingRecord: Readonly<BootstrappingRecord> | null, existingRelations: readonly Readonly<PathRelation>[]): WorkspaceBootstrapReconcileResult | null {
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

async function plantBootstrapPlan(params: Readonly<{
  readonly owner: WorkspaceServiceMethodOwner;
  readonly workspaceId: string;
  readonly bootstrappingDeps: WorkspaceBootstrappingDependencies;
  readonly bootstrapPlan: Awaited<ReturnType<WorkspaceBootstrappingPlannerPort["planBootstrap"]>>;
  readonly causedBy: "system" | "user_action";
}>): Promise<BootstrapPlantResult> {
    const plantedEvent = params.owner.buildBootstrappingPathsPlantedEvent(
      params.bootstrapPlan.record,
      params.causedBy
    );
    let plantedCount = 0;
    let racedRecordId: string | null = null;
    try {
      await params.owner.dependencies.eventPublisher.appendManyWithMutation([plantedEvent], () => {
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

async function resolveBootstrapRaceResult(bootstrappingDeps: WorkspaceBootstrappingDependencies, workspaceId: string, racedRecordId: string): Promise<WorkspaceBootstrapReconcileResult> {
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

function corruptBootstrapRecordResult(workspaceId: string, recordId: string): WorkspaceBootstrapReconcileResult {
    return {
      status: "corrupt_partial",
      workspace_id: workspaceId,
      record_id: recordId,
      relation_count: 0,
      reason: "bootstrapping_record_without_relations"
    };
  }

export function workspaceServiceList(owner: WorkspaceServiceMethodOwner, page?: WorkspaceListPageOptions): Promise<readonly Workspace[]> {
    return owner.dependencies.workspaceRepo.list(page);
  }

export async function workspaceServiceCount(owner: WorkspaceServiceMethodOwner): Promise<number> {
    const count = owner.dependencies.workspaceRepo.count;
    if (count !== undefined) {
      return await count.call(owner.dependencies.workspaceRepo);
    }
    return (await owner.dependencies.workspaceRepo.list()).length;
  }

export async function workspaceServiceGetById(owner: WorkspaceServiceMethodOwner, workspaceId: string): Promise<Workspace> {
    const workspace = await owner.dependencies.workspaceRepo.getById(workspaceId);

    if (workspace === null) {
      throw new CoreError("NOT_FOUND", "Workspace not found");
    }

    return workspace;
  }
