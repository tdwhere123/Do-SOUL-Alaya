import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
  SqliteMemoryEntryRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo
} from "@do-soul/alaya-storage";
import {
  drainEmbeddingWarmupPasses,
  formatEmbeddingWarmupNotReadyError,
  readEmbeddingWarmupSummary,
  type BenchEmbeddingWarmupSummary
} from "../../harness/daemon.js";

const tmpDirs = new Set<string>();
const READY_MEMORY_ID = "11111111-1111-4111-8111-111111111111";
const MISSING_MEMORY_ID = "22222222-2222-4222-8222-222222222222";

afterEach(async () => {
  for (const dir of tmpDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tmpDirs.clear();
});

function summaryFrom(expected: number, ready: number, passCount: number): BenchEmbeddingWarmupSummary {
  const clampedReady = Math.min(ready, expected);
  return {
    status: "ready",
    expected_count: expected,
    ready_count: clampedReady,
    ready_rate: expected === 0 ? 0 : clampedReady / expected,
    pass_count: passCount,
    missing_object_ids: [],
    provider_kind: "openai",
    model_id: "text-embedding-3-small"
  };
}

describe("drainEmbeddingWarmupPasses", () => {
  it("reaches all-ready as soon as one backfill pass drains the workspace, well under the maxPasses ceiling", async () => {
    // Targeted warmup pass: each runPass drains only EMBEDDING_BACKFILL for the
    // workspace, so when the backfill provider succeeds the O(n) handler reaches
    // readiness without competing Librarian maintenance kinds.
    const expected = 50;
    const slotLandsBackfillOnPass = 3;
    let ready = 0;
    let passes = 0;

    const result = await drainEmbeddingWarmupPasses({
      maxPasses: 10,
      maxStallPasses: 10,
      runPass: async () => {
        passes += 1;
        if (passes === slotLandsBackfillOnPass) {
          ready = expected;
        }
      },
      readSummary: async (passCount) => summaryFrom(expected, ready, passCount)
    });

    expect(result.summary.ready_count).toBe(expected);
    expect(result.summary.pass_count).toBe(slotLandsBackfillOnPass);
    expect(passes).toBe(slotLandsBackfillOnPass);
    expect(result.lastPassError).toBeNull();
  });

  it("resets the stall budget whenever a pass advances ready_count so a multi-step drain finishes", async () => {
    // A drip drain that advances ready_count one step on every odd pass and
    // stalls on the intervening even pass. maxStallPasses=2 tolerates a single
    // stall between progress steps; the reset on each productive pass keeps the
    // accumulated stall count from ever reaching the budget. A loop that did
    // NOT reset would accumulate 3 total stalls across the run and give up
    // before reaching expected.
    const expected = 4;
    let ready = 0;
    let passes = 0;

    const result = await drainEmbeddingWarmupPasses({
      maxPasses: 100,
      maxStallPasses: 2,
      runPass: async () => {
        passes += 1;
        if (passes % 2 === 1 && ready < expected) {
          ready += 1;
        }
      },
      readSummary: async (passCount) => summaryFrom(expected, ready, passCount)
    });

    expect(result.summary.ready_count).toBe(expected);
    // 4 productive (odd) passes + up to 3 interleaved stalls, far under maxPasses.
    expect(result.summary.pass_count).toBeLessThan(100);
  });

  it("terminates at the stall budget when no pass ever makes progress", async () => {
    // A genuinely stuck embedding (slot never lands on backfill, or backfill
    // never succeeds) must terminate at the bounded stall budget rather than
    // spinning to the maxPasses ceiling.
    const expected = 5;
    let passes = 0;

    const result = await drainEmbeddingWarmupPasses({
      maxPasses: 1000,
      maxStallPasses: 6,
      runPass: async () => {
        passes += 1;
      },
      readSummary: async (passCount) => summaryFrom(expected, 0, passCount)
    });

    expect(result.summary.ready_count).toBe(0);
    expect(passes).toBe(6);
    expect(passes).toBeLessThan(1000);
  });

  it("records the last pass error when runPass throws and the cache never readies", async () => {
    const expected = 2;

    const result = await drainEmbeddingWarmupPasses({
      maxPasses: 4,
      maxStallPasses: 4,
      runPass: async () => {
        throw new Error("garden pass exploded");
      },
      readSummary: async (passCount) => summaryFrom(expected, 0, passCount)
    });

    expect(result.summary.ready_count).toBe(0);
    expect(result.lastPassError).toContain("garden pass exploded");
  });

  it("includes provider/root backfill reason in the final not-ready error", async () => {
    const expected = 2;
    const result = await drainEmbeddingWarmupPasses({
      maxPasses: 4,
      maxStallPasses: 4,
      runPass: async () => {
        throw new Error("embedding_backfill_skipped:provider_unavailable");
      },
      readSummary: async (passCount) => ({
        ...summaryFrom(expected, 0, passCount),
        missing_object_ids: ["memory-a", "memory-b"]
      })
    });

    expect(formatEmbeddingWarmupNotReadyError(result.summary, result.lastPassError)).toContain(
      "last_error=embedding_backfill_skipped:provider_unavailable"
    );
  });

  it("does not run any pass when the cache is already fully warm", async () => {
    const expected = 3;
    let passes = 0;

    const result = await drainEmbeddingWarmupPasses({
      maxPasses: 10,
      maxStallPasses: 10,
      runPass: async () => {
        passes += 1;
      },
      readSummary: async (passCount) => summaryFrom(expected, expected, passCount)
    });

    expect(passes).toBe(0);
    expect(result.summary.ready_count).toBe(expected);
  });
});

describe("readEmbeddingWarmupSummary", () => {
  it("uses metadata-only readiness and does not hydrate embedding blobs", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "embedding-warmup-summary-"));
    tmpDirs.add(dataDir);
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
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          READY_MEMORY_ID,
          "workspace-1",
          `sha256:${READY_MEMORY_ID}`,
          "openai",
          "text-embedding-3-small",
          1,
          1536,
          Buffer.from([1, 2, 3]),
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
        passCount: 2
      });

      expect(summary.ready_count).toBe(1);
      expect(summary.expected_count).toBe(2);
      expect(summary.missing_object_ids).toEqual([MISSING_MEMORY_ID]);
    } finally {
      database.close();
    }
  });
});

function createMemoryEntry(objectId: string): MemoryEntry {
  return {
    object_id: objectId,
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    created_by: "embedding-warmup-summary-test",
    dimension: MemoryDimension.FACT,
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: ScopeClass.PROJECT,
    content: `Embedding warmup source for ${objectId}.`,
    domain_tags: [],
    evidence_refs: [],
    workspace_id: "workspace-1",
    run_id: "run-1",
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
