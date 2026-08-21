import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import {
  SqliteFieldFactorRepo,
  SqliteFieldSourceRecordRepo,
  SqliteFieldSourceSpanRepo
} from "../../repos/field/index.js";
import type { StorageDatabase } from "../../sqlite/db.js";
import {
  CLOCK,
  fieldSha256,
  hashedFactor,
  hashedIncidence,
  hashedRecord,
  hashedSpan,
  openFieldDatabase
} from "../repos/field/field-contract-fixture.js";
import { applyBaselineSql, seedWorkspaceRow } from "./apply-baseline.js";

const tracked = new Set<StorageDatabase>();
const trackedRaw = new Set<BetterSqlite3.Database>();

afterEach(() => {
  for (const database of tracked) database.close();
  tracked.clear();
  for (const database of trackedRaw) database.close();
  trackedRaw.clear();
});

const LIST_INCIDENCES_SQL = `
  SELECT incidence_id, span_id, factor_id, scope, operator_id, workspace_id, recorded_at
  FROM factor_incidences
  WHERE workspace_id = ?
  ORDER BY incidence_id
`;

const DELETE_INCIDENCE_SQL = `
  DELETE FROM factor_incidences WHERE workspace_id = ? AND incidence_id = ?
`;

const COMPACT_MIGRATION_SQL = fs.readFileSync(
  fileURLToPath(new URL("../../migrations/009-compact-factor-incidences.sql", import.meta.url)),
  "utf8"
);

describe("factor_incidences compact primary key", () => {
  it("lists and erases via the clustered WITHOUT ROWID primary key", () => {
    const database = openSeededIncidences();
    const listPlan = explain(database.connection, LIST_INCIDENCES_SQL, ["workspace-1"]);
    const deletePlan = explain(database.connection, DELETE_INCIDENCE_SQL, [
      "workspace-1",
      "missing-incidence"
    ]);
    const rows = database.connection.prepare(LIST_INCIDENCES_SQL).all("workspace-1") as ReadonlyArray<{
      readonly incidence_id: string;
    }>;

    expect(listPlan).toBe("SEARCH factor_incidences USING PRIMARY KEY (workspace_id=?)");
    expect(deletePlan).toBe(
      "SEARCH factor_incidences USING PRIMARY KEY (workspace_id=? AND incidence_id=?)"
    );
    expect(listPlan).not.toMatch(/SCAN/i);
    expect(deletePlan).not.toMatch(/SCAN/i);
    expect(rows).toHaveLength(3);
    database.connection.prepare(DELETE_INCIDENCE_SQL).run("workspace-1", rows[0]!.incidence_id);
    expect(database.connection.prepare(LIST_INCIDENCES_SQL).all("workspace-1")).toHaveLength(2);
    assertCompactCatalog(database.connection);
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
        workspace_id, barrier_id, receipt_identity, generation_id,
        subject_kind, subject_id, erased_at
      ) VALUES (?, ?, ?, NULL, 'incidence', ?, ?)
    `).run(
      "workspace-1",
      "barrier-1",
      "receipt-1",
      "erased-incidence",
      CLOCK
    );

    expect(() => database.prepare(`
      INSERT INTO factor_incidences (
        workspace_id, incidence_id, span_id, factor_id, scope, operator_id, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      "workspace-1",
      "erased-incidence",
      existing.span_id,
      existing.factor_id,
      "erased-scope",
      existing.operator_id,
      CLOCK
    )).toThrow(/erased factor incidence cannot be admitted/u);

    expect(() => database.prepare(`
      INSERT INTO factor_incidences (
        workspace_id, incidence_id, span_id, factor_id, scope, operator_id, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      "workspace-1",
      "duplicate-incidence",
      existing.span_id,
      existing.factor_id,
      "workspace-1",
      existing.operator_id,
      CLOCK
    )).toThrow(/UNIQUE constraint failed/u);
  });
});

function openSeededIncidences(): StorageDatabase {
  const database = openFieldDatabase();
  tracked.add(database);
  const records = new SqliteFieldSourceRecordRepo(database, fieldSha256);
  const spans = new SqliteFieldSourceSpanRepo(database, fieldSha256);
  const factors = new SqliteFieldFactorRepo(database, fieldSha256);
  const record = records.insert(hashedRecord("workspace-1", "body"));
  const span = spans.insert(hashedSpan("workspace-1", record.record_id));
  const factor = factors.insertDescriptor(hashedFactor("workspace-1", "token"));
  for (const scope of ["workspace-1", "scope-b", "scope-c"] as const) {
    factors.insertIncidence(hashedIncidence(
      "workspace-1",
      span.span_id,
      factor.factor_id,
      scope
    ));
  }
  return database;
}

function openVersion8Incidences(): BetterSqlite3.Database {
  const database = new BetterSqlite3(":memory:");
  trackedRaw.add(database);
  database.pragma("foreign_keys = ON");
  applyBaselineSql(database, 8);
  seedWorkspaceRow(database, "workspace-1");
  const record = hashedRecord("workspace-1", "body");
  database.prepare(`
    INSERT INTO source_records (
      workspace_id, record_id, source_id, source_version, content_digest,
      evidence_object_id, recorded_at, event_time, valid_from, valid_to,
      operator_id, source_body
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.workspace_id,
    record.record_id,
    record.source_id,
    record.source_version,
    record.content_digest,
    record.evidence_object_id,
    record.recorded_at,
    record.event_time,
    record.valid_from,
    record.valid_to,
    record.operator_id,
    record.source_body
  );
  const span = hashedSpan("workspace-1", record.record_id);
  database.prepare(`
    INSERT INTO source_spans (
      workspace_id, span_id, record_id, start_offset, end_offset,
      purpose, producer_version, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    span.workspace_id,
    span.span_id,
    span.record_id,
    span.start_offset,
    span.end_offset,
    span.purpose,
    span.producer_version,
    span.recorded_at
  );
  const factor = hashedFactor("workspace-1", "token");
  database.prepare(`
    INSERT INTO factor_descriptors (
      workspace_id, factor_id, family, canonical_payload, operator_id, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    factor.workspace_id,
    factor.factor_id,
    factor.family,
    factor.canonical_payload,
    factor.operator_id,
    factor.recorded_at
  );
  for (const scope of ["workspace-1", "scope-b", "scope-c"] as const) {
    const incidence = hashedIncidence("workspace-1", span.span_id, factor.factor_id, scope);
    database.prepare(`
      INSERT INTO factor_incidences (
        workspace_id, incidence_id, span_id, factor_id, scope, operator_id, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      incidence.workspace_id,
      incidence.incidence_id,
      incidence.span_id,
      incidence.factor_id,
      incidence.scope,
      incidence.operator_id,
      incidence.recorded_at
    );
  }
  return database;
}

function explain(
  database: Pick<BetterSqlite3.Database, "prepare">,
  sql: string,
  params: readonly unknown[]
): string {
  const rows = database
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params) as ReadonlyArray<{ readonly detail: string }>;
  return rows.map((row) => row.detail).join("\n");
}

function assertCompactCatalog(database: Pick<BetterSqlite3.Database, "prepare">): void {
  const extraIndex = database.prepare(`
    SELECT name FROM sqlite_master WHERE name = 'idx_factor_incidences_workspace'
  `).get();
  const table = database.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'factor_incidences'
  `).get() as { readonly sql: string } | undefined;
  expect(extraIndex).toBeUndefined();
  expect(table?.sql).toMatch(/WITHOUT ROWID/i);
}
