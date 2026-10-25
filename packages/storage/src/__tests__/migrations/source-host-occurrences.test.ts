import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { expect, it } from "vitest";
import { canonicalJson } from "@do-soul/alaya-protocol";
import { initDatabase, closeCachedDatabase, StorageDatabase } from "../../sqlite/db.js";
import { SqliteFieldSourceRecordRepo, SqliteFieldSourceSpanRepo } from "../../repos/field/source-repo.js";
import { SqliteFieldFactorRepo } from "../../repos/field/factor-repo.js";
import { migrateLegacyPathRelationsToTemporalCandidate } from "../../sqlite/temporal-cutover-gate.js";
import { migrateVerifiedProjectionBindKey } from "../../sqlite/temporal-verified-bind-key.js";
import { applyBaselineSql } from "./apply-baseline.js";
import { fieldSha256, hashedRecord, hashedSpan, hashedFactor, hashedIncidence, seedWorkspaces } from "../repos/field/field-contract-fixture.js";

it("migrates populated spans without cascading incidences, preserving unknown metadata and the erase guard", () => {
  const directory = mkdtempSync(join(tmpdir(), "source-host-migration-")), filename = join(directory, "source.sqlite");
  const seed = new StorageDatabase(filename, new BetterSqlite3(filename));
  try {
    applyBaselineSql(seed.connection, 23);
    migrateLegacyPathRelationsToTemporalCandidate(seed.connection, { selectionRequired: false });
    migrateVerifiedProjectionBindKey(seed.connection);
    seed.connection.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    for (let version = 1; version <= 23; version++) seed.connection.prepare("INSERT INTO schema_version VALUES (?, ?)").run(version, "2026-09-13T00:00:00Z");
    seedWorkspaces(seed);
    const records = new SqliteFieldSourceRecordRepo(seed, fieldSha256), spans = new SqliteFieldSourceSpanRepo(seed, fieldSha256);
    const factors = new SqliteFieldFactorRepo(seed, fieldSha256);
    const record = hashedRecord("workspace-1", "retained body");
    expect(() => records.insert(record)).toThrow(/current host-capable/);
    seed.connection.prepare(`INSERT INTO source_records (workspace_id, record_id, source_id, source_version,
      content_digest, evidence_object_id, recorded_at, event_time, valid_from, valid_to, operator_id, speaker,
      scope_class, attribution_context_json, source_body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.workspace_id, record.record_id, record.source_id, record.source_version, record.content_digest,
        record.evidence_object_id, record.recorded_at, record.event_time, record.valid_from, record.valid_to,
        record.operator_id, record.speaker, record.scope_class, canonicalJson(record.attribution_context), record.source_body);
    const span = spans.insert(hashedSpan("workspace-1", record.record_id, 0, 5));
    const factor = factors.insertDescriptor(hashedFactor("workspace-1", "retained"));
    const incidence = factors.insertIncidence(hashedIncidence("workspace-1", span.span_id, factor.factor_id, "claim"));
    seed.close({ optimize: false });
    const migrated = initDatabase({ filename });
    try {
      expect(new SqliteFieldSourceRecordRepo(migrated, fieldSha256).findById("workspace-1", record.record_id)).toEqual(record);
      expect(new SqliteFieldSourceSpanRepo(migrated, fieldSha256).findById("workspace-1", span.span_id)).toEqual(span);
      expect(new SqliteFieldFactorRepo(migrated, fieldSha256).findIncidence("workspace-1", incidence.incidence_id)).toEqual(incidence);
      expect(migrated.connection.pragma("foreign_key_check")).toEqual([]);
      expect(migrated.connection.prepare("SELECT count(*) AS n FROM source_host_inventories").get()).toEqual({ n: 0 });
      expect(migrated.connection.prepare("SELECT name FROM sqlite_master WHERE name='source_spans_reject_erased_insert'").get())
        .toEqual({ name: "source_spans_reject_erased_insert" });
    } finally { migrated.close({ optimize: false }); closeCachedDatabase(filename); }
  } finally { seed.close({ optimize: false }); rmSync(directory, { recursive: true, force: true }); }
});
