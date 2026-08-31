import { vi, type Mock } from "vitest";
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

type EventLogDraft = Omit<EventLogEntry, "event_id" | "created_at" | "revision">;
type AppendSpy = Mock<(event: EventLogDraft) => EventLogEntry>;
type QueryByEntitySpy = Mock<
  (entityType: string, entityId: string) => Promise<readonly EventLogEntry[]>
>;
type EvidenceFindByIdSpy = Mock<
  (objectId: string) => Promise<{ readonly object_id: string; readonly workspace_id: string }>
>;
type NotifySpy = Mock<(entry: EventLogEntry) => Promise<void>>;
type RepoUpdateSpy = Mock<
  (objectId: string, fields: MemoryEntryRepoUpdateFields) => Promise<MemoryEntry>
>;
type RepoUpdateScopedSpy = Mock<
  (
    objectId: string,
    workspaceId: string,
    fields: MemoryEntryRepoUpdateFields
  ) => Promise<MemoryEntry>
>;
type RepoArchiveSpy = Mock<
  (objectId: string, updatedAt: string, onArchived?: () => void) => Promise<MemoryEntry>
>;
type RepoFindByScopeClassSpy = Mock<() => Promise<readonly MemoryEntry[]>>;

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
  readonly appendSpy: AppendSpy;
  readonly queryByEntitySpy: QueryByEntitySpy;
  readonly evidenceFindByIdSpy: EvidenceFindByIdSpy;
  readonly notifySpy: NotifySpy;
  readonly repoUpdateSpy: RepoUpdateSpy;
  readonly repoUpdateScopedSpy: RepoUpdateScopedSpy;
  readonly repoArchiveSpy: RepoArchiveSpy;
  readonly repoFindByScopeClassSpy: RepoFindByScopeClassSpy;
} {
  const appendSpy: AppendSpy = vi.fn((event: EventLogDraft): EventLogEntry => ({
    event_id: `event-${event.event_type}`,
    created_at: "2026-03-21T00:00:00.000Z",
    revision: 0,
    ...event
  }));
  const queryByEntitySpy: QueryByEntitySpy = vi.fn(
    async (_entityType: string, _entityId: string): Promise<readonly EventLogEntry[]> => []
  );
  const evidenceFindByIdSpy: EvidenceFindByIdSpy = vi.fn(async () => ({
    object_id: "evidence",
    workspace_id: "workspace-1"
  }));
  const notifySpy: NotifySpy = vi.fn(async (_entry: EventLogEntry) => {});
  const applyUpdateFields = (
    fields: MemoryEntryRepoUpdateFields,
    workspaceId?: string
  ): MemoryEntry =>
    Object.freeze(
      createMemoryEntry({
        ...(workspaceId === undefined ? {} : { workspace_id: workspaceId }),
        updated_at: fields.updated_at,
        content: fields.content ?? "Use pnpm for all workspace commands.",
        domain_tags: fields.domain_tags ?? ["tooling", "workflow"],
        evidence_refs: fields.evidence_refs ?? ["evidence-1", "evidence-2"],
        storage_tier: fields.storage_tier ?? StorageTier.HOT,
        last_used_at: fields.last_used_at ?? null,
        last_hit_at: fields.last_hit_at ?? null,
        projection_schema_version: fields.projection_schema_version ?? null,
        event_time_start: fields.event_time_start ?? null,
        event_time_end: fields.event_time_end ?? null,
        valid_from: fields.valid_from ?? null,
        valid_to: fields.valid_to ?? null,
        time_precision: fields.time_precision ?? null,
        time_source: fields.time_source ?? null,
        preference_subject: fields.preference_subject ?? null,
        preference_predicate: fields.preference_predicate ?? null,
        preference_object: fields.preference_object ?? null,
        preference_category: fields.preference_category ?? null,
        preference_polarity: fields.preference_polarity ?? null
      })
    );
  const repoUpdateSpy: RepoUpdateSpy = vi.fn(
    async (_objectId: string, fields: MemoryEntryRepoUpdateFields) => applyUpdateFields(fields)
  );
  const repoUpdateScopedSpy: RepoUpdateScopedSpy = vi.fn(
    async (_objectId: string, workspaceId: string, fields: MemoryEntryRepoUpdateFields) =>
      applyUpdateFields(fields, workspaceId)
  );
  const repoUpdateWithinTransactionSpy = vi.fn(
    (
      objectId: string,
      fields: MemoryEntryRepoUpdateFields,
      callbacks: Parameters<
        NonNullable<MemoryServiceDependencies["memoryEntryRepo"]["updateWithinTransaction"]>
      >[2],
      workspaceId?: string
    ) => {
      callbacks.beforeUpdate?.();
      const updated = applyUpdateFields(fields, workspaceId);
      if (workspaceId === undefined) {
        void repoUpdateSpy(objectId, fields);
      } else {
        void repoUpdateScopedSpy(objectId, workspaceId, fields);
      }
      callbacks.afterUpdate?.();
      return updated;
    }
  );
  const repoCreateWithinTransactionSpy = vi.fn(
    (
      entry: MemoryEntry,
      callbacks: Parameters<NonNullable<MemoryServiceDependencies["memoryEntryRepo"]["createWithinTransaction"]>>[1]
    ) => {
      callbacks.beforeCreate?.();
      callbacks.afterCreate?.();
      return Object.freeze({ ...entry });
    }
  );
  const repoArchiveSpy = vi.fn(async (_objectId: string, updatedAt: string, onArchived?: () => void) => {
    onArchived?.();
    return Object.freeze(createMemoryEntry({ lifecycle_state: "archived", updated_at: updatedAt }));
  });
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
      createWithinTransaction: repoCreateWithinTransactionSpy,
      findById: vi.fn(async () => createMemoryEntry()),
      findByIds: vi.fn(async (_workspaceId: string, objectIds: readonly string[]) =>
        objectIds.map((objectId) => createMemoryEntry({ object_id: objectId }))
      ),
      findByWorkspaceId: vi.fn(async () => []),
      findByRunId: vi.fn(async () => []),
      findByDimension: vi.fn(async () => []),
      findByScopeClass: repoFindByScopeClassSpy,
      update: repoUpdateSpy,
      updateScoped: repoUpdateScopedSpy,
      updateWithinTransaction: repoUpdateWithinTransactionSpy,
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
