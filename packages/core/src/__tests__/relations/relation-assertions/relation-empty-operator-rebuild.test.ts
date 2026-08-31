import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_RELATION_HISTORY_DIGEST,
  RunMode,
  RunState,
  WorkspaceKind,
  WorkspaceState
} from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteEventLogRepo,
  SqliteRelationAssertionRepo,
  SqliteRunRepo,
  SqliteTemporalPathProjectionReader,
  SqliteWorkspaceRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { LEGACY_STRUCTURED_EMPTY_HISTORY_DIGEST } from "../../../relations/relation-assertions/legacy-empty-history-digest.js";
import { RelationAssertionService } from "../../../relations/relation-assertions/relation-assertion-service.js";
import { EventPublisher } from "../../../runtime/event-publisher.js";

const databases = new Set<StorageDatabase>();
const EPOCH_AS_OF = "1970-01-01T00:00:00.000Z";
const BOOTSTRAP_GENERATION = "temporal-bootstrap-empty-v1";
const CACHE_AS_OF = "2026-07-17T00:00:00.000Z";
const NEW_AS_OF = "2026-07-17T01:30:00.000Z";
const NOW = "2026-07-17T01:02:04.000Z";
const ANCHORS = [{ kind: "object" as const, object_id: "memory-1" }];

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("legacy empty-history operator rebuild", () => {
  it("reuses a legacy structured-empty operator for historical empty rebuild without mutating current state", async () => {
    const harness = await createHarness();
    const legacyDigest = retargetLiveOperatorToLegacyStructuredEmpty(harness.database);
    const cacheGeneration = insertReadableAsOfCache(harness.database, CACHE_AS_OF);
    const before = readSchemaOperator(harness.database);
    const reader = new SqliteTemporalPathProjectionReader(harness.relationRepo);
    await expect(reader.findByAnchors("workspace-1", ANCHORS, { asOf: CACHE_AS_OF }))
      .resolves.toEqual([]);

    await harness.service.verifyAndRebuild(NEW_AS_OF);
    const first = readVerifiedGenerationAtAsOf(harness.database, NEW_AS_OF);
    expect(first.history_digest).toBe(legacyDigest);
    expect(readSchemaOperator(harness.database)).toEqual(before);
    expect(generationExists(harness.database, cacheGeneration)).toBe(true);
    await expect(reader.findByAnchors("workspace-1", ANCHORS, { asOf: NEW_AS_OF }))
      .resolves.toEqual([]);

    await harness.service.verifyAndRebuild(NEW_AS_OF);
    expect(readVerifiedGenerationAtAsOf(harness.database, NEW_AS_OF)).toEqual(first);
    expect(readSchemaOperator(harness.database)).toEqual(before);
    expect(countVerifiedBindKeys(harness.database, NEW_AS_OF, legacyDigest)).toBe(1);
    expect(generationExists(harness.database, cacheGeneration)).toBe(true);
  });

  it("heals a legacy-operator DB on current empty rebuild, then historical rebuild stays canonical", async () => {
    const harness = await createHarness();
    const legacyDigest = retargetLiveOperatorToLegacyStructuredEmpty(harness.database);
    const cacheGeneration = insertReadableAsOfCache(harness.database, CACHE_AS_OF);
    const reader = new SqliteTemporalPathProjectionReader(harness.relationRepo);

    await harness.service.verifyAndRebuild();
    const healed = readSchemaOperator(harness.database);
    expect(healed.history_digest).toBe(EMPTY_RELATION_HISTORY_DIGEST);
    expect(healed.active_as_of).toBe(NOW);
    expect(healed.active_projection_generation).not.toBe(BOOTSTRAP_GENERATION);
    expect(countVerifiedBindKeys(harness.database, CACHE_AS_OF, legacyDigest)).toBe(0);
    expect(generationExists(harness.database, cacheGeneration)).toBe(false);

    await harness.service.verifyAndRebuild(CACHE_AS_OF);
    expect(readVerifiedGenerationAtAsOf(harness.database, CACHE_AS_OF).history_digest)
      .toBe(EMPTY_RELATION_HISTORY_DIGEST);
    await expect(reader.findByAnchors("workspace-1", ANCHORS, { asOf: CACHE_AS_OF }))
      .resolves.toEqual([]);
  });

  it("reuses the epoch bootstrap verified bind key instead of inserting a duplicate", async () => {
    const harness = await createHarness();
    const before = readSchemaOperator(harness.database);
    expect(before.active_projection_generation).toBe(BOOTSTRAP_GENERATION);
    expect(before.active_as_of).toBe(EPOCH_AS_OF);
    expect(before.history_digest).toBe(EMPTY_RELATION_HISTORY_DIGEST);

    await harness.service.verifyAndRebuild(EPOCH_AS_OF);
    await harness.service.verifyAndRebuild(EPOCH_AS_OF);

    expect(readSchemaOperator(harness.database)).toEqual(before);
    expect(countVerifiedBindKeys(harness.database, EPOCH_AS_OF, EMPTY_RELATION_HISTORY_DIGEST)).toBe(1);
    expect(readVerifiedBindKeyGenerationIds(
      harness.database,
      EPOCH_AS_OF,
      EMPTY_RELATION_HISTORY_DIGEST
    )).toEqual([BOOTSTRAP_GENERATION]);
  });

  it("reports the persisted bootstrap id from epoch bind-key reuse, not a Core-minted unused id", async () => {
    const harness = await createHarness();
    const result = await harness.service.verifyAndRebuild(EPOCH_AS_OF);
    expect(readVerifiedBindKeyGenerationIds(
      harness.database,
      EPOCH_AS_OF,
      EMPTY_RELATION_HISTORY_DIGEST
    )).toEqual([BOOTSTRAP_GENERATION]);
    expect(result.projectionGeneration).toBe(BOOTSTRAP_GENERATION);
  });

  it("keeps schema identity equal to the stored generation on current epoch reuse", async () => {
    const harness = await createHarness(EPOCH_AS_OF);
    await harness.service.verifyAndRebuild();
    expect(readSchemaProjectionIdentity(harness.database))
      .toEqual(readActiveGenerationProjectionIdentity(harness.database));
  });
});

async function createHarness(now = NOW) {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  await new SqliteWorkspaceRepo(database).create({
    workspace_id: "workspace-1",
    name: "legacy empty operator test",
    root_path: "/tmp/legacy-empty-operator-test",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  await new SqliteRunRepo(database).create({
    run_id: "run-1",
    workspace_id: "workspace-1",
    title: "legacy empty operator test",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
  const eventLogRepo = new SqliteEventLogRepo(database);
  const relationRepo = new SqliteRelationAssertionRepo(database);
  return {
    database,
    relationRepo,
    service: new RelationAssertionService({
      repo: relationRepo,
      eventPublisher: new EventPublisher({
        eventLogRepo,
        runHotStateService: { apply: vi.fn() },
        runtimeNotifier: { notify: vi.fn(), notifyEntry: vi.fn() }
      }),
      eventHistory: eventLogRepo,
      now: () => now
    })
  };
}

function readSchemaProjectionIdentity(database: StorageDatabase) {
  return database.connection.prepare(`
    SELECT projection_count, projection_digest
    FROM temporal_schema_state
    WHERE state_id = 1
  `).get();
}

function readActiveGenerationProjectionIdentity(database: StorageDatabase) {
  return database.connection.prepare(`
    SELECT projection_count, projection_digest
    FROM temporal_projection_generations
    WHERE generation = (
      SELECT active_projection_generation FROM temporal_schema_state WHERE state_id = 1
    )
  `).get();
}

function retargetLiveOperatorToLegacyStructuredEmpty(database: StorageDatabase): string {
  const digest = LEGACY_STRUCTURED_EMPTY_HISTORY_DIGEST;
  database.connection.prepare(`
    UPDATE temporal_schema_state
    SET history_digest = ?
    WHERE state_id = 1
  `).run(digest);
  database.connection.prepare(`
    UPDATE temporal_projection_generations
    SET history_digest = ?
    WHERE generation = (
      SELECT active_projection_generation FROM temporal_schema_state WHERE state_id = 1
    )
  `).run(digest);
  return digest;
}

function insertReadableAsOfCache(database: StorageDatabase, asOf: string): string {
  const generation = `temporal-legacy-asof-cache`;
  database.connection.prepare(`
    INSERT INTO temporal_projection_generations (
      generation, assertion_schema_generation, assertion_event_contract_generation,
      projection_schema_generation, projection_policy_id, projection_policy_sha256,
      history_digest, as_of, projection_count, projection_digest, status,
      created_at, verified_at
    )
    SELECT ?, assertion_schema_generation, assertion_event_contract_generation,
      projection_schema_generation, projection_policy_id, projection_policy_sha256,
      history_digest, ?, 0, projection_digest, 'verified', ?, ?
    FROM temporal_projection_generations
    WHERE generation = (
      SELECT active_projection_generation FROM temporal_schema_state WHERE state_id = 1
    )
  `).run(generation, asOf, asOf, asOf);
  return generation;
}

function readSchemaOperator(database: StorageDatabase) {
  return database.connection.prepare(`
    SELECT active_projection_generation, active_as_of, history_digest
    FROM temporal_schema_state
    WHERE state_id = 1
  `).get() as Readonly<{
    readonly active_projection_generation: string;
    readonly active_as_of: string;
    readonly history_digest: string;
  }>;
}

function readVerifiedGenerationAtAsOf(database: StorageDatabase, asOf: string) {
  return database.connection.prepare(`
    SELECT generation, history_digest, as_of, status
    FROM temporal_projection_generations
    WHERE as_of = ? AND status = 'verified'
  `).get(asOf) as Readonly<{
    readonly generation: string;
    readonly history_digest: string;
    readonly as_of: string;
    readonly status: string;
  }>;
}

function countVerifiedBindKeys(database: StorageDatabase, asOf: string, historyDigest: string): number {
  const row = database.connection.prepare(`
    SELECT COUNT(*) AS n
    FROM temporal_projection_generations
    WHERE as_of = ? AND history_digest = ? AND status = 'verified'
  `).get(asOf, historyDigest) as { readonly n: number };
  return row.n;
}

function readVerifiedBindKeyGenerationIds(
  database: StorageDatabase,
  asOf: string,
  historyDigest: string
): readonly string[] {
  return (database.connection.prepare(`
    SELECT generation
    FROM temporal_projection_generations
    WHERE as_of = ? AND history_digest = ? AND status = 'verified'
    ORDER BY generation ASC
  `).all(asOf, historyDigest) as ReadonlyArray<{ readonly generation: string }>)
    .map((row) => row.generation);
}

function generationExists(database: StorageDatabase, generation: string): boolean {
  return database.connection.prepare(
    "SELECT 1 AS n FROM temporal_projection_generations WHERE generation = ?"
  ).get(generation) !== undefined;
}
