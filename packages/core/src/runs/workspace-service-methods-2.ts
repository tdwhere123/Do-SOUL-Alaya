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

export async function workspaceServiceDelete(owner: WorkspaceServiceMethodOwner, workspaceId: string): Promise<Workspace> {
    const workspace = await owner.getById(workspaceId);
    const runs = await owner.dependencies.runRepo.listByWorkspace(workspaceId);

    if (runs.length > 0) {
      throw new CoreError("CONFLICT", "Workspace has active runs");
    }

    await owner.dependencies.eventPublisher.appendManyWithMutation(
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
        owner.dependencies.workspaceRepo.delete(workspace.workspace_id);
      }
    );

    return workspace;
  }

export async function workspaceServiceUpdateDefaultEngineClass(owner: WorkspaceServiceMethodOwner, workspaceId: string, engineClass: Workspace["default_engine_class"]): Promise<Workspace> {
    const workspace = await owner.getById(workspaceId);

    return await owner.dependencies.eventPublisher.appendManyWithMutation(
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
      () => owner.dependencies.workspaceRepo.updateDefaultEngineClass(workspace.workspace_id, engineClass ?? null)
    );
  }

export async function workspaceServiceUpdateConversationEngineConfig(owner: WorkspaceServiceMethodOwner, workspaceId: string, bindingInput: unknown): Promise<{
    readonly workspace: Workspace;
    readonly binding: EngineBindingRecord;
  }> {
    if (owner.dependencies.engineConfigRepo === undefined) {
      throw new CoreError(
        "CONFLICT",
        "conversation_engine update is unavailable because backend engine-config persistence is not configured"
      );
    }

    const workspace = await owner.getById(workspaceId);
    const parsedBinding = parseEngineBindingInput(bindingInput);
    const bindingId = `binding_${randomUUID()}`;

    return await owner.dependencies.eventPublisher.appendManyWithMutation(
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
        owner.dependencies.engineConfigRepo!.upsertConversationBindingAndSetDefaultEngineClass({
          workspace_id: workspace.workspace_id,
          binding_id: bindingId,
          binding: parsedBinding
        })
    );
  }

export function workspaceServiceBuildEngineConfig(owner: WorkspaceServiceMethodOwner, input: BuildWorkspaceEngineConfigInput): WorkspaceEngineConfig {
    return WorkspaceEngineConfigSchema.parse({
      workspace_id: input.workspace_id,
      default_engine_class: input.default_engine_class ?? null,
      conversation_binding: input.conversation_binding,
      coding_engine_available: input.coding_engine_available
    });
  }

export function workspaceServiceResolveBootstrappingDependencies(owner: WorkspaceServiceMethodOwner): {
    readonly bootstrappingPlanner: WorkspaceBootstrappingPlannerPort;
    readonly pathRelationRepo: WorkspacePathRelationRepoPort;
    readonly bootstrappingRecordRepo: WorkspaceBootstrappingRecordRepoPort;
  } | null {
    if (
      owner.dependencies.bootstrappingPlanner === undefined ||
      owner.dependencies.pathRelationRepo === undefined ||
      owner.dependencies.bootstrappingRecordRepo === undefined
    ) {
      return null;
    }

    return {
      bootstrappingPlanner: owner.dependencies.bootstrappingPlanner,
      pathRelationRepo: owner.dependencies.pathRelationRepo,
      bootstrappingRecordRepo: owner.dependencies.bootstrappingRecordRepo
    };
  }

export function workspaceServiceBuildWorkspaceCreatedEvent(owner: WorkspaceServiceMethodOwner, input: {
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

export function workspaceServiceBuildBootstrappingPathsPlantedEvent(owner: WorkspaceServiceMethodOwner, record: Readonly<BootstrappingRecord>, causedBy: "system" | "user_action" = "system") {
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
