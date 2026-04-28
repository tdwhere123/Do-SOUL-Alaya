import { randomUUID } from "node:crypto";
import {
  ControlPlaneObjectKind,
  MemoryDimension,
  Phase3AEventType,
  RetentionPolicy,
  RunMode,
  ScopeClass,
  SoulTaskSurfaceCreatedPayloadSchema,
  TaskObjectSurfaceSchema,
  type CoarseFilterConfig,
  type EventLogEntry,
  type FineAssessmentConfig,
  type Run,
  type SurfaceIdentity,
  type TaskObjectSurface
} from "@do-what/protocol";
import { CoreError } from "./errors.js";
import { getNextRevision } from "./shared/event-utils.js";

export type NodeStrategy = "chat" | "analyze" | "build" | "govern";

export interface TaskSurfaceBuilderSurfaceRepoPort {
  findBySurfaceId(surfaceId: string, workspaceId: string): Promise<Readonly<SurfaceIdentity> | null>;
}

export interface TaskSurfaceBuilderEventLogRepoPort {
  append(entry: Omit<EventLogEntry, "event_id" | "created_at">): Promise<EventLogEntry>;
  queryByEntity(entityType: string, entityId: string): Promise<readonly EventLogEntry[]>;
}

export interface TaskSurfaceBuilderDependencies {
  readonly surfaceRepo?: TaskSurfaceBuilderSurfaceRepoPort;
  readonly eventLogRepo: TaskSurfaceBuilderEventLogRepoPort;
  readonly generateRuntimeId?: () => string;
  readonly now?: () => string;
}

export interface TaskSurfaceBuilderBuildParams {
  readonly run: Pick<Run, "run_id" | "workspace_id" | "run_mode" | "title">;
  readonly surfaceId: string | null;
  readonly displayName?: string;
  readonly contextRefs?: readonly string[];
}

export const STRATEGY_RECALL_DEFAULTS: Readonly<
  Record<
    NodeStrategy,
    {
      readonly coarse: Readonly<CoarseFilterConfig>;
      readonly fine: Readonly<FineAssessmentConfig>;
    }
  >
> = Object.freeze({
  chat: Object.freeze({
    coarse: Object.freeze({
      deterministic_match: Object.freeze({
        scope_filter: null,
        dimension_filter: null,
        domain_tag_filter: null
      }),
      precomputed_rank: Object.freeze({
        max_candidates: 20,
        min_activation_score: 0.1
      }),
      semantic_supplement: Object.freeze({
        enabled: true,
        max_supplement: 5,
        embedding_enabled: false
      })
    }),
    fine: Object.freeze({
      budgets: Object.freeze({
        max_total_tokens: 2000,
        max_entries: 10,
        per_dimension_limits: null
      }),
      conflict_awareness: false
    })
  }),
  analyze: Object.freeze({
    coarse: Object.freeze({
      deterministic_match: Object.freeze({
        scope_filter: null,
        dimension_filter: null,
        domain_tag_filter: null
      }),
      precomputed_rank: Object.freeze({
        max_candidates: 50,
        min_activation_score: 0.05
      }),
      semantic_supplement: Object.freeze({
        enabled: true,
        max_supplement: 5,
        embedding_enabled: false
      })
    }),
    fine: Object.freeze({
      budgets: Object.freeze({
        max_total_tokens: 4000,
        max_entries: 25,
        per_dimension_limits: null
      }),
      conflict_awareness: true
    })
  }),
  build: Object.freeze({
    coarse: Object.freeze({
      deterministic_match: Object.freeze({
        scope_filter: Object.freeze([ScopeClass.PROJECT]),
        dimension_filter: Object.freeze([
          MemoryDimension.CONSTRAINT,
          MemoryDimension.PROCEDURE,
          MemoryDimension.HAZARD
        ]),
        domain_tag_filter: null
      }),
      precomputed_rank: Object.freeze({
        max_candidates: 30,
        min_activation_score: 0.15
      }),
      semantic_supplement: Object.freeze({
        enabled: true,
        max_supplement: 5,
        embedding_enabled: false
      })
    }),
    fine: Object.freeze({
      budgets: Object.freeze({
        max_total_tokens: 3000,
        max_entries: 15,
        per_dimension_limits: null
      }),
      conflict_awareness: true
    })
  }),
  govern: Object.freeze({
    coarse: Object.freeze({
      deterministic_match: Object.freeze({
        scope_filter: null,
        dimension_filter: null,
        domain_tag_filter: null
      }),
      precomputed_rank: Object.freeze({
        max_candidates: 40,
        min_activation_score: 0.05
      }),
      semantic_supplement: Object.freeze({
        enabled: true,
        max_supplement: 5,
        embedding_enabled: false
      })
    }),
    fine: Object.freeze({
      budgets: Object.freeze({
        max_total_tokens: 3500,
        max_entries: 20,
        per_dimension_limits: null
      }),
      conflict_awareness: true
    })
  })
});

export class TaskSurfaceBuilder {
  private readonly generateRuntimeId: () => string;
  private readonly now: () => string;

  public constructor(private readonly dependencies: TaskSurfaceBuilderDependencies) {
    this.generateRuntimeId = dependencies.generateRuntimeId ?? (() => randomUUID());
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  public async build(params: TaskSurfaceBuilderBuildParams): Promise<Readonly<TaskObjectSurface>> {
    const surfaceIdentity = await this.resolveSurfaceIdentity(params.surfaceId, params.run.workspace_id);
    const surfaceKind = surfaceIdentity?.surface_kind ?? this.resolveSurfaceKindFromRunMode(params.run.run_mode);
    const runtimeId = this.generateRuntimeId();
    const now = this.now();
    const displayName = parseDisplayName(params.displayName ?? params.run.title);
    const taskSurface = parseTaskObjectSurface({
      runtime_id: runtimeId,
      object_kind: ControlPlaneObjectKind.TASK_OBJECT_SURFACE,
      task_surface_ref: null,
      expires_at: new Date(new Date(now).getTime() + 30 * 60 * 1000).toISOString(),
      derived_from: params.surfaceId,
      retention_policy: RetentionPolicy.SESSION_ONLY,
      surface_kind: surfaceKind,
      display_name: displayName,
      context_refs: Object.freeze([...(params.contextRefs ?? [])])
    });

    const revision = await getNextRevision(this.dependencies.eventLogRepo, "task_object_surface", runtimeId);
    await this.dependencies.eventLogRepo.append({
      event_type: Phase3AEventType.SOUL_TASK_SURFACE_CREATED,
      entity_type: "task_object_surface",
      entity_id: runtimeId,
      workspace_id: params.run.workspace_id,
      run_id: params.run.run_id,
      caused_by: "system",
      revision,
      payload_json: SoulTaskSurfaceCreatedPayloadSchema.parse({
        runtime_id: runtimeId,
        object_kind: taskSurface.object_kind,
        surface_kind: taskSurface.surface_kind,
        display_name: taskSurface.display_name,
        node_strategy: this.resolveStrategy(surfaceKind),
        run_id: params.run.run_id,
        workspace_id: params.run.workspace_id,
        expires_at: taskSurface.expires_at,
        occurred_at: now
      })
    });

    return taskSurface;
  }

  public resolveStrategy(surfaceKind: string): NodeStrategy {
    const normalized = surfaceKind.trim().toLowerCase();

    if (normalized.includes("analyze") || normalized.includes("analysis")) {
      return "analyze";
    }

    if (normalized.includes("build") || normalized.includes("code") || normalized.includes("dev")) {
      return "build";
    }

    if (normalized.includes("govern") || normalized.includes("review") || normalized.includes("audit")) {
      return "govern";
    }

    return "chat";
  }

  private async resolveSurfaceIdentity(
    surfaceId: string | null,
    workspaceId: string
  ): Promise<Readonly<SurfaceIdentity> | null> {
    if (surfaceId === null || this.dependencies.surfaceRepo === undefined) {
      return null;
    }

    return await this.dependencies.surfaceRepo.findBySurfaceId(surfaceId, workspaceId);
  }

  private resolveSurfaceKindFromRunMode(runMode: Run["run_mode"]): string {
    switch (runMode) {
      case RunMode.ANALYZE:
        return "analyze";
      case RunMode.BUILD:
        return "build";
      case RunMode.REVIEW:
        return "govern";
      case RunMode.CHAT:
      default:
        return "chat";
    }
  }
}

function parseTaskObjectSurface(value: TaskObjectSurface): Readonly<TaskObjectSurface> {
  try {
    return Object.freeze(TaskObjectSurfaceSchema.parse(value));
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid task object surface", { cause: error });
  }
}

function parseDisplayName(value: string): string {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw new CoreError("VALIDATION", "Task surface display_name is required");
  }

  return trimmed;
}
