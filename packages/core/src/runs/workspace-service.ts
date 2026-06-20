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

import { workspaceServiceCreate, workspaceServiceEnsureLocalWorkspace, workspaceServiceCreateWithId, workspaceServiceReconcileBootstrapPaths, workspaceServiceList, workspaceServiceCount, workspaceServiceGetById } from "./workspace-service-methods-1.js";
import { workspaceServiceDelete, workspaceServiceUpdateDefaultEngineClass, workspaceServiceUpdateConversationEngineConfig, workspaceServiceBuildEngineConfig, workspaceServiceResolveBootstrappingDependencies, workspaceServiceBuildWorkspaceCreatedEvent, workspaceServiceBuildBootstrappingPathsPlantedEvent } from "./workspace-service-methods-2.js";

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
public constructor(public readonly dependencies: WorkspaceServiceDependencies) {}

  public async create(input: unknown): Promise<Workspace> {
    return workspaceServiceCreate(this, input);
  }

  public async ensureLocalWorkspace(input: {
    readonly workspaceId: string;
    readonly name: string;
    readonly rootPath: string;
    readonly repoPath?: string | null;
  }): Promise<Workspace> {
    return workspaceServiceEnsureLocalWorkspace(this, input);
  }

  private async createWithId(parsed: CreateWorkspaceInput, workspaceId: string): Promise<Workspace> {
    return workspaceServiceCreateWithId(this, parsed, workspaceId);
  }

  public async reconcileBootstrapPaths(workspaceId: string, options?: { readonly causedBy?: "system" | "user_action" }): Promise<WorkspaceBootstrapReconcileResult> {
    return workspaceServiceReconcileBootstrapPaths(this, workspaceId, options);
  }

  public list(page?: WorkspaceListPageOptions): Promise<readonly Workspace[]> {
    return workspaceServiceList(this, page);
  }

  public async count(): Promise<number> {
    return workspaceServiceCount(this);
  }

  public async getById(workspaceId: string): Promise<Workspace> {
    return workspaceServiceGetById(this, workspaceId);
  }

  public async delete(workspaceId: string): Promise<Workspace> {
    return workspaceServiceDelete(this, workspaceId);
  }

  public async updateDefaultEngineClass(workspaceId: string, engineClass: Workspace["default_engine_class"]): Promise<Workspace> {
    return workspaceServiceUpdateDefaultEngineClass(this, workspaceId, engineClass);
  }

  public async updateConversationEngineConfig(workspaceId: string, bindingInput: unknown): Promise<{
    readonly workspace: Workspace;
    readonly binding: EngineBindingRecord;
  }> {
    return workspaceServiceUpdateConversationEngineConfig(this, workspaceId, bindingInput);
  }

  public buildEngineConfig(input: BuildWorkspaceEngineConfigInput): WorkspaceEngineConfig {
    return workspaceServiceBuildEngineConfig(this, input);
  }

  private resolveBootstrappingDependencies(): {
    readonly bootstrappingPlanner: WorkspaceBootstrappingPlannerPort;
    readonly pathRelationRepo: WorkspacePathRelationRepoPort;
    readonly bootstrappingRecordRepo: WorkspaceBootstrappingRecordRepoPort;
  } | null {
    return workspaceServiceResolveBootstrappingDependencies(this);
  }

  private buildWorkspaceCreatedEvent(input: {
    readonly workspaceId: string;
    readonly name: string;
    readonly workspaceKind: Workspace["workspace_kind"];
  }) {
    return workspaceServiceBuildWorkspaceCreatedEvent(this, input);
  }

  private buildBootstrappingPathsPlantedEvent(record: Readonly<BootstrappingRecord>, causedBy: "system" | "user_action" = "system") {
    return workspaceServiceBuildBootstrappingPathsPlantedEvent(this, record, causedBy);
  }
}
