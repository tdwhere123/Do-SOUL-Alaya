import { vi } from "vitest";
import {
  AcceptedBy,
  ConfirmationPolicy,
  MemoryDimension,
  ObjectLifecycleState,
  ProjectMappingState,
  ScopeClass,
  type EventLogEntry,
  type MemoryEntry,
  type ProjectMappingAnchor
} from "@do-soul/alaya-protocol";
import type { ProjectMappingServiceDependencies } from "../../runs/project-mapping-service.js";

export function createMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: "memory-1",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: ObjectLifecycleState.ACTIVE,
    created_at: "2026-03-28T00:00:00.000Z",
    updated_at: "2026-03-28T00:00:00.000Z",
    created_by: "system",
    dimension: MemoryDimension.PROCEDURE,
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: ScopeClass.GLOBAL_DOMAIN,
    content: "Global procedure memory",
    domain_tags: ["repo"],
    evidence_refs: ["evidence-1"],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: "hot",
    activation_score: 0.7,
    retention_score: 0.8,
    manifestation_state: null,
    retention_state: "working",
    decay_profile: "stable",
    confidence: 0.9,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: 1,
    contradiction_count: 0,
    superseded_by: null,
    ...overrides
  };
}

export function createAnchor(overrides: Partial<ProjectMappingAnchor> = {}): ProjectMappingAnchor {
  return {
    object_id: "mapping-1",
    object_kind: "project_mapping_anchor",
    schema_version: 1,
    lifecycle_state: ObjectLifecycleState.ACTIVE,
    created_at: "2026-03-28T00:00:00.000Z",
    updated_at: "2026-03-28T00:00:00.000Z",
    created_by: "user_action",
    global_object_id: "memory-1",
    project_id: "workspace-1",
    workspace_id: "workspace-1",
    mapping_state: ProjectMappingState.SUGGESTED,
    accepted_by: null,
    last_transition_at: "2026-03-28T00:00:00.000Z",
    ...overrides
  };
}

export function createDependencies(overrides: Partial<ProjectMappingServiceDependencies> = {}): {
  readonly dependencies: ProjectMappingServiceDependencies;
  readonly appendSpy: ReturnType<typeof vi.fn>;
  readonly queryByEntitySpy: ReturnType<typeof vi.fn>;
  readonly createdAnchors: ProjectMappingAnchor[];
  readonly stateUpdates: Array<{
    readonly objectId: string;
    readonly newState: ProjectMappingAnchor["mapping_state"];
    readonly acceptedBy: ProjectMappingAnchor["accepted_by"];
    readonly transitionedAt: string;
  }>;
} {
  const anchors = new Map<string, ProjectMappingAnchor>();
  const memoryEntries = new Map<string, MemoryEntry>([["memory-1", createMemoryEntry()]]);
  const createdAnchors: ProjectMappingAnchor[] = [];
  let appendedEventCount = 0;
  const stateUpdates: Array<{
    readonly objectId: string;
    readonly newState: ProjectMappingAnchor["mapping_state"];
    readonly acceptedBy: ProjectMappingAnchor["accepted_by"];
    readonly transitionedAt: string;
  }> = [];
  const appendSpy = vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => {
    appendedEventCount += 1;
    return {
      event_id: `event-${event.entity_id}-${appendedEventCount}`,
      created_at: "2026-03-28T01:00:00.000Z",
      revision: appendedEventCount,
      ...event
    };
  });
  const queryByEntitySpy = vi.fn(async () => [] as readonly EventLogEntry[]);

  const dependencies: ProjectMappingServiceDependencies = {
    now: () => "2026-03-28T01:00:00.000Z",
    generateObjectId: () => "mapping-generated",
    projectMappingRepo: {
      create: vi.fn(async (anchor) => {
        anchors.set(anchor.object_id, anchor);
        createdAnchors.push(anchor);
      }),
      findById: vi.fn(async (objectId: string) => anchors.get(objectId) ?? null),
      findByIds: vi.fn(async (objectIds: readonly string[]) =>
        [...new Set(objectIds)].flatMap((objectId) => {
          const anchor = anchors.get(objectId);
          return anchor === undefined ? [] : [anchor];
        })
      ),
      findByWorkspace: vi.fn(async (workspaceId: string, state: ProjectMappingAnchor["mapping_state"] | undefined) =>
        [...anchors.values()].filter(
          (anchor) =>
            anchor.workspace_id === workspaceId &&
            (state === undefined || anchor.mapping_state === state)
        )
      ),
      findByGlobalObjectId: vi.fn(async (globalObjectId: string, workspaceId: string) =>
        [...anchors.values()].find(
          (anchor) =>
            anchor.global_object_id === globalObjectId && anchor.workspace_id === workspaceId
        ) ?? null
      ),
      updateState: vi.fn(
        async (
          objectId: string,
          newState: ProjectMappingAnchor["mapping_state"],
          acceptedBy: ProjectMappingAnchor["accepted_by"],
          transitionedAt: string
        ) => {
          const anchor = anchors.get(objectId);
          if (anchor === undefined) {
            throw new Error(`missing anchor ${objectId}`);
          }

          stateUpdates.push({ objectId, newState, acceptedBy, transitionedAt });
          anchors.set(
            objectId,
            Object.freeze({
              ...anchor,
              mapping_state: newState,
              accepted_by: acceptedBy,
              updated_at: transitionedAt,
              last_transition_at: transitionedAt
            })
          );
        }
      ),
      listPending: vi.fn(async (workspaceId: string) =>
        [...anchors.values()].filter(
          (anchor) =>
            anchor.workspace_id === workspaceId &&
            (anchor.mapping_state === ProjectMappingState.SUGGESTED ||
              anchor.mapping_state === ProjectMappingState.PROBATIONARY)
        )
      )
    },
    memoryRepo: {
      findById: vi.fn(async (objectId: string) => memoryEntries.get(objectId) ?? null),
      findByIds: vi.fn(async (objectIds: readonly string[]) =>
        [...new Set(objectIds)].flatMap((objectId) => {
          const entry = memoryEntries.get(objectId);
          return entry === undefined ? [] : [entry];
        })
      )
    },
    eventLogRepo: {
      append: appendSpy,
      queryByEntity: queryByEntitySpy
    },
    ...overrides
  };

  return {
    dependencies,
    appendSpy,
    queryByEntitySpy,
    createdAnchors,
    stateUpdates
  };
}
