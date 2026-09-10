import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { StorageDatabase, initDatabase } from "../../sqlite/db.js";
import { migrateLegacyPathRelationsToTemporalCandidate } from "../../sqlite/temporal-cutover-gate.js";
import { SqliteEvidenceCapsuleRepo } from "../../repos/capsules/evidence-capsule-repo.js";
import { SqliteFieldSourceRecordRepo } from "../../repos/field/source-repo.js";
import { SqliteSourceRootRecallReader } from "../../repos/field/bounded-source-root-reader.js";
import { fieldSha256, hashedRecord, seedWorkspaces } from "../repos/field/field-contract-fixture.js";
import { applyBaselineSql, insertEvidenceCapsule } from "./apply-baseline.js";

const directories: string[] = [];
const databases: StorageDatabase[] = [];
afterEach(() => { databases.forEach((database) => database.close()); directories.forEach((directory) => rmSync(directory, { recursive: true, force: true }));
  databases.length = 0; directories.length = 0; });

describe("retained source representation migration", () => {
  it("prepares both canonical root kinds on upgrade from 12 and reads them after a read-only restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "alaya-chunk-upgrade-"));
    directories.push(directory);
    const filename = join(directory, "source.sqlite");
    const old = new StorageDatabase(filename, new BetterSqlite3(filename));
    applyBaselineSql(old.connection, 12);
    migrateLegacyPathRelationsToTemporalCandidate(old.connection, { selectionRequired: false });
    old.connection.exec("CREATE TABLE schema_version(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    for (let version = 1; version <= 12; version += 1) old.connection.prepare("INSERT INTO schema_version VALUES (?, ?)").run(version, "2026-09-01T00:00:00.000Z");
    seedWorkspaces(old);
    const record = hashedRecord("workspace-1", "original😀 retained", "migration-record");
    old.connection.prepare(`INSERT INTO source_records(record_id,workspace_id,source_id,source_version,content_digest,
      evidence_object_id,recorded_at,event_time,valid_from,valid_to,operator_id,speaker,scope_class,source_body)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(record.record_id, record.workspace_id, record.source_id, record.source_version,
      record.content_digest, null, record.recorded_at, null, null, null, record.operator_id, null, null, record.source_body);
    insertEvidenceCapsule(old.connection, "capsule-migration", { gist: "gist", excerpt: "capsule😀 retained" });
    old.close();
    const migrated = initDatabase({ filename });
    expect(migrated.connection.prepare("SELECT MAX(version) AS version FROM schema_version").get()).toEqual({ version: 13 });
    expect(migrated.connection.prepare("SELECT COUNT(*) AS count FROM retained_source_chunks").get()).toEqual({ count: 2 });
    migrated.close();
    const readonly = new StorageDatabase(filename, new BetterSqlite3(filename, { readonly: true }));
    databases.push(readonly);
    readonly.connection.pragma("query_only = ON");
    const reader = new SqliteSourceRootRecallReader(new SqliteFieldSourceRecordRepo(readonly, fieldSha256), new SqliteEvidenceCapsuleRepo(readonly));
    const page = reader.page({ workspaceId: "workspace-1", limit: 8, nativeLimit: 8, afterCursor: null });
    expect(page.unavailable).toBe(false);
    expect(page.rows.map((row) => row.content)).toEqual(expect.arrayContaining(["original😀 retained", "capsule😀 retained"]));
    expect(readonly.connection.prepare("SELECT source_body FROM source_records WHERE record_id = ?").get(record.record_id))
      .toEqual({ source_body: "original😀 retained" });
  });
});
