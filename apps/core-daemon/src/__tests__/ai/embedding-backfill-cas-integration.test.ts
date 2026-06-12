import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  FormationKind,
  MemoryDimension,
  RunMode,
  RunState,
  ScopeClass,
  SourceKind,
  StorageTier,
  WorkspaceKind,
  WorkspaceState,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteMemoryEmbeddingRepo,
  SqliteMemoryEntryRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { EmbeddingBackfillHandler } from "@do-soul/alaya-core";

// invariant: wires the real EmbeddingBackfillHandler (core) to the real
// SqliteMemoryEmbeddingRepo (storage) over an in-memory SQLite db, proving the
// metadata-only cache-hit path (findMetadataByObjectIds) and the write-time CAS
// stale-skip (upsertIfContentHashMatchesCurrentMemory) end-to-end, not mocked.
// see also: packages/core/src/embedding-recall/embedding-backfill-handler.ts handle

const MEMORY_ID = "11111111-1111-4111-8111-111111111111";

interface Fixture {
  readonly database: StorageDatabase;
  readonly memoryEntryRepo: SqliteMemoryEntryRepo;
  readonly memoryEmbeddingRepo: SqliteMemoryEmbeddingRepo;
}

async function buildFixture(): Promise<Fixture> {
  const database = initDatabase({ filename: ":memory:" });
  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
  const memoryEntryRepo = new SqliteMemoryEntryRepo(database);
  const memoryEmbeddingRepo = new SqliteMemoryEmbeddingRepo(database);

  await workspaceRepo.create({
    workspace_id: "workspace-1",
    name: "workspace one",
    root_path: "/tmp/workspace-1",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  await runRepo.create({
    run_id: "run-1",
    workspace_id: "workspace-1",
    title: "run one",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });

  return { database, memoryEntryRepo, memoryEmbeddingRepo };
}

function createHotMemory(objectId: string, content: string): MemoryEntry {
  return {
    object_id: objectId,
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-05-07T00:00:00.000Z",
    updated_at: "2026-05-07T00:00:00.000Z",
    created_by: "embedding-backfill-cas-test",
    dimension: MemoryDimension.PREFERENCE,
    source_kind: SourceKind.USER,
    formation_kind: FormationKind.EXPLICIT,
    scope_class: ScopeClass.PROJECT,
    content,
    domain_tags: ["recall"],
    evidence_refs: [],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: StorageTier.HOT,
    activation_score: 0.5,
    retention_score: 0.9,
    manifestation_state: "excerpt",
    retention_state: "working",
    decay_profile: "stable",
    confidence: 1,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: 0,
    contradiction_count: 0,
    superseded_by: null
  };
}

function createProvider(
  embedTexts: (texts: readonly string[]) => Promise<readonly Float32Array[]>
) {
  return {
    providerKind: "openai",
    modelId: "text-embedding-3-small",
    schemaVersion: 1,
    isAvailable: true,
    embedTexts: (texts: readonly string[]) => embedTexts(texts)
  };
}

describe("EmbeddingBackfillHandler real storage CAS", () => {
  it("embeds, then cache-hits unchanged content via the metadata-only lookup", async () => {
    const fixture = await buildFixture();
    try {
      await fixture.memoryEntryRepo.create(createHotMemory(MEMORY_ID, "Durable preference note."));

      let embedCalls = 0;
      const handler = new EmbeddingBackfillHandler({
        memoryRepo: fixture.memoryEntryRepo,
        memoryEmbeddingRepo: fixture.memoryEmbeddingRepo,
        provider: createProvider(async (texts) => {
          embedCalls += 1;
          return texts.map(() => new Float32Array([0.1, 0.2, 0.3]));
        })
      });

      const first = await handler.handle({ workspace_id: "workspace-1" });
      expect(first.objectsAffected).toEqual([MEMORY_ID]);
      expect(embedCalls).toBe(1);

      // The row is persisted; a second pass reads metadata only and finds the
      // content_hash + provider/model/schema unchanged, so it skips re-embed.
      const second = await handler.handle({ workspace_id: "workspace-1" });
      expect(second.objectsAffected).toEqual([]);
      expect(second.auditEntries).toEqual([`embedding_skipped:unchanged:${MEMORY_ID}`]);
      expect(embedCalls).toBe(1);

      const persisted = await fixture.memoryEmbeddingRepo.findByObjectId(MEMORY_ID);
      expect(persisted?.content_hash).toBe(
        `sha256:${createHash("sha256").update("Durable preference note.").digest("hex")}`
      );
    } finally {
      fixture.database.close();
    }
  });

  it("skips a stale write through the real write-time CAS guard when content mutates mid-embed", async () => {
    const fixture = await buildFixture();
    try {
      await fixture.memoryEntryRepo.create(createHotMemory(MEMORY_ID, "Original content."));

      let mutated = false;
      const handler = new EmbeddingBackfillHandler({
        memoryRepo: fixture.memoryEntryRepo,
        memoryEmbeddingRepo: fixture.memoryEmbeddingRepo,
        provider: createProvider(async (texts) => {
          // Mutate the live memory content AFTER the embed snapshot was taken
          // but BEFORE persistence, so the guarded upsert re-hashes the live row
          // inside its SQLite transaction, finds a mismatch, and returns null.
          if (!mutated) {
            mutated = true;
            await fixture.memoryEntryRepo.update(MEMORY_ID, {
              content: "Mutated content.",
              updated_at: "2026-05-07T00:01:00.000Z"
            });
          }
          return texts.map(() => new Float32Array([0.4, 0.5, 0.6]));
        })
      });

      const result = await handler.handle({ workspace_id: "workspace-1" });

      expect(result.objectsAffected).toEqual([]);
      expect(result.auditEntries).toContain(`embedding_skipped:stale_content:${MEMORY_ID}`);
      // Nothing was persisted because the CAS guard rejected the stale vector.
      const persisted = await fixture.memoryEmbeddingRepo.findByObjectId(MEMORY_ID);
      expect(persisted).toBeNull();
    } finally {
      fixture.database.close();
    }
  });
});
