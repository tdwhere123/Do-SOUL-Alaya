import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RunMode,
  RunState,
  WorkspaceKind,
  WorkspaceState,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteMemoryEntryRepo,
  SqlitePathRelationRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo
} from "@do-soul/alaya-storage";
import {
  collectBenchSeedFuelInventory,
  createCachingSignalExtractor,
  toSeedFuelInventoryKpi,
  type CompileSeedExtractionStats
} from "../../longmemeval/compile-seed.js";
import { BENCH_DAEMON_DB_FILENAME } from "../../longmemeval/snapshot.js";
import { signalsEnvelope } from "./compile-seed-fixture.js";

const WS = "seed-fuel-ws";
const RUN = "seed-fuel-run";

function freshStats(): CompileSeedExtractionStats {
  return {
    path: "official_api_compile",
    cacheHits: 0,
    llmCalls: 0,
    offlineFallbacks: 0,
    liveExtractionFailures: 0,
    cachedExtractionFailures: 0,
    factsProduced: 0,
    signalsDropped: 0,
    signalsDroppedByReason: { candidate_absent: 0, materialization_drop: 0 },
    parseDropped: 0,
    compileOverflowDropped: 0,
    lastTurnRawSignalCount: 0,
    lastTurnDraftCount: 0,
    lastExtractionSource: null,
    lastCacheKey: null
  };
}

function memoryEntry(
  overrides: Partial<MemoryEntry> & Pick<MemoryEntry, "object_id">
): MemoryEntry {
  const { object_id, ...rest } = overrides;
  return {
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    created_by: "system",
    dimension: "fact",
    source_kind: "compiler",
    formation_kind: "extracted",
    scope_class: "project",
    content: "Alice moved to Berlin for her new job.",
    domain_tags: ["location"],
    evidence_refs: ["evidence-capsule-a"],
    workspace_id: WS,
    run_id: RUN,
    surface_id: null,
    storage_tier: "hot",
    activation_score: null,
    retention_score: null,
    manifestation_state: "full_eligible",
    retention_state: null,
    decay_profile: null,
    confidence: 0.9,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: null,
    contradiction_count: null,
    superseded_by: null,
    facet_tags: [{ facet: "location_place" }],
    object_id,
    ...rest
  } as MemoryEntry;
}

async function seedMaterializedBenchDb(dataDir: string): Promise<void> {
  const db = initDatabase({ filename: join(dataDir, BENCH_DAEMON_DB_FILENAME) });
  new SqliteWorkspaceRepo(db).create({
    workspace_id: WS,
    name: "seed fuel workspace",
    root_path: "/tmp/seed-fuel",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  new SqliteRunRepo(db).create({
    run_id: RUN,
    workspace_id: WS,
    title: "seed fuel run",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
  const memoryRepo = new SqliteMemoryEntryRepo(db);
  await memoryRepo.create(
    memoryEntry({
      object_id: "11111111-1111-4111-8111-111111111111",
      evidence_refs: ["evidence-capsule-a"]
    })
  );
  await memoryRepo.create(
    memoryEntry({
      object_id: "22222222-2222-4222-8222-222222222222",
      content: "She prefers tea over coffee.",
      evidence_refs: [],
      facet_tags: []
    })
  );
  const pathRepo = new SqlitePathRelationRepo(db);
  pathRepo.create({
    path_id: "path-answer",
    workspace_id: WS,
    anchors: {
      source_anchor: {
        kind: "object",
        object_id: "11111111-1111-4111-8111-111111111111"
      },
      target_anchor: {
        kind: "object",
        object_id: "22222222-2222-4222-8222-222222222222"
      }
    },
    constitution: {
      relation_kind: "answers_with",
      why_this_relation_exists: ["seed fuel regression"]
    },
    effect_vector: {
      salience: 1,
      recall_bias: 1,
      verification_bias: 0,
      unfinishedness_bias: 0,
      default_manifestation_preference: "lens_entry"
    },
    plasticity_state: {
      strength: 1,
      direction_bias: "source_to_target",
      stability_class: "stable",
      support_events_count: 1,
      contradiction_events_count: 0
    },
    lifecycle: {
      status: "active",
      retirement_rule: "manual"
    },
    legitimacy: {
      evidence_basis: ["seed-fuel-test"],
      governance_class: "recall_allowed"
    },
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z"
  });
  db.close();
}

describe("materialization fuel inventory integration", () => {
  let dataDir: string;
  let cacheRoot: string;

  afterEach(async () => {
    if (dataDir !== undefined) {
      await rm(dataDir, { recursive: true, force: true });
    }
    if (cacheRoot !== undefined) {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it("protects materialization fuel inventory: persisted seed rows report produced objects and missing support on answer-only memory", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "seed-fuel-data-"));
    await seedMaterializedBenchDb(dataDir);

    const inventory = await collectBenchSeedFuelInventory(dataDir);
    const kpi = toSeedFuelInventoryKpi(inventory);

    expect(kpi.objects_total).toBe(2);
    expect(kpi.evidence_refs_total).toBe(1);
    expect(kpi.facet_anchors_total).toBeGreaterThan(0);
    expect(kpi.path_candidates_total).toBe(1);
    expect(kpi.support_bearing_candidates).toBe(1);
  });

  it("protects materialization fuel inventory: cache replay serves extraction without new LLM calls before materialization", async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "seed-fuel-cache-"));
    const delegate = {
      extract: vi.fn(async () => ({
        rawJson: signalsEnvelope([
          { distilled: "Alice lives in Berlin.", matched: "moved to Berlin" }
        ])
      }))
    };
    const warmStats = freshStats();
    const warmExtractor = createCachingSignalExtractor({
      delegate,
      model: "test-model",
      cacheRoot,
      stats: warmStats
    });
    await warmExtractor.extract({ systemPrompt: "sys", userPrompt: "turn-content" });
    expect(warmStats.llmCalls).toBe(1);

    const replayStats = freshStats();
    const replayExtractor = createCachingSignalExtractor({
      delegate,
      model: "test-model",
      cacheRoot,
      stats: replayStats
    });
    const replay = await replayExtractor.extract({ systemPrompt: "sys", userPrompt: "turn-content" });
    expect(replay.rawJson).toContain("Alice lives in Berlin");
    expect(replayStats.cacheHits).toBe(1);
    expect(replayStats.llmCalls).toBe(0);
    expect(delegate.extract).toHaveBeenCalledTimes(1);
  });
});
