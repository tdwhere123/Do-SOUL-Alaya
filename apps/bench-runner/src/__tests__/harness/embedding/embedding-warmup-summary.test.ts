import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EmbeddingBackfillHandler } from "@do-soul/alaya-core";
import {
  RunMode,
  RunState,
  WorkspaceKind,
  WorkspaceState
} from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteMemoryEmbeddingRepo,
  SqliteMemoryEntryRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo
} from "@do-soul/alaya-storage";
import { describe, expect, it, vi } from "vitest";
import { drainEmbeddingWarmupPasses } from "../../../harness/embedding/embedding-warmup.js";
import { readEmbeddingWarmupSummary } from "../../../harness/daemon.js";
import {
  createEmbeddingWarmupTempDir,
  createMemoryEntry,
  createReadinessFixture,
  hashContent,
  MISSING_MEMORY_ID,
  overwriteEmbeddingBlob,
  READY_MEMORY_ID,
  registerEmbeddingWarmupCleanup,
  validEmbeddingBlob
} from "./embedding-warmup-fixture.js";

registerEmbeddingWarmupCleanup();

describe("readEmbeddingWarmupSummary", () => {
  it("requires current content and a dimensionally valid embedding blob", async () => {
    const dataDir = await createEmbeddingWarmupTempDir("embedding-warmup-summary-");

    const database = initDatabase({ filename: join(dataDir, "alaya.db") });
    try {
      const workspaceRepo = new SqliteWorkspaceRepo(database);
      const runRepo = new SqliteRunRepo(database);
      const memoryRepo = new SqliteMemoryEntryRepo(database);
      await workspaceRepo.create({
        workspace_id: "workspace-1",
        name: "workspace one",
        root_path: "/tmp/workspace-1",
        workspace_kind: WorkspaceKind.LOCAL_REPO,
        default_engine_binding: null,
        default_engine_class: "conversation_engine",
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
      await memoryRepo.create(createMemoryEntry(READY_MEMORY_ID));
      database.connection
        .prepare(
          `INSERT INTO memory_embeddings (
            object_id,
            workspace_id,
            content_hash,
            provider_kind,
            model_id,
            schema_version,
            dimensions,
            embedding_blob,
            vector_valid,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
        )
        .run(
          READY_MEMORY_ID,
          "workspace-1",
          hashContent(`Embedding warmup source for ${READY_MEMORY_ID}.`),
          "openai",
          "text-embedding-3-small",
          1,
          1536,
          validEmbeddingBlob(1536),
          "2026-06-01T00:00:00.000Z",
          "2026-06-01T00:00:00.000Z"
        );

      const summary = await readEmbeddingWarmupSummary({
        dataDir,
        workspaceId: "workspace-1",
        objectIds: [READY_MEMORY_ID, MISSING_MEMORY_ID],
        providerKind: "openai",
        modelId: "text-embedding-3-small",
        schemaVersion: 1,
        expectedDimensions: 1536,
        passCount: 2
      });

      expect(summary.ready_count).toBe(1);
      expect(summary.expected_count).toBe(2);
      expect(summary.missing_object_ids).toEqual([MISSING_MEMORY_ID]);
    } finally {
      database.close();
    }
  });

  it("treats a stale content hash as missing so a backfill pass repairs it", async () => {
    const dataDir = await createReadinessFixture("sha256:stale", 4);
    const database = initDatabase({ filename: join(dataDir, "alaya.db") });
    const handler = new EmbeddingBackfillHandler({
      memoryRepo: new SqliteMemoryEntryRepo(database),
      memoryEmbeddingRepo: new SqliteMemoryEmbeddingRepo(database),
      provider: {
        providerKind: "openai",
        modelId: "text-embedding-3-small",
        schemaVersion: 1,
        isAvailable: true,
        embedTexts: async (texts) => texts.map(() => new Float32Array([0.1, 0.2, 0.3]))
      },
      retryDelayMs: 0
    });
    let passes = 0;

    const result = await drainEmbeddingWarmupPasses({
      maxPasses: 2,
      maxStallPasses: 2,
      runPass: async () => {
        passes += 1;
        await handler.handle({ workspace_id: "workspace-1" });
      },
      readSummary: async (passCount) => await readEmbeddingWarmupSummary({
        dataDir,
        workspaceId: "workspace-1",
        objectIds: [READY_MEMORY_ID],
        providerKind: "openai",
        modelId: "text-embedding-3-small",
        schemaVersion: 1,
        expectedDimensions: 3,
        passCount
      })
    });

    expect(passes).toBe(1);
    expect(result.summary.ready_count).toBe(1);
  });

  it("does not count a blob whose byte length disagrees with dimensions", async () => {
    const content = `Embedding warmup source for ${READY_MEMORY_ID}.`;
    const dataDir = await createReadinessFixture(hashContent(content), 3);

    const summary = await readEmbeddingWarmupSummary({
      dataDir,
      workspaceId: "workspace-1",
      objectIds: [READY_MEMORY_ID],
      providerKind: "openai",
      modelId: "text-embedding-3-small",
      schemaVersion: 1,
      expectedDimensions: 1,
      passCount: 0
    });

    expect(summary.ready_count).toBe(0);
    expect(summary.missing_object_ids).toEqual([READY_MEMORY_ID]);
  });

  it.each([
    ["zero", new Float32Array([0])],
    ["NaN", new Float32Array([Number.NaN])]
  ])("does not count a %s embedding blob as warm", async (_label, vector) => {
    const content = `Embedding warmup source for ${READY_MEMORY_ID}.`;
    const dataDir = await createReadinessFixture(hashContent(content), 4);
    overwriteEmbeddingBlob(dataDir, vector);
    const summary = await readEmbeddingWarmupSummary({
      dataDir, workspaceId: "workspace-1", objectIds: [READY_MEMORY_ID],
      providerKind: "openai", modelId: "text-embedding-3-small", schemaVersion: 1,
      expectedDimensions: 1, passCount: 0
    });
    expect(summary.ready_count).toBe(0);
    expect(summary.missing_object_ids).toEqual([READY_MEMORY_ID]);
  });

  it("closes its read handle after a successful summary", async () => {
    const content = `Embedding warmup source for ${READY_MEMORY_ID}.`;
    const dataDir = await createReadinessFixture(hashContent(content), 4);
    const close = vi.spyOn(DatabaseSync.prototype, "close");

    await readEmbeddingWarmupSummary({
      dataDir,
      workspaceId: "workspace-1",
      objectIds: [READY_MEMORY_ID],
      providerKind: "openai",
      modelId: "text-embedding-3-small",
      schemaVersion: 1,
      expectedDimensions: 1,
      passCount: 0
    });

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes its read handle when the readiness query fails", async () => {
    const content = `Embedding warmup source for ${READY_MEMORY_ID}.`;
    const dataDir = await createReadinessFixture(hashContent(content), 4);
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementationOnce(() => {
      throw new Error("fixture query failure");
    });
    const close = vi.spyOn(DatabaseSync.prototype, "close");

    await expect(readEmbeddingWarmupSummary({
      dataDir,
      workspaceId: "workspace-1",
      objectIds: [READY_MEMORY_ID],
      providerKind: "openai",
      modelId: "text-embedding-3-small",
      schemaVersion: 1,
      expectedDimensions: 1,
      passCount: 0
    })).rejects.toThrow(/fixture query failure/u);

    expect(close).toHaveBeenCalledTimes(1);
  });

});
