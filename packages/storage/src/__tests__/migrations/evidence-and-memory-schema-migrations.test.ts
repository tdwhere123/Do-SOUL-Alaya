import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";
import {
  DecayProfileSchema,
  EVIDENCE_FACT_FRAME_FORMATION_OPERATOR_ID,
  ForgetDispositionSchema,
  FormationKindSchema,
  ManifestationStateSchema,
  MemoryDimensionSchema,
  OPEN_SEMANTIC_FACTOR_FORMATION_OPERATOR_ID,
  ObjectLifecycleStateSchema,
  PreferencePolarity,
  RetentionStateSchema,
  ScopeClassSchema,
  SourceKindSchema,
  StorageTierSchema,
  TimePrecision,
  TimeSource
} from "@do-soul/alaya-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { initDatabase } from "../../sqlite/db.js";
import { migrateEmbeddingVectorValidity } from "../../sqlite/embedding-vector-validity-migration.js";
import {
  createMemoryEntry,
  createRepo,
  trackedDatabases as trackedMemoryEntryRepos
} from "../repos/memory-entry/memory-entry-repo-fixture.js";
import {
  createMigrationHarness,
  currentSchemaVersion,
  insertEvidenceCapsule,
  insertMemoryEntryRow,
  openBaselineDatabase
} from "./apply-baseline.js";

const migrationsDirectory = fileURLToPath(new URL("../../migrations", import.meta.url));
const harness = createMigrationHarness();

afterEach(() => {
  for (const database of trackedMemoryEntryRepos) database.close();
  trackedMemoryEntryRepos.clear();
  harness.cleanup();
});

function baselineDb(): BetterSqlite3.Database {
  return harness.trackRaw(openBaselineDatabase());
}

function formationDb(): BetterSqlite3.Database {
  const database = baselineDb();
  insertEvidenceCapsule(database, "evidence-1", { gist: "formed source" });
  insertEvidenceCapsule(database, "evidence-2", { gist: "unavailable source" });
  return database;
}

describe("evidence projection and formation schema migrations", () => {
  it("indexes associative fact keys in both lexical lanes", () => {
    const database = baselineDb();
    insertEvidenceCapsule(database, "evidence-1", { gist: "I use Atlas" });
    database.prepare(`
      INSERT INTO evidence_search_projections (
        evidence_object_id, projection_id, projection_kind,
        workspace_id, source_hash, content
      ) VALUES ('evidence-1', 1, 'fact_key', 'workspace-1', 'hash-1', ?)
    `).run("I use Atlas");

    expect(database.prepare(`
      SELECT projection_kind FROM evidence_search_projection_fts
      WHERE evidence_search_projection_fts MATCH ?
    `).all('content:"Atlas"')).toEqual([{ projection_kind: "fact_key" }]);
    expect(database.prepare(`
      SELECT projection_kind FROM evidence_search_projection_fts_trigram
      WHERE evidence_search_projection_fts_trigram MATCH ?
    `).all('content:"Atlas"')).toEqual([{ projection_kind: "fact_key" }]);
  });

  it("indexes gist when excerpt is a narrow distilled fact", () => {
    const database = baselineDb();
    insertEvidenceCapsule(database, "evidence-1", {
      excerpt: "I bought my bookshelf from IKEA.",
      gist: "User: I bought my bookshelf from IKEA. The patio table is weatherproof cedar."
    });
    const matchPorter = (term: string) => database.prepare(`
      SELECT object_id FROM evidence_capsule_fts WHERE evidence_capsule_fts MATCH ?
    `).all(term);

    expect(matchPorter("weatherproof")).toEqual([{ object_id: "evidence-1" }]);
    expect(matchPorter("bookshelf")).toEqual([{ object_id: "evidence-1" }]);
  });

  it("permits kind-local projection identities and rejects unknown kinds", () => {
    const database = baselineDb();
    insertEvidenceCapsule(database, "evidence-1", { gist: "I commute by bicycle." });
    const insertProjection = (projectionKind: string, projectionId: number, content: string) => {
      database.prepare(`
        INSERT INTO evidence_search_projections (
          evidence_object_id, projection_id, projection_kind,
          workspace_id, source_hash, content
        ) VALUES ('evidence-1', ?, ?, 'workspace-1', 'source-hash-1', ?)
      `).run(projectionId, projectionKind, content);
    };
    insertProjection("user_assertion", 1, "I commute by bicycle.");
    insertProjection("assistant_observation", 1, "Choose the TrailShell pack.");

    expect(database.prepare(`
      SELECT projection_kind, projection_id FROM evidence_search_projections
      ORDER BY projection_kind ASC, projection_id ASC
    `).all()).toEqual([
      { projection_kind: "assistant_observation", projection_id: 1 },
      { projection_kind: "user_assertion", projection_id: 1 }
    ]);
    expect(database.prepare(`
      SELECT projection_kind FROM evidence_search_projection_fts
      WHERE evidence_search_projection_fts MATCH ?
    `).all('content:"TrailShell"')).toEqual([{ projection_kind: "assistant_observation" }]);
    expect(() => insertProjection("unknown", 2, "invalid")).toThrow(/CHECK constraint failed/u);
  });

  it("stores formed and unavailable fact-frame captures and cascades with evidence", () => {
    const database = formationDb();
    insertFactFrameCapture(database, "formed", JSON.stringify({ schema_version: 1, slots: [] }));
    insertFactFrameCapture(database, "unavailable", null, "evidence-2");

    expect(database.prepare(`
      SELECT evidence_object_id, status FROM evidence_fact_frame_formations
      ORDER BY evidence_object_id
    `).all()).toEqual([
      { evidence_object_id: "evidence-1", status: "formed" },
      { evidence_object_id: "evidence-2", status: "unavailable" }
    ]);
    database.prepare("DELETE FROM evidence_capsules WHERE object_id = 'evidence-1'").run();
    expect(database.prepare(`
      SELECT evidence_object_id FROM evidence_fact_frame_formations
    `).all()).toEqual([{ evidence_object_id: "evidence-2" }]);
  });

  it("rejects fact-frame state shapes that cannot represent a sealed capture", () => {
    const database = formationDb();
    expect(() => insertFactFrameCapture(database, "formed", null)).toThrow();
    expect(() => insertFactFrameCapture(
      database,
      "unavailable",
      JSON.stringify({ schema_version: 1, slots: [] })
    )).toThrow();
    expect(() => database.prepare(`
      INSERT INTO evidence_fact_frame_formations (
        evidence_object_id, workspace_id, schema_version, operator_id, status,
        producer_operator_id, source_hash, fact_frame_json, capture_digest
      ) VALUES ('evidence-1', 'workspace-1', 1,
        'evidence_fact_frame_formation_v1', 'unavailable', NULL, 'hash-1', NULL, 'bad')
    `).run()).toThrow();
  });

  it("stores formed and unavailable semantic-factor captures and cascades with evidence", () => {
    const database = formationDb();
    insertSemanticFactorCapture(database, "formed", JSON.stringify({
      schema_version: 1, source_kind: "evidence", factors: [], variables: [], propositions: []
    }));
    insertSemanticFactorCapture(database, "unavailable", null, "evidence-2");

    expect(database.prepare(`
      SELECT evidence_object_id, status FROM evidence_semantic_factor_formations
      ORDER BY evidence_object_id
    `).all()).toEqual([
      { evidence_object_id: "evidence-1", status: "formed" },
      { evidence_object_id: "evidence-2", status: "unavailable" }
    ]);
    database.prepare("DELETE FROM evidence_capsules WHERE object_id = 'evidence-1'").run();
    expect(database.prepare(`
      SELECT evidence_object_id FROM evidence_semantic_factor_formations
    `).all()).toEqual([{ evidence_object_id: "evidence-2" }]);
  });

  it("rejects unsealed semantic-factor state shapes", () => {
    const database = formationDb();
    expect(() => insertSemanticFactorCapture(database, "formed", null)).toThrow();
    expect(() => insertSemanticFactorCapture(database, "unavailable", "{}")).toThrow();
    expect(() => database.prepare(`
      INSERT INTO evidence_semantic_factor_formations (
        evidence_object_id, workspace_id, schema_version, operator_id, status,
        producer_operator_id, source_sha256, graph_json, capture_digest
      ) VALUES ('evidence-1', 'workspace-1', 1,
        'open_semantic_factor_formation_v1', 'unavailable', NULL,
        'sha256:${"b".repeat(64)}', NULL, 'bad')
    `).run()).toThrow();
  });

  it("embeds the protocol operator_id constants in migration SQL", () => {
    const opsAndControl = fs.readFileSync(path.join(migrationsDirectory, "002-ops-and-control.sql"), "utf8");
    const memoryFtsAndGarden = fs.readFileSync(path.join(migrationsDirectory, "003-memory-fts-and-garden.sql"), "utf8");
    expect(opsAndControl).toContain(EVIDENCE_FACT_FRAME_FORMATION_OPERATOR_ID);
    expect(memoryFtsAndGarden).toContain(OPEN_SEMANTIC_FACTOR_FORMATION_OPERATOR_ID);
  });
});

describe("memory object keys and entry schema migrations", () => {
  it("indexes complementary key surfaces independently of memory content", () => {
    const database = baselineDb();
    insertMemoryEntryRow(database, "memory-1", "I took my niece to the museum.");
    insertObjectKey(database, {
      ownerId: "memory-1", keyId: "gist-golden", keyType: "gist_remainder",
      surface: "Golden Retriever", sourceRef: "evidence:capsule-1:gist:0:16"
    });

    expect(database.prepare(`
      SELECT owner_id FROM memory_object_key_fts WHERE memory_object_key_fts MATCH ?
    `).all('content:"Retriever"')).toEqual([{ owner_id: "memory-1" }]);
    expect(database.prepare(`
      SELECT owner_id FROM memory_object_key_fts_trigram WHERE memory_object_key_fts_trigram MATCH ?
    `).all('content:"Retriever"')).toEqual([{ owner_id: "memory-1" }]);
    expect(database.prepare(`
      SELECT object_id FROM memory_content_fts_porter WHERE memory_content_fts_porter MATCH ?
    `).all('content:"Retriever"')).toEqual([]);
  });

  it("rejects unknown key types and cascades with the owner memory", () => {
    const database = baselineDb();
    insertMemoryEntryRow(database, "memory-1", "distilled fact");
    expect(() => insertObjectKey(database, {
      ownerId: "memory-1", keyId: "bad", keyType: "facet_tag",
      surface: "health", sourceRef: "evidence:capsule-1:gist:0:6"
    })).toThrow(/CHECK constraint failed/u);

    insertObjectKey(database, {
      ownerId: "memory-1", keyId: "gist-asylum", keyType: "gist_remainder",
      surface: "asylum", sourceRef: "evidence:capsule-1:gist:20:26"
    });
    database.prepare("DELETE FROM memory_entries WHERE object_id = 'memory-1'").run();
    expect(database.prepare("SELECT COUNT(*) AS count FROM memory_object_keys").get()).toEqual({ count: 0 });
  });

  it("indexes CJK key surfaces on the trigram table", () => {
    const database = baselineDb();
    insertMemoryEntryRow(database, "memory-1", "I visited a museum.");
    insertObjectKey(database, {
      ownerId: "memory-1", keyId: "gist-museum", keyType: "gist_remainder",
      surface: "博物馆", sourceRef: "evidence:capsule-1:gist:0:3"
    });

    expect(database.prepare(`
      SELECT owner_id FROM memory_object_key_fts_trigram WHERE memory_object_key_fts_trigram MATCH ?
    `).all('content:"博物馆"')).toEqual([{ owner_id: "memory-1" }]);
  });

  it("rebuilds both FTS tables when a key surface is updated", () => {
    const database = baselineDb();
    insertMemoryEntryRow(database, "memory-1", "I visited a museum.");
    insertObjectKey(database, {
      ownerId: "memory-1", keyId: "gist-museum", keyType: "gist_remainder",
      surface: "Natural History", sourceRef: "evidence:capsule-1:gist:0:15"
    });
    database.prepare(`
      UPDATE memory_object_keys SET surface = ?, normalized_surface = lower(?) WHERE key_id = 'gist-museum'
    `).run("Golden Retriever", "Golden Retriever");

    expect(database.prepare(`
      SELECT owner_id FROM memory_object_key_fts WHERE memory_object_key_fts MATCH ?
    `).all('content:"History"')).toEqual([]);
    expect(database.prepare(`
      SELECT owner_id FROM memory_object_key_fts WHERE memory_object_key_fts MATCH ?
    `).all('content:"Retriever"')).toEqual([{ owner_id: "memory-1" }]);
    expect(database.prepare(`
      SELECT owner_id FROM memory_object_key_fts_trigram WHERE memory_object_key_fts_trigram MATCH ?
    `).all('content:"Retriever"')).toEqual([{ owner_id: "memory-1" }]);
  });

  it("indexes evidence_refs from created memory entries", async () => {
    const { database, repo } = await createRepo();
    await repo.create(createMemoryEntry({
      object_id: "11111111-1111-4111-8111-111111111111",
      evidence_refs: ["ev-1", "ev-2", "ev-1"]
    }));
    await repo.create(createMemoryEntry({
      object_id: "22222222-2222-4222-8222-222222222222",
      run_id: "run-2",
      evidence_refs: ["prefix-ev-1-suffix"]
    }));

    expect(database.connection.prepare(`
      SELECT memory_id, evidence_ref FROM memory_entry_evidence_refs
      ORDER BY memory_id ASC, evidence_ref ASC
    `).all()).toEqual([
      { memory_id: "11111111-1111-4111-8111-111111111111", evidence_ref: "ev-1" },
      { memory_id: "11111111-1111-4111-8111-111111111111", evidence_ref: "ev-2" },
      { memory_id: "22222222-2222-4222-8222-222222222222", evidence_ref: "prefix-ev-1-suffix" }
    ]);
    const rows = await repo.findByEvidenceRefs("workspace-1", ["ev-1"]);
    expect(rows.map((row) => row.object_id)).toEqual(["11111111-1111-4111-8111-111111111111"]);
  });

  it("adds canonical_entities on fresh databases and remains idempotent across reopens", () => {
    const hasColumn = (db: ReturnType<typeof initDatabase>) => (
      db.connection.pragma("table_info(memory_entries)") as ReadonlyArray<{ readonly name: string }>
    ).some((column) => column.name === "canonical_entities");

    const mem = harness.trackStorage(initDatabase({ filename: ":memory:" }));
    expect(hasColumn(mem)).toBe(true);

    const filename = path.join(harness.createTempDir("alaya-canonical-entities-"), "alaya.db");
    const first = harness.trackStorage(initDatabase({ filename }));
    expect(hasColumn(first)).toBe(true);
    first.close({ optimize: false });
    harness.untrackStorage(first);

    const second = harness.trackStorage(initDatabase({ filename }));
    expect(hasColumn(second)).toBe(true);
  });

  it("marks only strict finite nonzero vectors valid, remains stable on replay, and is wired at v15", () => {
    const database = harness.trackRaw(new BetterSqlite3(":memory:"));
    database.exec(`
      CREATE TABLE memory_embeddings (
        object_id TEXT PRIMARY KEY,
        provider_kind TEXT NOT NULL DEFAULT 'openai',
        model_id TEXT NOT NULL DEFAULT 'fixture-model',
        schema_version INTEGER NOT NULL DEFAULT 1,
        dimensions INTEGER NOT NULL,
        embedding_blob BLOB NOT NULL
      )
    `);
    const seedVector = (objectId: string, vector: Float32Array, dimensions: number, modelId = "fixture-model") => {
      const blob = Buffer.alloc(vector.length * Float32Array.BYTES_PER_ELEMENT);
      vector.forEach((value, index) => { blob.writeFloatLE(value, index * Float32Array.BYTES_PER_ELEMENT); });
      database.prepare(`
        INSERT INTO memory_embeddings (object_id, model_id, dimensions, embedding_blob) VALUES (?, ?, ?, ?)
      `).run(objectId, modelId, dimensions, blob);
    };
    seedVector("valid", new Float32Array([0.5, -0.25]), 2);
    seedVector("zero", new Float32Array([0, 0]), 2);
    seedVector("nan", new Float32Array([Number.NaN, 1]), 2);
    seedVector("truncated", new Float32Array([1]), 2);
    seedVector("mixed-2d", new Float32Array([1, 0]), 2, "mixed-model");
    seedVector("mixed-3d", new Float32Array([1, 0, 0]), 3, "mixed-model");

    database.transaction(() => {
      database.exec(`
        ALTER TABLE memory_embeddings
          ADD COLUMN vector_valid INTEGER NOT NULL DEFAULT 0 CHECK (vector_valid IN (0, 1));
      `);
      migrateEmbeddingVectorValidity(database);
    })();
    const expected = [
      { object_id: "mixed-2d", vector_valid: 0 },
      { object_id: "mixed-3d", vector_valid: 0 },
      { object_id: "nan", vector_valid: 0 },
      { object_id: "truncated", vector_valid: 0 },
      { object_id: "valid", vector_valid: 1 },
      { object_id: "zero", vector_valid: 0 }
    ];
    expect(database.prepare("SELECT object_id, vector_valid FROM memory_embeddings ORDER BY object_id").all()).toEqual(expected);
    database.transaction(() => migrateEmbeddingVectorValidity(database))();
    expect(database.prepare("SELECT object_id, vector_valid FROM memory_embeddings ORDER BY object_id").all()).toEqual(expected);

    const initialized = harness.trackStorage(initDatabase({ filename: ":memory:" }));
    const applied = initialized.connection.prepare(
      "SELECT 1 AS present FROM schema_version WHERE version = 15 LIMIT 1"
    ).get() as { readonly present: number } | undefined;
    expect(applied?.present).toBe(1);
  });

  it("keeps protocol enum sets identical to the rebuilt memory_entries CHECK lists and rejects illegal inserts", () => {
    const database = harness.trackStorage(initDatabase({ filename: ":memory:" }));
    const row = database.connection.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_entries'"
    ).get() as { readonly sql: string } | undefined;
    expect(row?.sql).toEqual(expect.any(String));
    const sql = row!.sql;
    expect(parseCheckInList(sql, "object_kind")).toEqual(["memory_entry"]);
    expect(parseCheckInList(sql, "lifecycle_state")).toEqual([...ObjectLifecycleStateSchema.options]);
    expect(parseCheckInList(sql, "dimension")).toEqual([...MemoryDimensionSchema.options]);
    expect(parseCheckInList(sql, "source_kind")).toEqual([...SourceKindSchema.options]);
    expect(parseCheckInList(sql, "formation_kind")).toEqual([...FormationKindSchema.options]);
    expect(parseCheckInList(sql, "scope_class")).toEqual([...ScopeClassSchema.options]);
    expect(parseCheckInList(sql, "storage_tier")).toEqual([...StorageTierSchema.options]);
    expect(parseCheckInList(sql, "manifestation_state")).toEqual([...ManifestationStateSchema.options]);
    expect(parseCheckInList(sql, "retention_state")).toEqual([...RetentionStateSchema.options]);
    expect(parseCheckInList(sql, "decay_profile")).toEqual([...DecayProfileSchema.options]);
    expect(parseCheckInList(sql, "forget_disposition")).toEqual([...ForgetDispositionSchema.options]);
    expect(parseCheckInList(sql, "time_precision")).toEqual(Object.values(TimePrecision));
    expect(parseCheckInList(sql, "time_source")).toEqual(Object.values(TimeSource));
    expect(parseCheckInList(sql, "preference_polarity")).toEqual(Object.values(PreferencePolarity));

    const insert = database.connection.prepare(`
      INSERT INTO memory_entries (
        object_id, created_at, updated_at, created_by,
        dimension, source_kind, formation_kind, scope_class, content,
        workspace_id, run_id, storage_tier
      ) VALUES (?, '2026-09-13T00:00:00.000Z', '2026-09-13T00:00:00.000Z', 'test',
        ?, 'compiler', 'explicit', 'project', 'content', 'workspace-1', 'run-1', ?)
    `);
    expect(() => insert.run("mem-illegal-dimension", "not-a-dimension", "hot")).toThrow(/CHECK/i);
    expect(() => insert.run("mem-illegal-tier", "fact", "frozen")).toThrow(/CHECK/i);
    insert.run("mem-legal", "fact", "hot");
    expect(database.connection.prepare(
      "SELECT dimension, storage_tier FROM memory_entries WHERE object_id = 'mem-legal'"
    ).get()).toEqual({ dimension: "fact", storage_tier: "hot" });
  });

  it("applies enum CHECKs on upgrade even when an unrelated FK violation already exists", () => {
    const { filename, database: old } = harness.seedLegacyFileDatabase(
      "alaya-enum-check-fk-", 13, "2026-09-01T00:00:00.000Z"
    );
    old.connection.pragma("foreign_keys = OFF");
    old.connection.prepare(`
      INSERT INTO memory_embeddings (
        object_id, workspace_id, content_hash, provider_kind, model_id,
        schema_version, dimensions, embedding_blob, created_at, updated_at
      ) VALUES (
        'missing-memory', 'missing-workspace', 'sha256:dead', 'openai', 'fixture',
        1, 1, ?, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'
      )
    `).run(Buffer.alloc(4));
    old.connection.pragma("foreign_keys = ON");
    old.close({ optimize: false });
    harness.untrackStorage(old);

    const migrated = harness.trackStorage(initDatabase({ filename }));
    expect(migrated.connection.prepare("SELECT MAX(version) AS version FROM schema_version").get())
      .toEqual({ version: currentSchemaVersion() });
    const insert = migrated.connection.prepare(`
      INSERT INTO memory_entries (
        object_id, created_at, updated_at, created_by,
        dimension, source_kind, formation_kind, scope_class, content,
        workspace_id, run_id, storage_tier
      ) VALUES (?, '2026-09-13T00:00:00.000Z', '2026-09-13T00:00:00.000Z', 'test',
        ?, 'compiler', 'explicit', 'project', 'content', 'workspace-1', 'run-1', ?)
    `);
    expect(() => insert.run("mem-illegal-dimension", "not-a-dimension", "hot")).toThrow(/CHECK/i);
    insert.run("mem-legal", "fact", "hot");
  }, process.platform === "win32" ? 180_000 : 60_000);
});

function insertFactFrameCapture(
  database: BetterSqlite3.Database,
  status: "formed" | "unavailable",
  factFrameJson: string | null,
  evidenceObjectId = "evidence-1"
): void {
  database.prepare(`
    INSERT INTO evidence_fact_frame_formations (
      evidence_object_id, workspace_id, schema_version, operator_id, status,
      producer_operator_id, source_hash, fact_frame_json, capture_digest
    ) VALUES (?, 'workspace-1', 1, 'evidence_fact_frame_formation_v1', ?, ?, 'hash-1', ?, ?)
  `).run(evidenceObjectId, status, status === "formed" ? "producer-v1" : null, factFrameJson, `sha256:${"a".repeat(64)}`);
}

function insertSemanticFactorCapture(
  database: BetterSqlite3.Database,
  status: "formed" | "unavailable",
  graphJson: string | null,
  evidenceObjectId = "evidence-1"
): void {
  database.prepare(`
    INSERT INTO evidence_semantic_factor_formations (
      evidence_object_id, workspace_id, schema_version, operator_id, status,
      producer_operator_id, source_sha256, graph_json, capture_digest
    ) VALUES (?, 'workspace-1', 1, 'open_semantic_factor_formation_v1', ?, ?,
      'sha256:${"b".repeat(64)}', ?, ?)
  `).run(evidenceObjectId, status, status === "formed" ? "producer-v1" : null, graphJson, `sha256:${"a".repeat(64)}`);
}

function insertObjectKey(
  database: BetterSqlite3.Database,
  input: Readonly<{
    readonly ownerId: string;
    readonly keyId: string;
    readonly keyType: string;
    readonly surface: string;
    readonly sourceRef: string;
  }>
): void {
  database.prepare(`
    INSERT INTO memory_object_keys (
      workspace_id, owner_id, key_id, key_type, surface, normalized_surface,
      language, source_kind, source_ref
    ) VALUES ('workspace-1', ?, ?, ?, ?, lower(?), 'en', 'evidence_gist', ?)
  `).run(input.ownerId, input.keyId, input.keyType, input.surface, input.surface, input.sourceRef);
}

function parseCheckInList(sql: string, column: string): readonly string[] {
  const required = new RegExp(
    `${column}\\s+TEXT\\s+NOT NULL(?:\\s+DEFAULT\\s+'[^']*')?\\s+CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(([^)]+)\\)`,
    "u"
  ).exec(sql);
  const optional = new RegExp(
    `${column}\\s+TEXT\\s+CHECK\\s*\\(\\s*${column}\\s+IS NULL OR\\s+${column}\\s+IN\\s*\\(([^)]+)\\)`,
    "u"
  ).exec(sql);
  const singleton = new RegExp(
    `${column}\\s+TEXT\\s+NOT NULL(?:\\s+DEFAULT\\s+'[^']*')?\\s+CHECK\\s*\\(\\s*${column}\\s*=\\s*'([^']+)'`,
    "u"
  ).exec(sql);
  const body = required?.[1] ?? optional?.[1];
  if (body !== undefined) {
    return [...body.matchAll(/'([^']+)'/gu)].map((match) => match[1]!);
  }
  if (singleton?.[1] !== undefined) {
    return [singleton[1]];
  }
  throw new Error(`missing CHECK for ${column}`);
}
