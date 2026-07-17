import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { AlayaDaemonRuntime } from "@do-soul/alaya";
import { EmbeddingBackfillHandler } from "@do-soul/alaya-core";
import {
  MemoryDimension,
  RunMode,
  RunState,
  ScopeClass,
  WorkspaceKind,
  WorkspaceState,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteMemoryEmbeddingRepo,
  SqliteMemoryEntryRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo
} from "@do-soul/alaya-storage";
import { describe, expect, it, vi } from "vitest";
import { createBenchDaemonOps } from "../../../harness/daemon/handle/daemon-handle-ops.js";

const MEMORY_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_MEMORY_ID = "22222222-2222-4222-8222-222222222222";
const WORKSPACE_ID = "workspace-1";
const RUN_ID = "run-1";
const MODEL_ID = "text-embedding-3-small";

describe("warmEmbeddingCache provider barrier", () => {
  it("awaits the real provider warmup in B/D even when every document vector is cached", async () => {
    const dataDir = await createAllReadyFixture();
    let resolveProvider: (status: "ready") => void = () => undefined;
    const providerWarmup = new Promise<"ready">((resolve) => { resolveProvider = resolve; });
    const runGardenEmbeddingBackfillPass = vi.fn(async () => undefined);
    const operations = createOperations(dataDir, providerWarmup, runGardenEmbeddingBackfillPass);

    try {
      let settled = false;
      const warmup = operations.warmEmbeddingCache([MEMORY_ID]);
      void warmup.then(() => { settled = true; }, () => { settled = true; });
      await Promise.resolve();

      expect(settled).toBe(false);
      expect(runGardenEmbeddingBackfillPass).not.toHaveBeenCalled();

      resolveProvider("ready");
      await expect(warmup).resolves.toMatchObject({
        status: "ready",
        expected_count: 1,
        ready_count: 1,
        pass_count: 0
      });
      expect(runGardenEmbeddingBackfillPass).not.toHaveBeenCalled();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("still requires provider readiness when a B/D workspace has no document vectors", async () => {
    let resolveProvider: (status: "ready") => void = () => undefined;
    const providerWarmup = new Promise<"ready">((resolve) => { resolveProvider = resolve; });
    const operations = createOperations("/unused", providerWarmup, vi.fn(async () => undefined));
    let settled = false;
    const warmup = operations.warmEmbeddingCache([]);
    void warmup.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();

    expect(settled).toBe(false);
    resolveProvider("ready");
    await expect(warmup).resolves.toMatchObject({
      status: "ready",
      expected_count: 0,
      ready_count: 0
    });
  });

  it("repairs a mixed-dimensional cache through the public warmup seam", async () => {
    const fixture = await createMixedDimensionFixture();
    const operations = createOperations(
      fixture.dataDir,
      Promise.resolve("ready"),
      fixture.runBackfillPass,
      () => 3
    );

    try {
      await expect(operations.warmEmbeddingCache([MEMORY_ID, SECOND_MEMORY_ID]))
        .resolves.toMatchObject({
          status: "ready",
          expected_count: 2,
          ready_count: 2,
          pass_count: 1
        });
      expect(fixture.runBackfillPass).toHaveBeenCalledOnce();
      expect(fixture.embedTexts).toHaveBeenCalledOnce();
    } finally {
      fixture.close();
      await rm(fixture.dataDir, { recursive: true, force: true });
    }
  });
});

function createOperations(
  dataDir: string,
  embeddingProviderWarmup: AlayaDaemonRuntime["services"]["embeddingProviderWarmup"],
  runGardenEmbeddingBackfillPass: ReturnType<typeof vi.fn>,
  getEmbeddingProviderDimensions: () => number | null = () => 1
) {
  const activeRuntime = {
    services: { embeddingProviderWarmup, getEmbeddingProviderDimensions },
    runGardenEmbeddingBackfillPass
  } as unknown as AlayaDaemonRuntime;
  return createBenchDaemonOps({
    dataDir,
    activeContext: { workspaceId: WORKSPACE_ID, runId: RUN_ID },
    activeRuntime,
    activeServer: { close: async () => undefined },
    activeMcpClient: {} as Client,
    embeddingMode: "env",
    embeddingProviderKind: "openai",
    effectiveEnv: { OPENAI_EMBEDDING_MODEL: MODEL_ID },
    savedEnv: {},
    managedEnvKeys: [],
    reviewerCredentials: { identity: "bench-reviewer", token: "bench-token" },
    cleanupConfigDirectory: async () => undefined,
    releaseActive: () => undefined,
    cleanupManagedWorkspaceRoots: async () => undefined
  });
}

async function createAllReadyFixture(): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), "embedding-provider-barrier-"));
  const database = initDatabase({ filename: join(dataDir, "alaya.db") });
  try {
    await seedWorkspaceAndRun(database);
    const memory = createMemoryEntry();
    await new SqliteMemoryEntryRepo(database).create(memory);
    await new SqliteMemoryEmbeddingRepo(database).upsert({
      object_id: MEMORY_ID,
      workspace_id: WORKSPACE_ID,
      content_hash: hashContent(memory.content),
      provider_kind: "openai",
      model_id: MODEL_ID,
      schema_version: 1,
      dimensions: 1,
      embedding: new Float32Array([1]),
      created_at: "2026-06-01T00:00:00.000Z",
      updated_at: "2026-06-01T00:00:00.000Z"
    });
  } finally {
    database.close();
  }
  return dataDir;
}

async function createMixedDimensionFixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "embedding-provider-dimension-repair-"));
  const database = initDatabase({ filename: join(dataDir, "alaya.db") });
  await seedWorkspaceAndRun(database);
  const memoryRepo = new SqliteMemoryEntryRepo(database);
  const embeddingRepo = new SqliteMemoryEmbeddingRepo(database);
  const memories = [createMemoryEntry(MEMORY_ID), createMemoryEntry(SECOND_MEMORY_ID)];
  for (const memory of memories) await memoryRepo.create(memory);
  await embeddingRepo.upsert(createEmbeddingRecord(memories[0]!, new Float32Array([1, 0])));
  await embeddingRepo.upsert(createEmbeddingRecord(memories[1]!, new Float32Array([1, 0, 0])));
  const embedTexts = vi.fn(async (texts: readonly string[]) =>
    texts.map(() => new Float32Array([1, 0, 0]))
  );
  const handler = new EmbeddingBackfillHandler({
    memoryRepo,
    memoryEmbeddingRepo: embeddingRepo,
    provider: {
      providerKind: "openai",
      modelId: MODEL_ID,
      schemaVersion: 1,
      isAvailable: true,
      embedTexts
    },
    expectedDimensions: () => 3,
    retryDelayMs: 0
  });
  return {
    dataDir,
    embedTexts,
    runBackfillPass: vi.fn(async () => {
      await handler.handle({ workspace_id: WORKSPACE_ID });
    }),
    close: () => database.close()
  };
}

async function seedWorkspaceAndRun(database: ReturnType<typeof initDatabase>): Promise<void> {
  await new SqliteWorkspaceRepo(database).create({
    workspace_id: WORKSPACE_ID,
    name: "workspace one",
    root_path: "/tmp/workspace-1",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    default_engine_class: "conversation_engine",
    workspace_state: WorkspaceState.ACTIVE
  });
  await new SqliteRunRepo(database).create({
    run_id: RUN_ID,
    workspace_id: WORKSPACE_ID,
    title: "run one",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
}

function createEmbeddingRecord(memory: MemoryEntry, embedding: Float32Array) {
  return {
    object_id: memory.object_id,
    workspace_id: WORKSPACE_ID,
    content_hash: hashContent(memory.content),
    provider_kind: "openai",
    model_id: MODEL_ID,
    schema_version: 1,
    dimensions: embedding.length,
    embedding,
    created_at: memory.created_at,
    updated_at: memory.updated_at
  };
}

function createMemoryEntry(objectId = MEMORY_ID): MemoryEntry {
  return {
    object_id: objectId,
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    created_by: "embedding-provider-barrier-test",
    dimension: MemoryDimension.FACT,
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: ScopeClass.PROJECT,
    content: "Every document vector is already cached.",
    domain_tags: [],
    evidence_refs: [],
    workspace_id: WORKSPACE_ID,
    run_id: RUN_ID,
    surface_id: null,
    storage_tier: "hot",
    activation_score: 0.5,
    retention_score: null,
    manifestation_state: null,
    retention_state: null,
    decay_profile: null,
    confidence: null,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: null,
    contradiction_count: null,
    superseded_by: null
  };
}

function hashContent(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}
