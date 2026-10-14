import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { hashLabeledIdentity, hashSourceRecordId, sourceRecallTarget, type SourceRepresentation } from "@do-soul/alaya-protocol";
import { initDatabase, StorageDatabase } from "../../sqlite/db.js";
import { SqliteFieldSourceRecordRepo } from "../../repos/field/source-repo.js";
import { SqliteSourceRootRecallReader } from "../../repos/field/bounded-source-root-reader.js";
import { SqliteEvidenceCapsuleRepo } from "../../repos/capsules/evidence-capsule-repo.js";
import { SqliteFieldEraseBarrierRepo } from "../../repos/field/erase-repo.js";
import { sourceRecordFromRow } from "../../repos/field/mappers/field-receipts.js";
import type { FieldSourceRecordRow } from "../../repos/field/ports.js";
import { fieldSha256, hashedRecord, seedWorkspaces } from "../repos/field/field-contract-fixture.js";
import { applyBaselineSql } from "./apply-baseline.js";

const databases: StorageDatabase[] = [], directories: string[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close({ optimize: false });
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "alaya-source-representation-")); directories.push(directory);
  const database = initDatabase({ filename: join(directory, "source.sqlite") }); databases.push(database); seedWorkspaces(database);
  return database;
}
function source(id: string, body: string, source_representation?: SourceRepresentation) {
  const row = { ...hashedRecord("workspace-1", body, id), speaker: "user" as const, scope_class: "project" as const,
    ...(source_representation === undefined ? {} : { source_representation }) };
  return { ...row, record_id: hashSourceRecordId(row, fieldSha256) };
}
function target(row: FieldSourceRecordRow) {
  return sourceRecallTarget({ workspace_id: row.workspace_id, root_kind: "source_record", root_id: row.record_id,
    source_version: row.source_version, content_digest: row.content_digest, evidence_object_id: null });
}

it("retains explicit source representations and ordered lineage across SQLite close and reopen without upgrading historical claims", () => {
  const database = fixture(), records = new SqliteFieldSourceRecordRepo(database, fieldSha256);
  const excerpt = records.insert(source("excerpt", " exact raw bytes 🙂\n", { kind: "retained_excerpt" }));
  const original = records.insert(source("original", "Complete original document", { kind: "original_body" }));
  const projection = records.insert(source("projection", "canonical text", { kind: "canonical_projection",
    source_record_ids: [original.record_id, excerpt.record_id] }));
  const legacy = records.insert(source("historical", "legacy text"));
  database.close({ optimize: false });
  const reopened = initDatabase({ filename: database.filename }); databases.push(reopened);
  const reader = new SqliteFieldSourceRecordRepo(reopened, fieldSha256);
  for (const row of [excerpt, original, projection, legacy]) {
    expect(reader.findById(row.workspace_id, row.record_id)).toEqual(row);
    expect(sourceRecordFromRow(reader.findById(row.workspace_id, row.record_id)!)).toMatchObject({ identity: row.record_id });
  }
  expect(reader.findById(legacy.workspace_id, legacy.record_id)).not.toHaveProperty("source_representation");
  const roots = new SqliteSourceRootRecallReader(reader, new SqliteEvidenceCapsuleRepo(reopened));
  expect(roots.load("workspace-1", target(projection)).row).toMatchObject({ source_representation: projection.source_representation,
    original_complete: false, content_complete: true, retained_extent: "body", content: "canonical text" });
  expect(roots.load("workspace-1", target(original)).row?.original_complete).toBe(true);
  expect(roots.load("workspace-1", target(excerpt)).row?.original_complete).toBe(false);
  expect(roots.load("workspace-1", target(legacy)).row?.original_complete).toBe(false);
  expect(() => reader.insert({ ...excerpt, source_representation: { kind: "original_body" } })).toThrow();
});

it.each(["erased", "superseded"] as const)("withdraws every full and bounded projection body after an origin is %s", mode => {
  const database = fixture(), records = new SqliteFieldSourceRecordRepo(database, fieldSha256);
  const origin = records.insert(source("raw", "raw retained body", { kind: "retained_excerpt" }));
  const projection = records.insert(source("projection", "derived body", { kind: "canonical_projection", source_record_ids: [origin.record_id] }));
  const before = database.connection.prepare("SELECT * FROM source_records WHERE record_id = ?").get(projection.record_id);
  if (mode === "erased") new SqliteFieldEraseBarrierRepo(database, fieldSha256).apply({
    identity: hashLabeledIdentity("erase_barrier", ["workspace-1", "source_record", origin.record_id, ""], fieldSha256),
    barrier_id: "erase-projection-origin", workspace_id: "workspace-1", generation_id: null,
    subject_kind: "source_record", subject_id: origin.record_id, erased_at: "2026-09-22T01:00Z"
  });
  else records.insert({ ...source("raw", "new current raw body", { kind: "retained_excerpt" }), recorded_at: "2026-09-22T01:00Z" });
  expect(records.findById("workspace-1", projection.record_id)?.source_body).toBeNull();
  expect(records.findCurrent("workspace-1", "projection")?.source_body).toBeNull();
  expect(records.listByWorkspace("workspace-1").find(row => row.record_id === projection.record_id)?.source_body).toBeNull();
  expect(records.listPage("workspace-1", { limit: 8 }).rows.some(row => row.record_id === projection.record_id)).toBe(false);
  expect(records.findByIdBounded("workspace-1", projection.record_id, 1, 0)).toMatchObject({ record: { source_body: null }, bodyBytes: 0 });
  expect(records.findCurrentBounded("workspace-1", "projection")?.record?.source_body).toBeNull();
  expect(records.listPageBounded("workspace-1", { limit: 8 }, 1).rows
    .find(row => row.record?.record_id === projection.record_id)?.record?.source_body).toBeNull();
  const roots = new SqliteSourceRootRecallReader(records, new SqliteEvidenceCapsuleRepo(database));
  expect(roots.load("workspace-1", target(projection))).toMatchObject({ row: null, unavailable: true });
  expect(roots.page({ workspaceId: "workspace-1", limit: 8, nativeLimit: 8, afterCursor: null }).rows
    .some(row => row.root_id === projection.record_id)).toBe(false);
  const stored = database.connection.prepare("SELECT * FROM source_records WHERE record_id = ?").get(projection.record_id);
  if (mode === "erased") {
    expect(stored).toMatchObject({ source_body: null, retained_content_bytes: null });
  } else {
    expect(stored).toEqual(before);
  }
});

it("reserves and charges metadata-only dependency reads before exposing any projection bytes", () => {
  const database = fixture(), records = new SqliteFieldSourceRecordRepo(database, fieldSha256);
  const origin = records.insert(source("raw", "raw ".repeat(100_000), { kind: "retained_excerpt" }));
  const projection = records.insert(source("projection", "derived body", { kind: "canonical_projection", source_record_ids: [origin.record_id] }));
  const prepare = vi.spyOn(database.connection, "prepare");
  const limited = records.findByIdBounded("workspace-1", projection.record_id, 1, 0, { workLimit: 5, nativeByteLimit: 65536 });
  expect(limited).toMatchObject({ resourceLimited: true, record: { source_body: null }, dependencyWork: 0 });
  expect(prepare.mock.calls.some(([sql]) => sql.includes("FROM source_records origin"))).toBe(false);
  const read = records.findByIdBounded("workspace-1", projection.record_id, 1, 0, { workLimit: 7, nativeByteLimit: 65536 })!;
  expect(read).toMatchObject({ record: { source_body: "d" }, dependencyWork: 2 });
  expect(read.nativeBytes + read.metadataBytes).toBeLessThan(4096);
  expect(prepare.mock.calls.filter(([sql]) => sql.includes("FROM source_records origin"))).toHaveLength(1);
  const roots = new SqliteSourceRootRecallReader(records, new SqliteEvidenceCapsuleRepo(database));
  expect(roots.hydrate("workspace-1", target(projection), 1, 0, 65536, 5)).toMatchObject({ row: null, resourceLimited: true, unavailable: false });
  expect(roots.hydrate("workspace-1", target(projection), 1, 0, 65536, 7)).toMatchObject({ nativeWork: 7, row: { content: "d" } });
});

it("preserves the complete literal stream cursor when projection dependency work must be retried", () => {
  const database = fixture(), records = new SqliteFieldSourceRecordRepo(database, fieldSha256);
  const origin = records.insert(source("raw", "raw retained body", { kind: "retained_excerpt" }));
  const projection = records.insert(source("projection", "derived body", { kind: "canonical_projection", source_record_ids: [origin.record_id] }));
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
  records.insert({ ...source("raw", "new current raw body", { kind: "retained_excerpt" }), recorded_at: "2026-09-22T01:00Z" });
  expect(roots.page({ ...input, workLimit: 7 })).toMatchObject({ rows: [], unavailable: true,
    truncated: true, committedThrough: cursor });
});

it("reads a sealed pre-representation schema as unknown and adds only nullable metadata on migration", () => {
  const directory = mkdtempSync(join(tmpdir(), "alaya-legacy-source-representation-")); directories.push(directory);
  const filename = join(directory, "legacy.sqlite"), connection = new BetterSqlite3(filename);
  const database = new StorageDatabase(filename, connection); databases.push(database);
  applyBaselineSql(connection, 19); seedWorkspaces(database);
  const records = new SqliteFieldSourceRecordRepo(database, fieldSha256), row = records.insert(source("legacy", "unchanged text"));
  const before = connection.prepare("SELECT * FROM source_records").all();
  connection.pragma("query_only = ON");
  expect(new SqliteFieldSourceRecordRepo(database, fieldSha256).findByIdBounded("workspace-1", row.record_id, 4096, 0)?.record).toEqual(row);
  expect(connection.prepare("SELECT * FROM source_records").all()).toEqual(before);
  connection.pragma("query_only = OFF");
  connection.exec(readFileSync(new URL("../../migrations/020-source-record-representation.sql", import.meta.url), "utf8"));
  expect(new SqliteFieldSourceRecordRepo(database, fieldSha256).findById("workspace-1", row.record_id)).toEqual(row);
  expect(connection.prepare("SELECT source_representation_json FROM source_records").get()).toEqual({ source_representation_json: null });
});
