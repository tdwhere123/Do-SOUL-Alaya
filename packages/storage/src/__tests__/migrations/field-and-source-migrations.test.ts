import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalJson,
  hashLabeledIdentity,
  hashSourceRecordId,
  sourceRecallTarget,
  type SourceRepresentation
} from "@do-soul/alaya-protocol";
import { closeCachedDatabase, initDatabase, readSchemaMigrationLedger, StorageDatabase } from "../../index.js";
import { SqliteEvidenceCapsuleRepo } from "../../repos/capsules/evidence-capsule-repo.js";
import { SqliteFieldEraseBarrierRepo } from "../../repos/field/erase-repo.js";
import { SqliteFieldProjectionGenerationRepo } from "../../repos/field/generation-repo.js";
import { sourceRecordFromRow } from "../../repos/field/mappers/field-receipts.js";
import type { FieldSourceRecordRow } from "../../repos/field/ports.js";
import { writeRetainedSourceChunks } from "../../repos/field/retained-source-chunks.js";
import { SqliteSourceRootRecallReader } from "../../repos/field/bounded-source-root-reader.js";
import { SqliteFieldSourceRecordRepo, SqliteFieldSourceSpanRepo } from "../../repos/field/source-repo.js";
import { SqliteEventLogRepo } from "../../repos/runtime/event-log-repo.js";
import { migrateVerifiedProjectionBindKey } from "../../sqlite/temporal-verified-bind-key.js";
import {
  CLOCK,
  fieldSha256,
  hashedFactor,
  hashedGeneration,
  hashedIncidence,
  hashedRecord,
  hashedSpan,
  seedWorkspaces
} from "../repos/field/field-contract-fixture.js";
import {
  applyBaselineSql,
  createMigrationHarness,
  currentSchemaVersion,
  insertEvidenceCapsule,
  openBaselineDatabase,
  seedWorkspaceRow
} from "./apply-baseline.js";

const harness = createMigrationHarness();
const cachedFilenames = new Set<string>();

afterEach(() => {
  harness.cleanup();
  for (const filename of cachedFilenames) closeCachedDatabase(filename);
  cachedFilenames.clear();
});

const LIST_INCIDENCES_SQL = `
  SELECT incidence_id, span_id, factor_id, scope, operator_id, workspace_id, recorded_at
  FROM factor_incidences WHERE workspace_id = ? ORDER BY incidence_id
`;
const DELETE_INCIDENCE_SQL = `DELETE FROM factor_incidences WHERE workspace_id = ? AND incidence_id = ?`;
const COMPACT_MIGRATION_SQL = readFileSync(
  fileURLToPath(new URL("../../migrations/009-compact-factor-incidences.sql", import.meta.url)),
  "utf8"
);
const LEGACY_IDENTITY_SQL = `SELECT record_id, workspace_id, source_id, source_version, content_digest,
  evidence_object_id, recorded_at, event_time, valid_from, valid_to, operator_id, speaker, scope_class, source_body
  FROM source_records WHERE workspace_id = ? ORDER BY record_id`;

describe("field contract foundation and compact factor incidences", () => {
  it("applies workspace-qualified keys and rejects inverted spans and delivery learning", () => {
    const database = harness.trackRaw(openBaselineDatabase());
    seedWorkspaceRow(database, "workspace-1");
    seedWorkspaceRow(database, "workspace-2");
    for (const [workspaceId, body] of [["workspace-1", "visible body"], ["workspace-2", "other body"]] as const) {
      database.prepare(`
        INSERT INTO source_records (
          record_id, workspace_id, source_id, source_version, content_digest,
          evidence_object_id, recorded_at, event_time, valid_from, valid_to, operator_id, source_body
        ) VALUES ('record-1', ?, 'src-1', 'v1', 'sha256:aaa', NULL, '2026-08-16T00:00:00.000Z',
          NULL, NULL, NULL, 'source_span_identity_v1', ?)
      `).run(workspaceId, body);
    }
    database.prepare(`
      INSERT INTO source_spans (
        span_id, record_id, start_offset, end_offset, purpose, producer_version, workspace_id, recorded_at
      ) VALUES ('span-1', 'record-1', 0, 4, 'sentence', 'source_span_identity_v1',
        'workspace-1', '2026-08-16T00:00:00.000Z')
    `).run();

    expect(database.prepare("SELECT workspace_id, record_id FROM source_records ORDER BY workspace_id").all()).toEqual([
      { workspace_id: "workspace-1", record_id: "record-1" },
      { workspace_id: "workspace-2", record_id: "record-1" }
    ]);
    expect(() => database.prepare(`
      INSERT INTO source_spans (
        span_id, record_id, start_offset, end_offset, purpose, producer_version, workspace_id, recorded_at
      ) VALUES ('span-bad', 'record-1', 4, 2, 'sentence', 'source_span_identity_v1',
        'workspace-1', '2026-08-16T00:00:00.000Z')
    `).run()).toThrow(/CHECK constraint failed/u);
    expect(() => database.prepare(`
      INSERT INTO source_spans (
        span_id, record_id, start_offset, end_offset, purpose, producer_version, workspace_id, recorded_at
      ) VALUES ('span-neg', 'record-1', -1, 2, 'sentence', 'source_span_identity_v1',
        'workspace-1', '2026-08-16T00:00:00.000Z')
    `).run()).toThrow(/CHECK constraint failed/u);
    expect(() => database.prepare(`
      INSERT INTO causal_usage_receipts (
        identity, workspace_id, causal_key, occurred_at, downstream_ref, weight,
        scope, usage_kind, operator_id, recorded_at
      ) VALUES (?, 'workspace-1', 'use-1', '2026-08-16T00:00:00.000Z', 'path-1',
        0.5, 'workspace-1', 'delivery', 'causal_usage_v1', '2026-08-16T00:00:00.000Z')
    `).run("sha256:" + "a".repeat(64))).toThrow(/CHECK constraint failed/u);
    expect(() => database.prepare(`
      INSERT INTO causal_usage_receipts (
        identity, workspace_id, causal_key, occurred_at, downstream_ref, weight,
        scope, usage_kind, operator_id, recorded_at
      ) VALUES (?, 'workspace-1', 'use-2', '2026-08-16T00:00:00.000Z', 'path-1',
        1e999, 'workspace-1', 'causal', 'causal_usage_v1', '2026-08-16T00:00:00.000Z')
    `).run("sha256:" + "b".repeat(64))).toThrow(/CHECK constraint failed/u);
  });

  it("lists and erases factor_incidences via the clustered WITHOUT ROWID primary key", () => {
    const database = openVersion8Incidences();
    database.exec(COMPACT_MIGRATION_SQL);
    const listPlan = explain(database, LIST_INCIDENCES_SQL, ["workspace-1"]);
    const deletePlan = explain(database, DELETE_INCIDENCE_SQL, ["workspace-1", "missing-incidence"]);
    const rows = database.prepare(LIST_INCIDENCES_SQL).all("workspace-1") as ReadonlyArray<{ readonly incidence_id: string }>;

    expect(listPlan).toBe("SEARCH factor_incidences USING PRIMARY KEY (workspace_id=?)");
    expect(deletePlan).toBe("SEARCH factor_incidences USING PRIMARY KEY (workspace_id=? AND incidence_id=?)");
    expect(listPlan).not.toMatch(/SCAN/i);
    expect(deletePlan).not.toMatch(/SCAN/i);
    expect(rows).toHaveLength(3);
    database.prepare(DELETE_INCIDENCE_SQL).run("workspace-1", rows[0]!.incidence_id);
    expect(database.prepare(LIST_INCIDENCES_SQL).all("workspace-1")).toHaveLength(2);
    assertCompactCatalog(database);
  });

  it("copies existing incidences through 009 without changing identity", () => {
    const database = openVersion8Incidences();
    const before = database.prepare(LIST_INCIDENCES_SQL).all("workspace-1");
    database.exec(COMPACT_MIGRATION_SQL);
    const after = database.prepare(LIST_INCIDENCES_SQL).all("workspace-1");

    expect(before).toHaveLength(3);
    expect(after).toEqual(before);
    expect(explain(database, LIST_INCIDENCES_SQL, ["workspace-1"]))
      .toBe("SEARCH factor_incidences USING PRIMARY KEY (workspace_id=?)");
    assertCompactCatalog(database);
  });

  it("keeps unique admission and erase-barrier rejection after compact", () => {
    const database = openVersion8Incidences();
    database.exec(COMPACT_MIGRATION_SQL);
    const existing = database.prepare(LIST_INCIDENCES_SQL).get("workspace-1") as {
      readonly span_id: string;
      readonly factor_id: string;
      readonly operator_id: string;
    };
    database.prepare(`
      INSERT INTO projection_erase_barriers (
        workspace_id, barrier_id, receipt_identity, generation_id, subject_kind, subject_id, erased_at
      ) VALUES (?, ?, ?, NULL, 'incidence', ?, ?)
    `).run("workspace-1", "barrier-1", "receipt-1", "erased-incidence", CLOCK);

    expect(() => database.prepare(`
      INSERT INTO factor_incidences (
        workspace_id, incidence_id, span_id, factor_id, scope, operator_id, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("workspace-1", "erased-incidence", existing.span_id, existing.factor_id, "erased-scope", existing.operator_id, CLOCK))
      .toThrow(/erased factor incidence cannot be admitted/u);

    expect(() => database.prepare(`
      INSERT INTO factor_incidences (
        workspace_id, incidence_id, span_id, factor_id, scope, operator_id, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("workspace-1", "duplicate-incidence", existing.span_id, existing.factor_id, "workspace-1", existing.operator_id, CLOCK))
      .toThrow(/UNIQUE constraint failed/u);
  });
});

describe("source record index, chunks, host occurrences, and representation migrations", () => {
  it("indexes retained rows by full UTC precision without rewriting source identities or timestamps", () => {
    const { database: old, filename } = harness.seedLegacyFileDatabase("alaya-current-source-upgrade-", 17, CLOCK, "source.sqlite");
    seedWorkspaces(old);
    const first = insertLegacyV17Record(old, { ...hashedRecord("workspace-1", "minute"), recorded_at: "2026-09-22T00:00Z" });
    const current = insertLegacyV17Record(old, { ...hashedRecord("workspace-1", "fraction"), recorded_at: "2026-09-22T00:00:00.00000000002Z" });
    insertLegacyV17Record(old, { ...hashedRecord("workspace-1", "earlier fraction"), recorded_at: "2026-09-22T00:00:00.00000000001Z" });
    const before = old.connection.prepare(LEGACY_IDENTITY_SQL).all("workspace-1");
    old.close({ optimize: false });
    harness.untrackStorage(old);

    const migrated = harness.trackStorage(initDatabase({ filename }));
    const reader = new SqliteFieldSourceRecordRepo(migrated, fieldSha256);
    expect(reader.findCurrent("workspace-1", first.source_id)?.record_id).toBe(current.record_id);
    expect(reader.findCurrent("workspace-1", first.source_id)?.recorded_at).toBe(current.recorded_at);
    expect(reader.findCurrentBounded("workspace-1", first.source_id)?.record?.record_id).toBe(current.record_id);
    expect(migrated.connection.prepare(LEGACY_IDENTITY_SQL).all("workspace-1")).toEqual(before);
    expect(migrated.connection.prepare(
      "SELECT attribution_context_json FROM source_records WHERE workspace_id = ? ORDER BY record_id"
    ).all("workspace-1")).toEqual([
      { attribution_context_json: null }, { attribution_context_json: null }, { attribution_context_json: null }
    ]);
    expect(migrated.connection.prepare("SELECT MAX(version) AS version FROM schema_version").get())
      .toEqual({ version: currentSchemaVersion() });
  });

  it("fails the current-source index migration atomically for an invalid retained instant", () => {
    const { database: old, filename } = harness.seedLegacyFileDatabase("alaya-current-source-invalid-", 17, CLOCK, "source.sqlite");
    seedWorkspaces(old);
    const invalid = insertLegacyV17Record(old, { ...hashedRecord("workspace-1", "invalid time"), recorded_at: "invalid" });
    old.close({ optimize: false });
    harness.untrackStorage(old);

    expect(() => initDatabase({ filename })).toThrow(expect.objectContaining({
      code: "MIGRATION_FAILED", cause: expect.objectContaining({ message: "invalid UTC instant in current-source index" })
    }));
    const retained = harness.trackStorage(new StorageDatabase(filename, new BetterSqlite3(filename, { readonly: true })));
    expect(retained.connection.prepare("SELECT MAX(version) AS version FROM schema_version").get()).toEqual({ version: 17 });
    expect(retained.connection.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_source_records_current'").get()).toBeUndefined();
    expect(retained.connection.prepare(
      "SELECT recorded_at FROM source_records WHERE workspace_id = ? AND record_id = ?"
    ).get("workspace-1", invalid.record_id)).toEqual({ recorded_at: "invalid" });
  });

  it("prepares both canonical root kinds on upgrade from 12 and reads them after a read-only restart", () => {
    const { database: old, filename } = harness.seedLegacyFileDatabase("alaya-chunk-upgrade-", 12, "2026-09-01T00:00:00.000Z", "source.sqlite");
    seedWorkspaces(old);
    const record = hashedRecord("workspace-1", "original😀 retained", "migration-record");
    old.connection.prepare(`INSERT INTO source_records(record_id,workspace_id,source_id,source_version,content_digest,
      evidence_object_id,recorded_at,event_time,valid_from,valid_to,operator_id,speaker,scope_class,source_body)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(record.record_id, record.workspace_id, record.source_id, record.source_version,
      record.content_digest, null, record.recorded_at, null, null, null, record.operator_id, null, null, record.source_body);
    insertEvidenceCapsule(old.connection, "capsule-migration", { gist: "gist", excerpt: "capsule😀 retained" });
    old.close({ optimize: false });
    harness.untrackStorage(old);

    const migrated = harness.trackStorage(initDatabase({ filename }));
    expect(migrated.connection.prepare("SELECT MAX(version) AS version FROM schema_version").get()).toEqual({ version: currentSchemaVersion() });
    expect(migrated.connection.prepare("SELECT COUNT(*) AS count FROM retained_source_chunks").get()).toEqual({ count: 2 });
    migrated.close({ optimize: false });
    harness.untrackStorage(migrated);

    const readonly = harness.trackStorage(new StorageDatabase(filename, new BetterSqlite3(filename, { readonly: true })));
    readonly.connection.pragma("query_only = ON");
    const reader = new SqliteSourceRootRecallReader(new SqliteFieldSourceRecordRepo(readonly, fieldSha256), new SqliteEvidenceCapsuleRepo(readonly));
    const page = reader.page({ workspaceId: "workspace-1", limit: 8, nativeLimit: 8, afterCursor: null });
    expect(page.unavailable).toBe(false);
    expect(page.rows.map((row) => row.content)).toEqual(expect.arrayContaining(["original😀 retained", "capsule😀 retained"]));
    expect(readonly.connection.prepare("SELECT source_body FROM source_records WHERE record_id = ?").get(record.record_id))
      .toEqual({ source_body: "original😀 retained" });
  }, process.platform === "win32" ? 180_000 : 60_000);

  it("migrates populated spans, preserving unknown metadata and the erase guard", () => {
    const { database: seed, filename } = harness.seedLegacyFileDatabase("source-host-migration-", 23, "2026-09-13T00:00:00Z", "source.sqlite");
    cachedFilenames.add(filename);
    migrateVerifiedProjectionBindKey(seed.connection);
    seedWorkspaces(seed);
    const records = new SqliteFieldSourceRecordRepo(seed, fieldSha256);
    const spans = new SqliteFieldSourceSpanRepo(seed, fieldSha256);
    const record = hashedRecord("workspace-1", "retained body");
    expect(() => records.insert(record)).toThrow(/current host-capable/);
    seed.connection.prepare(`INSERT INTO source_records (workspace_id, record_id, source_id, source_version,
      content_digest, evidence_object_id, recorded_at, event_time, valid_from, valid_to, operator_id, speaker,
      scope_class, attribution_context_json, source_body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.workspace_id, record.record_id, record.source_id, record.source_version, record.content_digest,
        record.evidence_object_id, record.recorded_at, record.event_time, record.valid_from, record.valid_to,
        record.operator_id, record.speaker, record.scope_class, canonicalJson(record.attribution_context), record.source_body);
    const span = spans.insert(hashedSpan("workspace-1", record.record_id, 0, 5));
    seed.close({ optimize: false });
    harness.untrackStorage(seed);

    const migrated = harness.trackStorage(initDatabase({ filename }));
    expect(new SqliteFieldSourceRecordRepo(migrated, fieldSha256).findById("workspace-1", record.record_id)).toEqual(record);
    expect(new SqliteFieldSourceSpanRepo(migrated, fieldSha256).findById("workspace-1", span.span_id)).toEqual(span);
    expect(migrated.connection.pragma("foreign_key_check")).toEqual([]);
    expect(migrated.connection.prepare("SELECT count(*) AS n FROM source_host_inventories").get()).toEqual({ n: 0 });
    expect(migrated.connection.prepare("SELECT name FROM sqlite_master WHERE name='source_spans_reject_erased_insert'").get())
      .toEqual({ name: "source_spans_reject_erased_insert" });
  });

  it("retains explicit source representations and ordered lineage across SQLite close and reopen without upgrading historical claims", () => {
    const database = openRepresentationFixture();
    const records = new SqliteFieldSourceRecordRepo(database, fieldSha256);
    const excerpt = records.insert(sourceRow("excerpt", " exact raw bytes 🙂\n", { kind: "retained_excerpt" }));
    const original = records.insert(sourceRow("original", "Complete original document", { kind: "original_body" }));
    const projection = records.insert(sourceRow("projection", "canonical text", { kind: "canonical_projection",
      source_record_ids: [original.record_id, excerpt.record_id] }));
    const legacy = records.insert(sourceRow("historical", "legacy text"));
    database.close({ optimize: false });
    harness.untrackStorage(database);

    const reopened = harness.trackStorage(initDatabase({ filename: database.filename }));
    const reader = new SqliteFieldSourceRecordRepo(reopened, fieldSha256);
    for (const row of [excerpt, original, projection, legacy]) {
      expect(reader.findById(row.workspace_id, row.record_id)).toEqual(row);
      expect(sourceRecordFromRow(reader.findById(row.workspace_id, row.record_id)!)).toMatchObject({ identity: row.record_id });
    }
    expect(reader.findById(legacy.workspace_id, legacy.record_id)).not.toHaveProperty("source_representation");
    const roots = new SqliteSourceRootRecallReader(reader, new SqliteEvidenceCapsuleRepo(reopened));
    expect(roots.load("workspace-1", sourceTarget(projection)).row).toMatchObject({
      source_representation: projection.source_representation,
      original_complete: false, content_complete: true, retained_extent: "body", content: "canonical text"
    });
    expect(roots.load("workspace-1", sourceTarget(original)).row?.original_complete).toBe(true);
    expect(roots.load("workspace-1", sourceTarget(excerpt)).row?.original_complete).toBe(false);
    expect(roots.load("workspace-1", sourceTarget(legacy)).row?.original_complete).toBe(false);
    expect(() => reader.insert({ ...excerpt, source_representation: { kind: "original_body" } })).toThrow();
  });

  it.each(["erased", "superseded"] as const)("withdraws every full and bounded projection body after an origin is %s", mode => {
    const database = openRepresentationFixture();
    const records = new SqliteFieldSourceRecordRepo(database, fieldSha256);
    const origin = records.insert(sourceRow("raw", "raw retained body", { kind: "retained_excerpt" }));
    const projection = records.insert(sourceRow("projection", "derived body", { kind: "canonical_projection", source_record_ids: [origin.record_id] }));
    const before = database.connection.prepare("SELECT * FROM source_records WHERE record_id = ?").get(projection.record_id);
    if (mode === "erased") {
      new SqliteFieldEraseBarrierRepo(database, fieldSha256).apply({
        identity: hashLabeledIdentity("erase_barrier", ["workspace-1", "source_record", origin.record_id, ""], fieldSha256),
        barrier_id: "erase-projection-origin", workspace_id: "workspace-1", generation_id: null,
        subject_kind: "source_record", subject_id: origin.record_id, erased_at: "2026-09-22T01:00Z"
      });
    } else {
      records.insert({ ...sourceRow("raw", "new current raw body", { kind: "retained_excerpt" }), recorded_at: "2026-09-22T01:00Z" });
    }
    expect(records.findById("workspace-1", projection.record_id)?.source_body).toBeNull();
    expect(records.findCurrent("workspace-1", "projection")?.source_body).toBeNull();
    expect(records.listByWorkspace("workspace-1").find(row => row.record_id === projection.record_id)?.source_body).toBeNull();
    expect(records.listPage("workspace-1", { limit: 8 }).rows.some(row => row.record_id === projection.record_id)).toBe(false);
    expect(records.findByIdBounded("workspace-1", projection.record_id, 1, 0)).toMatchObject({ record: { source_body: null }, bodyBytes: 0 });
    expect(records.findCurrentBounded("workspace-1", "projection")?.record?.source_body).toBeNull();
    expect(records.listPageBounded("workspace-1", { limit: 8 }, 1).rows
      .find(row => row.record?.record_id === projection.record_id)?.record?.source_body).toBeNull();
    const roots = new SqliteSourceRootRecallReader(records, new SqliteEvidenceCapsuleRepo(database));
    expect(roots.load("workspace-1", sourceTarget(projection))).toMatchObject({ row: null, unavailable: true });
    expect(roots.page({ workspaceId: "workspace-1", limit: 8, nativeLimit: 8, afterCursor: null }).rows
      .some(row => row.root_id === projection.record_id)).toBe(false);
    const stored = database.connection.prepare("SELECT * FROM source_records WHERE record_id = ?").get(projection.record_id);
    if (mode === "erased") expect(stored).toMatchObject({ source_body: null, retained_content_bytes: null });
    else expect(stored).toEqual(before);
  });

  it("reserves and charges metadata-only dependency reads before exposing any projection bytes", () => {
    const database = openRepresentationFixture();
    const records = new SqliteFieldSourceRecordRepo(database, fieldSha256);
    const origin = records.insert(sourceRow("raw", "raw ".repeat(100_000), { kind: "retained_excerpt" }));
    const projection = records.insert(sourceRow("projection", "derived body", { kind: "canonical_projection", source_record_ids: [origin.record_id] }));
    const prepare = vi.spyOn(database.connection, "prepare");
    const limited = records.findByIdBounded("workspace-1", projection.record_id, 1, 0, { workLimit: 5, nativeByteLimit: 65536 });
    expect(limited).toMatchObject({ resourceLimited: true, record: { source_body: null }, dependencyWork: 0 });
    expect(prepare.mock.calls.some(([sql]) => sql.includes("FROM source_records origin"))).toBe(false);
    const read = records.findByIdBounded("workspace-1", projection.record_id, 1, 0, { workLimit: 7, nativeByteLimit: 65536 })!;
    expect(read).toMatchObject({ record: { source_body: "d" }, dependencyWork: 2 });
    expect(read.nativeBytes + read.metadataBytes).toBeLessThan(4096);
    expect(prepare.mock.calls.filter(([sql]) => sql.includes("FROM source_records origin"))).toHaveLength(1);
    const roots = new SqliteSourceRootRecallReader(records, new SqliteEvidenceCapsuleRepo(database));
    expect(roots.hydrate("workspace-1", sourceTarget(projection), 1, 0, 65536, 5)).toMatchObject({ row: null, resourceLimited: true, unavailable: false });
    expect(roots.hydrate("workspace-1", sourceTarget(projection), 1, 0, 65536, 7)).toMatchObject({ nativeWork: 7, row: { content: "d" } });
  });

  it("preserves the complete literal stream cursor when projection dependency work must be retried", () => {
    const database = openRepresentationFixture();
    const records = new SqliteFieldSourceRecordRepo(database, fieldSha256);
    const origin = records.insert(sourceRow("raw", "raw retained body", { kind: "retained_excerpt" }));
    const projection = records.insert(sourceRow("projection", "derived body", { kind: "canonical_projection", source_record_ids: [origin.record_id] }));
    const roots = new SqliteSourceRootRecallReader(records, new SqliteEvidenceCapsuleRepo(database));
    const collectionCursor = `r:${projection.recorded_at}\t${projection.record_id}`;
    const cursor = `o:${JSON.stringify({ kind: "source_record", rootId: projection.record_id,
      revision: projection.source_version, digest: projection.content_digest, offset: 3, tail: "r",
      literals: [{ offset: 2, found: false }], afterCursor: collectionCursor,
      pending: [{ kind: "source_record", rootId: origin.record_id, revision: origin.source_version,
        digest: origin.content_digest, offset: 2, tail: "a", literals: [{ offset: 1, found: false }] }] })}`;
    const input = { workspaceId: "workspace-1", limit: 1, nativeLimit: 1, afterCursor: cursor, byteLimit: 9, nativeByteLimit: 65536 };
    const limited = roots.page({ ...input, workLimit: 5 });
    expect(limited).toMatchObject({ rows: [], resourceLimited: true, unavailable: false, truncated: true,
      committedThrough: cursor, nativeWork: 5, nativeBytes: 0 });
    const resumed = roots.page({ ...input, afterCursor: limited.committedThrough, workLimit: 7 });
    expect(resumed).toMatchObject({ committedThrough: collectionCursor, nativeWork: 7,
      rows: [{ root_id: projection.record_id, content: "ived body", content_start: 3, content_end: 12, content_complete: true }] });
    records.insert({ ...sourceRow("raw", "new current raw body", { kind: "retained_excerpt" }), recorded_at: "2026-09-22T01:00Z" });
    expect(roots.page({ ...input, workLimit: 7 })).toMatchObject({ rows: [], unavailable: true, truncated: true, committedThrough: cursor });
  });

  it("reads a sealed pre-representation schema as unknown and adds only nullable metadata on migration", () => {
    const directory = harness.createTempDir("alaya-legacy-source-representation-");
    const filename = join(directory, "legacy.sqlite");
    const connection = new BetterSqlite3(filename);
    const database = harness.trackStorage(new StorageDatabase(filename, connection));
    applyBaselineSql(connection, 19);
    seedWorkspaces(database);
    const records = new SqliteFieldSourceRecordRepo(database, fieldSha256);
    const row = sourceRow("legacy", "unchanged text");
    expect(() => records.insert(row)).toThrow(/current host-capable/);
    connection.prepare(`INSERT INTO source_records (record_id, workspace_id, source_id, source_version,
      content_digest, evidence_object_id, recorded_at, event_time, valid_from, valid_to, operator_id, speaker,
      scope_class, attribution_context_json, source_body, retained_content_bytes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.record_id, row.workspace_id, row.source_id, row.source_version, row.content_digest, row.evidence_object_id,
        row.recorded_at, row.event_time, row.valid_from, row.valid_to, row.operator_id, row.speaker, row.scope_class,
        JSON.stringify(row.attribution_context), row.source_body, Buffer.byteLength(row.source_body!));
    writeRetainedSourceChunks(database, { workspaceId: row.workspace_id, kind: "source_record", rootId: row.record_id,
      revision: row.source_version, digest: row.content_digest }, row.source_body!);
    const before = connection.prepare("SELECT * FROM source_records").all();
    connection.pragma("query_only = ON");
    expect(new SqliteFieldSourceRecordRepo(database, fieldSha256).findByIdBounded("workspace-1", row.record_id, 4096, 0)?.record).toEqual(row);
    expect(connection.prepare("SELECT * FROM source_records").all()).toEqual(before);
    connection.pragma("query_only = OFF");
    connection.exec(readFileSync(new URL("../../migrations/020-source-record-representation.sql", import.meta.url), "utf8"));
    expect(new SqliteFieldSourceRecordRepo(database, fieldSha256).findById("workspace-1", row.record_id)).toEqual(row);
    expect(connection.prepare("SELECT source_representation_json FROM source_records").get()).toEqual({ source_representation_json: null });
  });
});

describe("projection generation copy and pointer switch", () => {
  it("does not activate mixed or unverified generations on a copied store", async () => {
    const root = harness.createTempDir("alaya-generation-copy-");
    const filename = join(root, "field.sqlite");
    const original = harness.trackStorage(initDatabase({ filename }));
    seedWorkspaces(original);
    const records = new SqliteFieldSourceRecordRepo(original, fieldSha256);
    const generations = new SqliteFieldProjectionGenerationRepo(original, fieldSha256);
    const events = new SqliteEventLogRepo(original);
    const record = records.insert(hashedRecord("workspace-1", "immutable source body"));
    const retained = events.append({
      event_type: "soul.field.source_record.admitted",
      entity_type: "source_record",
      entity_id: record.record_id,
      workspace_id: "workspace-1",
      run_id: null,
      caused_by: "test",
      payload_json: { record_id: record.record_id }
    });
    if (retained instanceof Promise) throw new Error("event log append must stay synchronous in this copy probe");
    const shadow = generations.insert(hashedGeneration("workspace-1", "event-1", "shadow"));
    const second = generations.insert(hashedGeneration("workspace-1", "event-2", "shadow"));
    expect(readSchemaMigrationLedger(filename).at(-1)).toBe(currentSchemaVersion());
    expect(readSchemaMigrationLedger(filename)).toContain(13);
    original.close({ optimize: false });
    harness.untrackStorage(original);

    const copy = join(root, "field-copy.sqlite");
    copyFileSync(filename, copy);
    for (const suffix of ["-wal", "-shm"] as const) {
      if (existsSync(`${filename}${suffix}`)) copyFileSync(`${filename}${suffix}`, `${copy}${suffix}`);
    }
    const copied = harness.trackStorage(initDatabase({ filename: copy }));
    const copiedGenerations = new SqliteFieldProjectionGenerationRepo(copied, fieldSha256);
    const copiedRecords = new SqliteFieldSourceRecordRepo(copied, fieldSha256);
    const copiedEvents = new SqliteEventLogRepo(copied);

    expect(copiedRecords.findById("workspace-1", record.record_id)?.source_body).toBe("immutable source body");
    const copiedHistory = await copiedEvents.queryByEntity("source_record", record.record_id);
    expect(copiedHistory.some((row) => row.event_id === retained.event_id)).toBe(true);
    expect(() => copiedGenerations.readByGenerationIds("workspace-1", [shadow.generation_id, second.generation_id]))
      .toThrow(/mixed generation/u);
    expect(() => copiedGenerations.activatePointer({
      workspace_id: "workspace-1", active_generation_id: shadow.generation_id, activated_at: CLOCK
    })).toThrow(/verified/u);
    copiedGenerations.persistStatus("workspace-1", shadow.generation_id, "verified");
    const pointer = copiedGenerations.activatePointer({
      workspace_id: "workspace-1", active_generation_id: shadow.generation_id, activated_at: CLOCK
    });
    expect(pointer.active_generation_id).toBe(shadow.generation_id);
    expect(copiedGenerations.readActive("workspace-1")?.status).toBe("active");

    const rereadOriginal = harness.trackStorage(initDatabase({ filename }));
    const originalGenerations = new SqliteFieldProjectionGenerationRepo(rereadOriginal, fieldSha256);
    expect(originalGenerations.readActive("workspace-1")).toBeNull();
    expect(originalGenerations.readPinned("workspace-1", shadow.generation_id)?.status).toBe("shadow");
  });
});

function openVersion8Incidences(): BetterSqlite3.Database {
  const database = harness.trackRaw(new BetterSqlite3(":memory:"));
  database.pragma("foreign_keys = ON");
  applyBaselineSql(database, 8);
  seedWorkspaceRow(database, "workspace-1");
  const record = hashedRecord("workspace-1", "body");
  database.prepare(`
    INSERT INTO source_records (
      workspace_id, record_id, source_id, source_version, content_digest,
      evidence_object_id, recorded_at, event_time, valid_from, valid_to, operator_id, source_body
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(record.workspace_id, record.record_id, record.source_id, record.source_version, record.content_digest,
    record.evidence_object_id, record.recorded_at, record.event_time, record.valid_from, record.valid_to,
    record.operator_id, record.source_body);
  const span = hashedSpan("workspace-1", record.record_id);
  database.prepare(`
    INSERT INTO source_spans (
      workspace_id, span_id, record_id, start_offset, end_offset, purpose, producer_version, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(span.workspace_id, span.span_id, span.record_id, span.start_offset, span.end_offset,
    span.purpose, span.producer_version, span.recorded_at);
  const factor = hashedFactor("workspace-1", "token");
  database.prepare(`
    INSERT INTO factor_descriptors (
      workspace_id, factor_id, family, canonical_payload, operator_id, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(factor.workspace_id, factor.factor_id, factor.family, factor.canonical_payload, factor.operator_id, factor.recorded_at);
  for (const scope of ["workspace-1", "scope-b", "scope-c"] as const) {
    const incidence = hashedIncidence("workspace-1", span.span_id, factor.factor_id, scope);
    database.prepare(`
      INSERT INTO factor_incidences (
        workspace_id, incidence_id, span_id, factor_id, scope, operator_id, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(incidence.workspace_id, incidence.incidence_id, incidence.span_id,
      incidence.factor_id, incidence.scope, incidence.operator_id, incidence.recorded_at);
  }
  return database;
}

function explain(database: Pick<BetterSqlite3.Database, "prepare">, sql: string, params: readonly unknown[]): string {
  const rows = database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as ReadonlyArray<{ readonly detail: string }>;
  return rows.map((row) => row.detail).join("\n");
}

function assertCompactCatalog(database: Pick<BetterSqlite3.Database, "prepare">): void {
  const extraIndex = database.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_factor_incidences_workspace'").get();
  const table = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'factor_incidences'")
    .get() as { readonly sql: string } | undefined;
  expect(extraIndex).toBeUndefined();
  expect(table?.sql).toMatch(/WITHOUT ROWID/i);
}

function insertLegacyV17Record(
  database: StorageDatabase,
  row: ReturnType<typeof hashedRecord> & { recorded_at: string }
) {
  database.connection.prepare(`INSERT INTO source_records(
    record_id, workspace_id, source_id, source_version, content_digest,
    evidence_object_id, recorded_at, event_time, valid_from, valid_to,
    operator_id, speaker, scope_class, source_body)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    row.record_id, row.workspace_id, row.source_id, row.source_version, row.content_digest,
    row.evidence_object_id, row.recorded_at, row.event_time, row.valid_from, row.valid_to,
    row.operator_id, row.speaker, row.scope_class, row.source_body);
  return row;
}

function openRepresentationFixture() {
  const filename = join(harness.createTempDir("alaya-source-representation-"), "source.sqlite");
  const database = harness.trackStorage(initDatabase({ filename }));
  seedWorkspaces(database);
  return database;
}

function sourceRow(id: string, body: string, source_representation?: SourceRepresentation) {
  const row = { ...hashedRecord("workspace-1", body, id), speaker: "user" as const, scope_class: "project" as const,
    ...(source_representation === undefined ? {} : { source_representation }) };
  return { ...row, record_id: hashSourceRecordId(row, fieldSha256) };
}

function sourceTarget(row: FieldSourceRecordRow) {
  return sourceRecallTarget({ workspace_id: row.workspace_id, root_kind: "source_record", root_id: row.record_id,
    source_version: row.source_version, content_digest: row.content_digest, evidence_object_id: null });
}
