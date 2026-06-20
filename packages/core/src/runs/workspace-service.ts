import { randomUUID } from "node:crypto";

import {
  EngineBindingInputSchema,
  WorkspaceCreateInputSchema,
  WorkspaceEngineConfigSchema,
  WorkspaceKind,
  WorkspaceRunEventType,
  WorkspaceCreatedPayloadSchema,
  WorkspaceDefaultEngineClassUpdatedPayloadSchema,
  WorkspaceDeletedPayloadSchema,
  WorkspaceEngineBindingUpdatedPayloadSchema,
  type EngineBindingInput,
  type EngineBindingRecord,
  type Workspace,
  type WorkspaceEngineConfig
} from "@do-soul/alaya-protocol";

import { CoreError } from "../shared/errors.js";

import { WorkspaceBootstrapCoordinator } from "./workspace-bootstrap-coordinator.js";
import type {
  BuildWorkspaceEngineConfigInput,
  CreateWorkspaceInput,
  WorkspaceBootstrapReconcileResult,
  WorkspaceListPageOptions,
  WorkspaceServiceDependencies
} from "./workspace-service-ports.js";

export type {
  CreateWorkspaceInput,
  WorkspaceBootstrapReconcileResult,
  WorkspaceBootstrappingPlannerPort,
  WorkspaceBootstrappingRecordRepoPort,
  WorkspaceEngineConfigRepoPort,
  WorkspaceListPageOptions,
  WorkspacePathRelationRepoPort,
  WorkspaceRepoPort,
  WorkspaceRunRepoPort,
  WorkspaceServiceDependencies
} from "./workspace-service-ports.js";

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

export class WorkspaceService {
  private readonly bootstrapCoordinator: WorkspaceBootstrapCoordinator;

  public constructor(public readonly dependencies: WorkspaceServiceDependencies) {
    this.bootstrapCoordinator = new WorkspaceBootstrapCoordinator({
      workspaceRepo: dependencies.workspaceRepo,
      eventPublisher: dependencies.eventPublisher,
      bootstrappingPlanner: dependencies.bootstrappingPlanner,
      pathRelationRepo: dependencies.pathRelationRepo,
      bootstrappingRecordRepo: dependencies.bootstrappingRecordRepo
    });
  }

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

  private async createWithId(parsed: CreateWorkspaceInput, workspaceId: string): Promise<Workspace> {
    return await this.bootstrapCoordinator.createWorkspace(
      parsed,
      workspaceId,
      this.buildWorkspaceCreatedEvent({
        workspaceId,
        name: parsed.name,
        workspaceKind: parsed.workspace_kind
      })
    );
  }

  public async reconcileBootstrapPaths(
    workspaceId: string,
    options?: { readonly causedBy?: "system" | "user_action" }
  ): Promise<WorkspaceBootstrapReconcileResult> {
    return await this.bootstrapCoordinator.reconcileBootstrapPaths(workspaceId, options);
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
    const engineConfigRepo = this.dependencies.engineConfigRepo;
    if (engineConfigRepo === undefined) {
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
        engineConfigRepo.upsertConversationBindingAndSetDefaultEngineClass({
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
}
