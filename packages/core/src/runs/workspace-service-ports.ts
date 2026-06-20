import type {
  BootstrappingRecord,
  EngineBindingInput,
  EngineBindingRecord,
  PathRelation,
  Workspace,
  WorkspaceCreateInput,
  WorkspaceEngineConfig
} from "@do-soul/alaya-protocol";

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

export interface BuildWorkspaceEngineConfigInput {
  readonly workspace_id: string;
  readonly default_engine_class: Workspace["default_engine_class"];
  readonly conversation_binding: WorkspaceEngineConfig["conversation_binding"];
  readonly coding_engine_available: boolean;
}
