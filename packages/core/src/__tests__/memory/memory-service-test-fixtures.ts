import { vi } from "vitest";
import {
  FormationKind,
  MemoryDimension,
  ScopeClass,
  SourceKind,
  StorageTier,
  type EventLogEntry,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import type {
  MemoryEntryInput,
  MemoryEntryRepoUpdateFields,
  MemoryServiceDependencies
} from "../../memory/memory-service.js";
import type { TestMock } from "../shared/mock-types.js";

export function createMemoryInput(overrides: Partial<MemoryEntryInput> = {}): MemoryEntryInput {
  return {
    created_by: "user_action",
    dimension: MemoryDimension.PREFERENCE,
    source_kind: SourceKind.USER,
    formation_kind: FormationKind.EXPLICIT,
    scope_class: ScopeClass.PROJECT,
    content: "Use pnpm for all workspace commands.",
    domain_tags: ["tooling", "workflow"],
    evidence_refs: ["evidence-1", "evidence-2"],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: StorageTier.HOT,
    ...overrides
  };
}

export function createMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-21T00:00:00.000Z",
    updated_at: "2026-03-21T00:00:00.000Z",
    created_by: "user_action",
    dimension: MemoryDimension.PREFERENCE,
    source_kind: SourceKind.USER,
    formation_kind: FormationKind.EXPLICIT,
    scope_class: ScopeClass.PROJECT,
    content: "Use pnpm for all workspace commands.",
    domain_tags: ["tooling", "workflow"],
    evidence_refs: ["evidence-1", "evidence-2"],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: StorageTier.HOT,
    activation_score: null,
    retention_score: null,
    manifestation_state: null,
    retention_state: null,
    decay_profile: null,
    confidence: null,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: null,
    contradiction_count: null,
    superseded_by: null,
    ...overrides
  };
}

export function createEventLogHistory(maxRevision: number): readonly EventLogEntry[] {
  return [
    {
      event_id: "event-history",
      event_type: "soul.memory.created",
      entity_type: "memory_entry",
      entity_id: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
      workspace_id: "workspace-1",
      run_id: "run-1",
      caused_by: "user_action",
      revision: maxRevision,
      payload_json: {
        object_id: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
        object_kind: "memory_entry",
        workspace_id: "workspace-1",
        run_id: "run-1"
      },
      created_at: "2026-03-21T00:00:00.000Z"
    }
  ];
}

export function createDependencies(overrides: Partial<MemoryServiceDependencies> = {}): {
  readonly dependencies: MemoryServiceDependencies;
  readonly appendSpy: TestMock;
  readonly queryByEntitySpy: TestMock;
  readonly evidenceFindByIdSpy: TestMock;
  readonly notifySpy: TestMock;
  readonly repoUpdateSpy: TestMock;
  readonly repoUpdateScopedSpy: TestMock;
  readonly repoArchiveSpy: TestMock;
  readonly repoFindByScopeClassSpy: TestMock;
} {
  const appendSpy = vi.fn((event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
    event_id: `event-${event.event_type}`,
    created_at: "2026-03-21T00:00:00.000Z",
    revision: 0,
    ...event
  }));
  const queryByEntitySpy = vi.fn(async () => [] as readonly EventLogEntry[]);
  const evidenceFindByIdSpy = vi.fn(async () => ({ object_id: "evidence" }));
  const notifySpy = vi.fn(async () => {});
  const repoUpdateSpy = vi.fn(async (_objectId: string, fields: MemoryEntryRepoUpdateFields) =>
    Object.freeze(
      createMemoryEntry({
        updated_at: fields.updated_at,
        content: fields.content ?? "Use pnpm for all workspace commands.",
        domain_tags: fields.domain_tags ?? ["tooling", "workflow"],
        evidence_refs: fields.evidence_refs ?? ["evidence-1", "evidence-2"],
        storage_tier: fields.storage_tier ?? StorageTier.HOT,
        last_used_at: fields.last_used_at ?? null,
        last_hit_at: fields.last_hit_at ?? null
      })
    )
  );
  const repoUpdateScopedSpy = vi.fn(async (_objectId: string, workspaceId: string, fields: MemoryEntryRepoUpdateFields) =>
    Object.freeze(
      createMemoryEntry({
        workspace_id: workspaceId,
        updated_at: fields.updated_at,
        content: fields.content ?? "Use pnpm for all workspace commands.",
        domain_tags: fields.domain_tags ?? ["tooling", "workflow"],
        evidence_refs: fields.evidence_refs ?? ["evidence-1", "evidence-2"],
        storage_tier: fields.storage_tier ?? StorageTier.HOT,
        last_used_at: fields.last_used_at ?? null,
        last_hit_at: fields.last_hit_at ?? null
      })
    )
  );
  const repoArchiveSpy = vi.fn(async (_objectId: string, updatedAt: string) =>
    Object.freeze(createMemoryEntry({ lifecycle_state: "archived", updated_at: updatedAt }))
  );
  const repoFindByScopeClassSpy = vi.fn(async () => [Object.freeze(createMemoryEntry())]);

  const dependencies: MemoryServiceDependencies = {
    now: () => "2026-03-21T01:00:00.000Z",
    generateObjectId: () => "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
    evidenceService: {
      findById: evidenceFindByIdSpy
    },
    eventLogRepo: {
      append: appendSpy,
      queryByEntity: queryByEntitySpy
    },
    memoryEntryRepo: {
      create: vi.fn(async (entry) => Object.freeze({ ...entry })),
      findById: vi.fn(async () => createMemoryEntry()),
      findByIds: vi.fn(async (objectIds: readonly string[]) =>
        objectIds.map((objectId) => createMemoryEntry({ object_id: objectId }))
      ),
      findByWorkspaceId: vi.fn(async () => []),
      findByRunId: vi.fn(async () => []),
      findByDimension: vi.fn(async () => []),
      findByScopeClass: repoFindByScopeClassSpy,
      update: repoUpdateSpy,
      updateScoped: repoUpdateScopedSpy,
      archive: repoArchiveSpy
    },
    runtimeNotifier: {
      notifyEntry: notifySpy
    },
    ...overrides
  };

  return {
    dependencies,
    appendSpy,
    queryByEntitySpy,
    evidenceFindByIdSpy,
    notifySpy,
    repoUpdateSpy,
    repoUpdateScopedSpy,
    repoArchiveSpy,
    repoFindByScopeClassSpy
  };
}
