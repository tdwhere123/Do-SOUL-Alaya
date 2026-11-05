import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashLabeledIdentity, sourceRecallTarget, SourceInterpretationInvalidatedPayloadSchema } from "@do-soul/alaya-protocol";
import { initDatabase, type StorageDatabase } from "../../../../../sqlite/db.js";
import { SqliteFieldEraseBarrierRepo, SqliteFieldSourceRecordRepo } from "../../../../../repos/field/index.js";
import { CLOCK, fieldSha256, hashedRecord, seedWorkspaces } from "../../field-contract-fixture.js";

const databases = new Set<StorageDatabase>(), directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases) database.close();
  databases.clear();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function open(filename: string) {
  const database = initDatabase({ filename }); databases.add(database); return database;
}
function fixture(count = 70) {
  const directory = mkdtempSync(join(tmpdir(), "erase-recovery-")); directories.push(directory);
  const filename = join(directory, "alaya.sqlite"), database = open(filename);
  seedWorkspaces(database, ["workspace-1"]);
  const records = new SqliteFieldSourceRecordRepo(database, fieldSha256);
  const ids = Array.from({ length: count }, (_, index) => records.insert(hashedRecord("workspace-1", `private-${index}`, `source-${index}`)).record_id);
  // Simulate committed historical barriers whose newly supported closure still needs repair.
  for (const [index, id] of ids.entries()) database.connection.prepare(`INSERT INTO projection_erase_barriers
    (workspace_id, barrier_id, receipt_identity, generation_id, subject_kind, subject_id, erased_at)
    VALUES ('workspace-1', ?, ?, NULL, 'source_record', ?, ?)`)
    .run(`barrier-${String(index).padStart(3, "0")}`, hashLabeledIdentity("erase_barrier", ["workspace-1", "source_record", id, ""], fieldSha256), id, CLOCK);
  return { filename, database, ids };
}
function progress(database: StorageDatabase) {
  return database.connection.prepare("SELECT * FROM source_erase_closure_progress ORDER BY barrier_id")
    .all() as { barrier_id: string; data_revision: number; checked_revision: number; rule_version: number; dirty: number }[];
}
function remaining(database: StorageDatabase): number {
  return (database.connection.prepare("SELECT COUNT(*) AS n FROM source_records WHERE source_body IS NOT NULL").get() as { n: number }).n;
}

function legacyInterpretation(database: StorageDatabase, rootId: string, generic = false): void {
  const root = new SqliteFieldSourceRecordRepo(database, fieldSha256).findById("workspace-1", rootId)!;
  const gist = JSON.stringify({ contract: "published-source-interpretation-v4", broken: true,
    source_target: sourceRecallTarget({ workspace_id: "workspace-1", root_kind: "source_record", root_id: rootId,
      source_version: root.source_version, content_digest: root.content_digest, evidence_object_id: null }) });
  database.connection.prepare(`INSERT INTO evidence_capsules
    (object_id, object_kind, schema_version, lifecycle_state, created_at, updated_at, created_by, evidence_kind,
      semantic_anchor, evidence_health_state, gist, workspace_id, run_id)
    VALUES ('legacy-capsule', 'evidence_capsule', 1, 'active', ?, ?, 'test', 'conversation_excerpt',
      '{"topic":"private","keywords":[],"summary":"private"}', 'questionable', ?, 'workspace-1', 'run-1')`)
    .run(CLOCK, CLOCK, generic ? "legacy private copy" : gist);
}

function capsule(database: StorageDatabase) {
  return database.connection.prepare("SELECT gist, lifecycle_state FROM evidence_capsules WHERE object_id = 'legacy-capsule'").get();
}

it("commits bounded scrub batches with their cursor, rolls back an interrupted batch, and resumes after reopen", () => {
  const { filename, database } = fixture();
  const erase = new SqliteFieldEraseBarrierRepo(database, fieldSha256);
  const apply = vi.spyOn(erase, "apply");
  expect(erase.repairSourceClosureBatch()).toBe(true);
  expect(apply).toHaveBeenCalledTimes(32);
  expect(remaining(database)).toBe(38);
  const checkpoint = progress(database);
  expect(checkpoint.filter(row => row.dirty === 0)).toHaveLength(32);
  expect(checkpoint[31]).toMatchObject({ barrier_id: "barrier-031", dirty: 0, rule_version: 1 });
  database.connection.exec(`CREATE TRIGGER interrupt_erase BEFORE UPDATE OF source_body ON source_records
    WHEN OLD.source_id = 'source-35' BEGIN SELECT RAISE(ABORT, 'interrupted scrub'); END`);
  expect(() => erase.repairSourceClosureBatch()).toThrow();
  expect(progress(database)).toEqual(checkpoint);
  expect(database.connection.prepare("SELECT repairing FROM source_erase_repair_control").get()).toEqual({ repairing: 0 });
  expect(remaining(database)).toBe(38);
  database.connection.exec("DROP TRIGGER interrupt_erase");
  database.close(); databases.delete(database);
  const reopened = open(filename), resumed = new SqliteFieldEraseBarrierRepo(reopened, fieldSha256);
  const replay = vi.spyOn(resumed, "apply");
  resumed.repairExistingSourceClosures();
  expect(replay).toHaveBeenCalledTimes(38);
  expect(replay.mock.calls[0]![0].barrier_id).toBe("barrier-032");
  expect(remaining(reopened)).toBe(0);
  expect(progress(reopened).every(row => row.rule_version === 1 && row.dirty === 0)).toBe(true);
  replay.mockClear();
  resumed.repairExistingSourceClosures();
  expect(replay).not.toHaveBeenCalled();
  const plan = reopened.connection.prepare(`EXPLAIN QUERY PLAN SELECT barrier_id FROM source_erase_closure_progress
    WHERE dirty = 1 ORDER BY workspace_id, barrier_id LIMIT 32`).all();
  expect(JSON.stringify(plan)).toContain("idx_source_erase_recovery_dirty");
});

it("skips clean history on a second startup but invalidates a checkpoint for changed data or an older rule", () => {
  const { filename, database, ids } = fixture(3);
  new SqliteFieldEraseBarrierRepo(database, fieldSha256).repairExistingSourceClosures();
  database.close(); databases.delete(database);
  const reopened = open(filename), erase = new SqliteFieldEraseBarrierRepo(reopened, fieldSha256);
  const apply = vi.spyOn(erase, "apply");
  erase.repairExistingSourceClosures();
  expect(apply).not.toHaveBeenCalled();
  new SqliteFieldSourceRecordRepo(reopened, fieldSha256).insert(hashedRecord("workspace-1", "independent source", "new-source"));
  erase.repairExistingSourceClosures();
  expect(apply).not.toHaveBeenCalled();
  legacyInterpretation(reopened, ids[0]!);
  expect(progress(reopened).filter(row => row.dirty === 1).map(row => row.barrier_id)).toEqual(["barrier-000"]);
  erase.repairExistingSourceClosures();
  expect(capsule(reopened)).toEqual({ gist: "erased", lifecycle_state: "tombstone" });
  expect(apply).toHaveBeenCalledTimes(1);
  apply.mockClear();
  reopened.connection.prepare("UPDATE source_erase_closure_progress SET rule_version = 0").run();
  erase.repairExistingSourceClosures();
  expect(apply).toHaveBeenCalledTimes(3);
  expect(progress(reopened).every(row => row.rule_version === 1 && row.dirty === 0)).toBe(true);
});

it("repairs only the dirtied receipt plus unfinished receipts when another connection adds attribution between batches", () => {
  const { filename, database, ids } = fixture(40);
  const erase = new SqliteFieldEraseBarrierRepo(database, fieldSha256);
  erase.repairSourceClosureBatch();
  database.close(); databases.delete(database);
  const writer = open(filename);
  legacyInterpretation(writer, ids[0]!);
  const resumed = new SqliteFieldEraseBarrierRepo(writer, fieldSha256), apply = vi.spyOn(resumed, "apply");
  resumed.repairExistingSourceClosures();
  expect(apply).toHaveBeenCalledTimes(9);
  expect(apply.mock.calls.at(-1)![0].barrier_id).toBe("barrier-000");
  expect(capsule(writer)).toEqual({ gist: "erased", lifecycle_state: "tombstone" });
  expect(remaining(writer)).toBe(0);
});

it.each(["record binding", "invalidation audit"] as const)("repairs a late capsule attributed only by an older %s", binding => {
  const { database, ids } = fixture(3);
  const erase = new SqliteFieldEraseBarrierRepo(database, fieldSha256);
  if (binding === "record binding") {
    database.connection.prepare("UPDATE source_records SET evidence_object_id = 'legacy-capsule' WHERE record_id = ?").run(ids[0]);
  } else {
    const root = new SqliteFieldSourceRecordRepo(database, fieldSha256).findById("workspace-1", ids[0]!)!;
    const payload = SourceInterpretationInvalidatedPayloadSchema.parse({ workspace_id: "workspace-1", run_id: "run-1",
      source_interpretation_id: `sha256:${"a".repeat(64)}`, source: { source_id: root.source_id,
        source_version: root.source_version, content_digest: root.content_digest },
      error_basis: { reason: "legacy invalidation" }, provenance: { reporter_id: "test" }, authorized_scopes: { mode: "unrestricted" },
      evidence_object_id: "legacy-capsule", from_state: "active", to_state: "archived", semantic_status: "unreviewed", occurred_at: CLOCK });
    database.connection.prepare(`INSERT INTO event_log(event_id, event_type, entity_type, entity_id, workspace_id, payload_json, created_at)
      VALUES ('legacy-invalidation', 'source.interpretation.invalidated', 'evidence_capsule', 'legacy-capsule', 'workspace-1', ?, ?)`)
      .run(JSON.stringify(payload), CLOCK);
  }
  erase.repairExistingSourceClosures();
  expect(progress(database).every(row => row.dirty === 0)).toBe(true);
  const apply = vi.spyOn(erase, "apply");
  legacyInterpretation(database, ids[0]!, true);
  expect(progress(database).filter(row => row.dirty === 1).map(row => row.barrier_id)).toEqual(["barrier-000"]);
  erase.repairExistingSourceClosures();
  expect(apply).toHaveBeenCalledTimes(1);
  expect(capsule(database)).toEqual({ gist: "erased", lifecycle_state: "tombstone" });
});
