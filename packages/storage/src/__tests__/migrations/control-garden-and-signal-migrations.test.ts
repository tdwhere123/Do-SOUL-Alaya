import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { CandidateMemorySignalSchema, SOURCE_INTERPRETATION_CONTRACT, SOURCE_STATEMENTS_CONTRACT } from "@do-soul/alaya-protocol";
import { initDatabase, StorageDatabase, type SqliteConnection } from "../../sqlite/db.js";
import {
  __setApiKeyCipherKeyMaterialForTests,
  isEncryptedApiKeyAtRest,
  migrateEngineBindingApiKeysToCiphertext
} from "../../repos/control/api-key-cipher.js";
import { SqliteEngineBindingRepo } from "../../repos/control/engine-binding-repo.js";
import { SqliteEnrichPendingRepo } from "../../repos/garden/enrich-pending-repo.js";
import { initializeSemanticArtifactCandidateSchema } from "../../repos/garden/semantic-artifact-schema.js";
import { SqliteMemoryEntryRepo } from "../../repos/memory-entry/index.js";
import { SqliteSignalRepo } from "../../repos/signal/signal-repo.js";
import {
  applyBaselineSql,
  createMigrationHarness,
  currentSchemaVersion,
  insertMemoryEntryRow,
  openBaselineDatabase,
  seedWorkspaceRow
} from "./apply-baseline.js";

const harness = createMigrationHarness();
const SIGNAL_TIMESTAMP = "2026-09-14T00:00:00.000Z";

afterEach(() => {
  __setApiKeyCipherKeyMaterialForTests(null);
  harness.cleanup();
});

describe("engine_bindings api_key encryption and api_key_ref migrations", () => {
  it("encrypts plaintext api_key rows in place", () => {
    __setApiKeyCipherKeyMaterialForTests("migration-test-machine:migration-test-user:do-soul-alaya:engine-binding-api-key:v1");
    const db = harness.trackRaw(new BetterSqlite3(":memory:"));
    db.pragma("foreign_keys = ON");
    applyBaselineSql(db);
    seedWorkspaceRow(db, "workspace-104");
    db.prepare(`
      INSERT INTO engine_bindings (
        binding_id, workspace_id, provider_type, base_url, api_key, model, config_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "binding-legacy-104", "workspace-104", "openai", null, "sk-legacy-plaintext",
      "gpt-4o-mini", "{}", "2026-07-11T00:00:00.000Z", "2026-07-11T00:00:00.000Z"
    );

    migrateEngineBindingApiKeysToCiphertext(db);
    const row = db.prepare("SELECT api_key FROM engine_bindings WHERE binding_id = ?")
      .get("binding-legacy-104") as Readonly<{ readonly api_key: string }>;
    expect(row.api_key).not.toContain("sk-legacy-plaintext");
    expect(isEncryptedApiKeyAtRest(row.api_key)).toBe(true);
  });

  it("records the rebuilt baseline through initDatabase", () => {
    __setApiKeyCipherKeyMaterialForTests("init-test-machine:init-test-user:do-soul-alaya:engine-binding-api-key:v1");
    const database = harness.trackStorage(initDatabase({ filename: ":memory:" }));
    const version = database.connection.prepare("SELECT MAX(version) AS max_version FROM schema_version")
      .get() as Readonly<{ readonly max_version: number | null }>;
    expect(version.max_version).toBe(currentSchemaVersion());
  });

  it("supports ref-only upsert round-trip for engine_bindings.api_key_ref", async () => {
    const db = harness.trackRaw(openBaselineDatabase());
    seedWorkspaceRow(db, "workspace-1");
    const columns = db.prepare("PRAGMA table_info(engine_bindings)").all() as Array<{ readonly name: string }>;
    expect(columns.some((column) => column.name === "api_key_ref")).toBe(true);

    const database = new StorageDatabase(":memory:", db);
    const repo = new SqliteEngineBindingRepo(database);
    const saved = repo.upsert({
      binding_id: "binding-ref-103",
      workspace_id: "workspace-1",
      provider_type: "openai",
      base_url: null,
      api_key: "",
      api_key_ref: "OPENAI_API_KEY",
      model: "gpt-4o-mini",
      config: {},
      enable_tools: true
    });
    expect(saved.api_key_ref).toBe("OPENAI_API_KEY");
    expect(await repo.getById("binding-ref-103")).toEqual(saved);
  });
});

describe("garden, defer-queue, and path-relation migrations", () => {
  it("keeps enrich_pending retry defaults and the abandoned-row exclusion in the baseline schema", () => {
    const db = harness.trackRaw(openBaselineDatabase());
    seedWorkspaceRow(db, "workspace-1");
    seedPendingRow(db, "memory-abandoned", "2026-05-30T00:00:00.000Z");
    seedPendingRow(db, "memory-healthy", "2026-05-30T00:01:00.000Z");

    expect(db.prepare(
      "SELECT memory_id, attempt_count, abandoned_at FROM enrich_pending ORDER BY memory_id ASC"
    ).all()).toEqual([
      { memory_id: "memory-abandoned", attempt_count: 0, abandoned_at: null },
      { memory_id: "memory-healthy", attempt_count: 0, abandoned_at: null }
    ]);
    const indexSqlRow = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_enrich_pending_claimable'"
    ).get() as Readonly<{ readonly sql: string }> | undefined;
    expect(indexSqlRow?.sql).toContain("abandoned_at IS NULL");
  });

  it("claims healthy enrich_pending obligations after migrating to the current repository schema", () => {
    const database = harness.trackStorage(initDatabase({ filename: ":memory:" }));
    const db = database.connection;
    seedWorkspaceRow(db, "workspace-1");
    seedPendingRow(db, "memory-abandoned", "2026-05-30T00:00:00.000Z");
    seedPendingRow(db, "memory-healthy", "2026-05-30T00:01:00.000Z");
    db.prepare(`UPDATE enrich_pending SET attempt_count = 3, abandoned_at = ?
      WHERE workspace_id = ? AND memory_id = ?`)
      .run("2026-05-30T02:00:00.000Z", "workspace-1", "memory-abandoned");
    const claimed = new SqliteEnrichPendingRepo(database).claimBatch("workspace-1", 5, "2026-05-30T03:00:00.000Z", 3);
    expect(claimed.map((entry) => entry.memoryId)).toEqual(["memory-healthy"]);
    expect(claimed[0]?.independentProcessedAt).toBeNull();
  });

  it("does not promote soft-association legacy projections without usage authority", () => {
    const database = harness.trackRaw(openBaselineDatabase());
    seedWorkspaceRow(database, "workspace-1");
    insertPath(database, "path_relations", "canonical", "co_recalled", "attention_only");
    insertPath(database, "path_relations", "legacy-truth", "supports", "recall_allowed");

    expect(database.prepare("SELECT path_id FROM soft_association_path_relations ORDER BY path_id").all()).toEqual([]);
    expect(() => insertPath(
      database, "soft_association_path_relations", "invalid-soft", "supports", "attention_only"
    )).toThrow(/CHECK constraint failed/u);
  });

  it("stores per-workspace source-grounding defer queue rows and reason counts", () => {
    const database = harness.trackRaw(openBaselineDatabase());
    seedWorkspaceRow(database, "workspace-a");
    seedWorkspaceRow(database, "workspace-b");
    for (const [workspaceId, signalId] of [["workspace-a", "signal-a"], ["workspace-b", "signal-b"]] as const) {
      database.prepare(`
        INSERT INTO source_grounding_defer_queue (
          signal_id, workspace_id, run_id, defer_reason, enqueued_at
        ) VALUES (?, ?, ?, 'source_assertion_incomplete', ?)
      `).run(signalId, workspaceId, `run-${workspaceId}`, "2026-07-15T00:00:00.000Z");
    }
    database.prepare(`
      INSERT INTO source_grounding_defer_reason_counts (workspace_id, defer_reason, enqueue_count)
      VALUES ('workspace-a', 'source_assertion_incomplete', 2),
             ('workspace-b', 'source_assertion_incomplete', 1)
    `).run();

    expect(database.prepare(`
      SELECT workspace_id, defer_reason, enqueue_count FROM source_grounding_defer_reason_counts ORDER BY workspace_id
    `).all()).toEqual([
      { workspace_id: "workspace-a", defer_reason: "source_assertion_incomplete", enqueue_count: 2 },
      { workspace_id: "workspace-b", defer_reason: "source_assertion_incomplete", enqueue_count: 1 }
    ]);
    expect(database.prepare("SELECT workspace_id, signal_id FROM source_grounding_defer_queue ORDER BY workspace_id").all()).toEqual([
      { workspace_id: "workspace-a", signal_id: "signal-a" },
      { workspace_id: "workspace-b", signal_id: "signal-b" }
    ]);
    const queueColumns = database.prepare("PRAGMA table_info(source_grounding_defer_queue)")
      .all() as Array<{ readonly name: string }>;
    expect(queueColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "claim_token", "claim_token_fingerprint", "claim_expires_at", "capacity_blocked"
    ]));
    const queueIndexes = database.prepare("PRAGMA index_list(source_grounding_defer_queue)")
      .all() as Array<{ readonly name: string }>;
    expect(queueIndexes.map((index) => index.name)).toEqual(expect.arrayContaining([
      "idx_source_grounding_defer_queue_workspace_enqueued",
      "idx_source_grounding_defer_queue_claim_expiry",
      "idx_source_grounding_defer_queue_admission"
    ]));
  });
});

describe("observable generation and source observation signal migrations", () => {
  it("upgrades retained observers after all dependent tables exist and restores observers on rebuilt tables", () => {
    const filename = retainedProjection();
    let database = harness.trackStorage(initDatabase({ filename }));
    expect(database.connection.prepare("SELECT max(version) AS version FROM schema_version").get())
      .toEqual({ version: currentSchemaVersion() });
    expect(database.connection.prepare("SELECT observable_epoch FROM garden_projection_cursor WHERE workspace_id='workspace'").get())
      .toEqual({ observable_epoch: "retained-epoch" });
    assertQuarantineMutations(database.connection);
    const before = generation(database.connection);
    database.connection.exec("UPDATE source_index_lexical_selections SET selection_revision=2 WHERE workspace_id='workspace'");
    expect(generation(database.connection)).toBe(before + 1);
    database.close({ optimize: false });
    harness.untrackStorage(database);

    database = harness.trackStorage(initDatabase({ filename }));
    expect(generation(database.connection)).toBe(before + 1);
    assertQuarantineMutations(database.connection);
  });

  it("rolls back the migration batch and retained observers if the completed projection schema is incomplete", () => {
    const filename = retainedProjection();
    const legacy = harness.trackRaw(new BetterSqlite3(filename));
    const projection = (legacy.prepare("SELECT sql FROM sqlite_master WHERE name='garden_semantic_projections'").get() as { sql: string }).sql;
    legacy.exec("DROP TABLE garden_semantic_projections");
    const schema = legacy.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY name").all();
    const before = generation(legacy);
    legacy.close();
    expect(() => initDatabase({ filename })).toThrow();

    const retained = harness.trackRaw(new BetterSqlite3(filename));
    expect(retained.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
    expect(retained.prepare("SELECT max(version) AS version FROM schema_version").get()).toEqual({ version: 27 });
    expect(generation(retained)).toBe(before);
    retained.exec(projection);
    retained.close();

    const repaired = harness.trackStorage(initDatabase({ filename }));
    assertQuarantineMutations(repaired.connection);
  });

  it("refreshes observers on an already migrated reopen and rejects a missing required projection table", () => {
    const filename = retainedProjection();
    let database = harness.trackStorage(initDatabase({ filename }));
    const before = generation(database.connection);
    database.connection.exec("DROP TRIGGER garden_observable_privacy_dependency_quarantine_ai");
    database.close({ optimize: false });
    harness.untrackStorage(database);

    database = harness.trackStorage(initDatabase({ filename }));
    expect(generation(database.connection)).toBe(before);
    assertQuarantineMutations(database.connection);
    database.connection.exec("DROP TABLE garden_semantic_projections");
    database.close({ optimize: false });
    harness.untrackStorage(database);
    expect(() => initDatabase({ filename })).toThrow();
  });

  it("preserves historical bytes and foreign keys, then reopens null observation fields", async () => {
    const { filename, database: old } = harness.seedLegacyFileDatabase(
      "alaya-observation-migration-", 15, SIGNAL_TIMESTAMP, "memory.db"
    );
    seedWorkspaceRow(old.connection, "workspace-1");
    old.connection.prepare(`INSERT INTO runs(run_id, workspace_id, title, run_mode, created_at, last_active_at)
      VALUES ('run-1', 'workspace-1', 'run', 'chat', ?, ?)`).run(SIGNAL_TIMESTAMP, SIGNAL_TIMESTAMP);
    const raw = '{ "excerpt": "A sent mail." }';
    old.connection.prepare(`INSERT INTO signals(signal_id, workspace_id, run_id, source, signal_kind,
      object_kind, domain_tags_json, confidence, evidence_refs_json, raw_payload_json, created_at)
      VALUES ('old-signal', 'workspace-1', 'run-1', 'model_tool', 'potential_claim', 'fact', '[]', 0.7, '[]', ?, ?)`)
      .run(raw, SIGNAL_TIMESTAMP);
    insertMemoryEntryRow(old.connection, "old-memory", "old memory content");
    const oldRowid = old.connection.prepare("SELECT rowid FROM memory_entries WHERE object_id='old-memory'").get();
    old.close({ optimize: false });
    harness.untrackStorage(old);

    let database = harness.trackStorage(initDatabase({ filename }));
    expect(database.connection.pragma("foreign_key_check")).toEqual([]);
    expect(database.connection.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(database.connection.prepare("SELECT rowid FROM memory_entries WHERE object_id='old-memory'").get()).toEqual(oldRowid);
    expect(database.connection.prepare("SELECT raw_payload_json FROM signals WHERE signal_id='old-signal'").get()).toEqual({ raw_payload_json: raw });
    const oldSignal = await new SqliteSignalRepo(database).getById("old-signal");
    expect(oldSignal).toMatchObject({ confidence: 0.7, object_kind: "fact" });
    expect(oldSignal).not.toHaveProperty("interpretation_contract");

    const observation = CandidateMemorySignalSchema.parse({
      ...oldSignal, signal_id: "observation", source: "garden_compile",
      signal_kind: "potential_semantic_observation", object_kind: null, confidence: null,
      interpretation_contract: SOURCE_INTERPRETATION_CONTRACT,
      source_observation: { observed_at: SIGNAL_TIMESTAMP, authority: "trusted_host_event", source_event_id: "event-1" },
      raw_payload: { source_interpretation: {
        contract: SOURCE_INTERPRETATION_CONTRACT, artifact_key: "artifact-1", source_corpus_digest: "a".repeat(64),
        assertion_binding: { assertion_id: 1, source_span: [0, 12], text: "A sent mail.", context_id: "context-1" },
        outcome: "empty", candidates: [], diagnostics: []
      } }
    });
    await new SqliteSignalRepo(database).create(observation);
    database.connection.prepare("UPDATE memory_entries SET dimension='observation', confidence=NULL, retention_score=0.5, activation_score=0.3 WHERE object_id='old-memory'").run();
    expect(() => database.connection.prepare("UPDATE signals SET confidence=1 WHERE signal_id='observation'").run()).toThrow(/CHECK/);
    expect(() => database.connection.prepare("UPDATE signals SET confidence=NULL WHERE signal_id='old-signal'").run()).toThrow(/CHECK/);
    expect(() => database.connection.prepare("UPDATE signals SET interpretation_contract='unknown' WHERE signal_id='observation'").run()).toThrow(/CHECK/);
    database.close({ optimize: false });
    harness.untrackStorage(database);

    database = harness.trackStorage(initDatabase({ filename }));
    expect(await new SqliteSignalRepo(database).getById("observation")).toEqual(observation);
    expect(await new SqliteSignalRepo(database).getById("old-signal")).toEqual(oldSignal);
    expect(database.connection.prepare("SELECT dimension, confidence, retention_score, activation_score FROM memory_entries WHERE object_id='old-memory'").get())
      .toEqual({ dimension: "observation", confidence: null, retention_score: 0.5, activation_score: 0.3 });
    expect(database.connection.prepare("SELECT object_id FROM memory_content_fts WHERE memory_content_fts MATCH 'content'").all())
      .toEqual([{ object_id: "old-memory" }]);
    expect(database.connection.pragma("foreign_key_check")).toEqual([]);
    expect(database.connection.prepare("SELECT max(version) AS version FROM schema_version").get()).toEqual({ version: currentSchemaVersion() });
  }, process.platform === "win32" ? 180_000 : 60_000);

  it("upgrades pre-statement history atomically and enforces already-recorded erasure without inventing derived ownership", async () => {
    const { filename, database: old } = harness.seedLegacyFileDatabase(
      "alaya-statement-migration-", 36, SIGNAL_TIMESTAMP, "memory.db"
    );
    seedWorkspaceRow(old.connection, "workspace-1");
    old.connection.prepare(`INSERT INTO runs(run_id,workspace_id,title,run_mode,created_at,last_active_at)
      VALUES('run-1','workspace-1','run','chat',?,?)`).run(SIGNAL_TIMESTAMP, SIGNAL_TIMESTAMP);
    const raw = '{ "excerpt": "A retained explicit signal." }';
    old.connection.prepare(`INSERT INTO signals(signal_id,workspace_id,run_id,source,signal_kind,object_kind,
      domain_tags_json,confidence,evidence_refs_json,raw_payload_json,created_at)
      VALUES('explicit-signal','workspace-1','run-1','model_tool','potential_claim','fact','[]',0.7,'[]',?,?)`).run(raw, SIGNAL_TIMESTAMP);
    const independentId = "11111111-1111-4111-8111-111111111111";
    insertMemoryEntryRow(old.connection, independentId, "A retained explicit signal.");
    const originalMemory = old.connection.prepare("SELECT * FROM memory_entries WHERE object_id=?").get(independentId);
    const erasedRoot = `sha256:${"c".repeat(64)}`;
    old.connection.prepare(`INSERT INTO projection_erase_barriers(workspace_id,barrier_id,receipt_identity,subject_kind,subject_id,erased_at)
      VALUES('workspace-1','recorded-barrier','recorded-receipt','source_record',?,?)`).run(erasedRoot, SIGNAL_TIMESTAMP);
    expect(() => old.connection.prepare(`UPDATE signals SET interpretation_contract='source-statements-v1',
      source='garden_compile',signal_kind='potential_semantic_observation',object_kind=NULL,confidence=NULL
      WHERE signal_id='explicit-signal'`).run()).toThrow(/CHECK/);
    old.close({ optimize: false });
    harness.untrackStorage(old);

    let database = harness.trackStorage(initDatabase({ filename }));
    expect(database.connection.prepare("SELECT * FROM memory_entries WHERE object_id=?").get(independentId)).toEqual(originalMemory);
    expect(database.connection.prepare("SELECT raw_payload_json FROM signals WHERE signal_id='explicit-signal'").get()).toEqual({ raw_payload_json: raw });
    for (const table of ["source_statement_artifacts", "source_statement_dependencies", "source_statement_memory_bindings"]) {
      expect(database.connection.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
    const original = await new SqliteSignalRepo(database).getById("explicit-signal");
    for (const contextDependency of [false, true]) {
      const statement = CandidateMemorySignalSchema.parse({
        ...original, signal_id: `refused-${contextDependency}`,
        source: "garden_compile", signal_kind: "potential_semantic_observation", object_kind: null, confidence: null,
        interpretation_contract: SOURCE_STATEMENTS_CONTRACT, source_observation: null,
        raw_payload: { source_statement: {
          contract: SOURCE_STATEMENTS_CONTRACT, artifact_key: "source", session_id: "session",
          source_root_id: contextDependency ? "other-root" : erasedRoot, source_corpus_digest: "a".repeat(64),
          source_span: [0, 12], message: { message_id: "message", role: "user", text: "Source note.", recorded_at: null },
          statement: { text: "Recorded rewrite.", relation: "note" },
          source_context: contextDependency ? [{ workspace_id: "workspace-1", root_id: erasedRoot, source_id: "old-source",
            source_version: "1", content_digest: `sha256:${"b".repeat(64)}` }] : []
        } }
      });
      await expect(new SqliteSignalRepo(database).create(statement)).rejects.toThrow();
    }
    expect(database.connection.prepare("SELECT COUNT(*) AS n FROM signals").get()).toEqual({ n: 1 });
    expect(database.connection.pragma("foreign_key_check")).toEqual([]);
    database.close({ optimize: false });
    harness.untrackStorage(database);

    database = harness.trackStorage(initDatabase({ filename }));
    expect((await new SqliteMemoryEntryRepo(database).findById(independentId))?.content).toBe("A retained explicit signal.");
    expect(await new SqliteSignalRepo(database).getById("explicit-signal")).toEqual(original);
  });
});

function seedPendingRow(db: BetterSqlite3.Database, memoryId: string, enqueuedAt: string): void {
  db.prepare(`
    INSERT INTO enrich_pending (
      workspace_id, memory_id, run_id, source_signal_id, enqueued_at, claimed_at, processed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("workspace-1", memoryId, "run-1", `${memoryId}-signal`, enqueuedAt, null, null);
}

function insertPath(
  database: BetterSqlite3.Database,
  table: "path_relations" | "soft_association_path_relations",
  pathId: string,
  relationKind: string,
  governanceClass: string
): void {
  database.prepare(`INSERT INTO ${table} (
    path_id, workspace_id, anchors_json, constitution_json, effect_vector_json,
    plasticity_state_json, lifecycle_json, legitimacy_json, created_at, updated_at
  ) VALUES (?, 'workspace-1', ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      pathId,
      JSON.stringify({ source_anchor: { kind: "object", object_id: "object-1" }, target_anchor: { kind: "object", object_id: "object-2" } }),
      JSON.stringify({ relation_kind: relationKind, why_this_relation_exists: ["test"] }),
      JSON.stringify({ recall_bias: 0.5 }),
      JSON.stringify({ strength: 0.5 }),
      JSON.stringify({ status: "active" }),
      JSON.stringify({ evidence_basis: ["recalls_edge_co_usage"], governance_class: governanceClass }),
      "2026-04-17T00:00:00.000Z",
      "2026-04-17T00:00:00.000Z"
    );
}

function retainedProjection(): string {
  const { filename, database: owner } = harness.seedLegacyFileDatabase(
    "observable-generation-migration-", 27, "2026-09-06T00:00:00.000Z", "retained.sqlite"
  );
  const template = initDatabase();
  const legacy = owner.connection;
  try {
    initializeSemanticArtifactCandidateSchema(template.connection);
    const schema = template.connection.prepare(`SELECT sql FROM sqlite_master WHERE
      name IN ('garden_projection_cursor', 'garden_semantic_projections') OR
      (type='trigger' AND name GLOB 'garden_observable_*' AND tbl_name!='privacy_dependency_quarantine')
      ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name`).all() as { sql: string }[];
    for (const { sql } of schema) legacy.exec(sql);
    legacy.exec(`INSERT INTO garden_projection_cursor
      (workspace_id,applied_event_revision,applied_at,observable_generation,observable_epoch)
      VALUES ('workspace',7,'2026-09-06T00:00:00.000Z',41,'retained-epoch');
      INSERT INTO source_index_lexical_selections VALUES ('workspace',1,'raw-unicode61.v1',NULL)`);
  } finally {
    owner.close({ optimize: false });
    harness.untrackStorage(owner);
    template.close({ optimize: false });
  }
  return filename;
}

function generation(connection: SqliteConnection): number {
  return (connection.prepare("SELECT observable_generation FROM garden_projection_cursor WHERE workspace_id='workspace'")
    .get() as { observable_generation: number }).observable_generation;
}

function assertQuarantineMutations(connection: SqliteConnection): void {
  const before = generation(connection);
  connection.exec(`INSERT INTO privacy_dependency_quarantine(workspace_id,object_kind,object_id)
    VALUES ('workspace','memory_entry','unavailable')`);
  expect(generation(connection)).toBe(before + 1);
  connection.exec("UPDATE privacy_dependency_quarantine SET reason='still_unavailable' WHERE object_id='unavailable'");
  expect(generation(connection)).toBe(before + 2);
  connection.exec("DELETE FROM privacy_dependency_quarantine WHERE object_id='unavailable'");
  expect(generation(connection)).toBe(before + 3);
}
