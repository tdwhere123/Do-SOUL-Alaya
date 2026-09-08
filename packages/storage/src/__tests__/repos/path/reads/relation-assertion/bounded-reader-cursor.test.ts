import { afterEach, describe, expect, it } from "vitest";
import { initDatabase, type StorageDatabase } from "../../../../../sqlite/db.js";
import { SqliteRelationRecallReader } from "../../../../../repos/path/reads/relation-assertion/bounded-reader.js";
import { SqliteWorkspaceRepo } from "../../../../../repos/runtime/workspace-repo.js";
import { WorkspaceKind, WorkspaceState } from "@do-soul/alaya-protocol";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("SqliteRelationRecallReader cursor", () => {
  it("uses the prepared subject index without requiring it in SQL", () => {
    const database = openDatabase();
    plantAssertions(database, 3);
    const reader = new SqliteRelationRecallReader(database);
    reader.prepareIndex();
    expect(JSON.stringify(reader.explain("workspace-1", "vega", "owns"))).toContain("idx_relation_recall_subject");
  });

  it("reads and advances a query-only snapshot without optional recall indexes", () => {
    const database = openDatabase();
    const ids = plantAssertions(database, 3);
    database.connection.exec("DROP INDEX IF EXISTS idx_relation_recall_subject; DROP INDEX IF EXISTS idx_relation_recall_predicate;");
    database.connection.pragma("query_only = ON");
    const reader = new SqliteRelationRecallReader(database);
    const first = reader.read("workspace-1", "vega", "owns", 1);
    const rest = reader.read("workspace-1", null, "owns", 8, 8, first.committedThrough);
    expect([...first.observations, ...rest.observations].map((row) => row.assertionId)).toEqual(ids);
    expect(rest.truncated).toBe(false);
    expect(database.connection.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'idx_relation_recall_%'").all()).toEqual([]);
  });

  it("reconstructs the exact admitted resolution at as-of from EventLog history", () => {
    const database = openDatabase();
    const [id] = plantAssertions(database, 1);
    const append = database.connection.prepare(`INSERT INTO event_log
      (event_id,event_type,entity_type,entity_id,workspace_id,run_id,caused_by,payload_json,created_at,revision)
      VALUES (?, 'relation.assertion_resolved', 'relation_assertion', ?, 'workspace-1', NULL, 'test', ?, ?, ?)`);
    for (const [revision, kind, stamp] of [[1, "contradicted", "2026-02-01T00:00:00.000Z"], [2, "retracted", "2026-03-01T00:00:00.000Z"]] as const) {
      append.run(`resolution-${revision}`, id, JSON.stringify({ assertion_id: id, resolution_kind: kind, resolved_at: stamp }), stamp, revision);
    }
    const reader = new SqliteRelationRecallReader(database); reader.prepareIndex();
    expect(reader.read("workspace-1", "vega", "owns", 1, 1, null, "2025-12-01T00:00:00.000Z").observations).toEqual([]);
    expect(reader.read("workspace-1", "vega", "owns", 1, 1, null, "2026-01-15T00:00:00.000Z").observations[0]?.resolutionKind).toBeNull();
    expect(reader.read("workspace-1", "vega", "owns", 1, 1, null, "2026-02-15T00:00:00.000Z").observations[0]?.resolutionKind).toBe("contradicted");
    expect(reader.read("workspace-1", "vega", "owns", 1, 1, null, "2026-03-15T00:00:00.000Z").observations[0]?.resolutionKind).toBe("retracted");
  });

  it("keeps the one-shot relation page and concatenates advancing pages", () => {
    const database = openDatabase();
    const ids = plantAssertions(database, 8);
    const reader = new SqliteRelationRecallReader(database);
    reader.prepareIndex();
    const full = reader.read("workspace-1", "vega", "owns", 16);
    expect(full.observations.map((row) => row.assertionId)).toEqual(ids);
    expect(full.truncated).toBe(false);
    const pages: string[] = [];
    let after: string | null = null;
    for (let step = 0; step < 16; step += 1) {
      const page = reader.read("workspace-1", "vega", "owns", 2, 512, after);
      pages.push(...page.observations.map((row) => row.assertionId));
      if (!page.truncated) break;
      after = page.committedThrough ?? after;
    }
    expect(pages).toEqual(full.observations.map((row) => row.assertionId));
    expect(pages).toEqual(ids);
  });

  it("reports a native zero-row interrupt as truncated, not a completed empty domain", () => {
    const database = openDatabase();
    const ids = plantAssertions(database, 8);
    const reader = new SqliteRelationRecallReader(database);
    reader.prepareIndex();
    const interrupted = reader.read("workspace-1", "vega", "owns", 16, 0);
    expect(interrupted.observations).toEqual([]);
    expect(interrupted.truncated).toBe(true);
    expect(interrupted.nativeVisits).toBe(0);
    const during = reader.read("workspace-1", "vega", "owns", 16, 1);
    expect(during.observations.map((row) => row.assertionId)).toEqual([ids[0]]);
    expect(during.truncated).toBe(true);
    expect(during.nativeVisits).toBeGreaterThan(0);
    const empty = reader.read("workspace-1", "vega", "missing", 16);
    expect(empty.observations).toEqual([]);
    expect(empty.truncated).toBe(false);
  });

  it("advances a compound cursor through two evidence rows at nativeLimit 1", () => {
    const database = openDatabase();
    const ids = plantAssertions(database, 2);
    database.connection.prepare(`
      INSERT INTO relation_assertion_evidence (
        assertion_id, evidence_id, source_event_type, source_event_id, source_occurred_at
      ) VALUES (?, ?, 'soul.signal.emitted', ?, ?)
    `).run(ids[0], "evidence-extra", "event-extra", "2026-01-01T00:00:00.000Z");
    const reader = new SqliteRelationRecallReader(database);
    reader.prepareIndex();
    const first = reader.read("workspace-1", "vega", "owns", 1, 1, null);
    expect(first.observations[0]?.evidenceRefs).toHaveLength(1);
    expect(first.nativeVisits).toBe(1);
    expect(first.truncated).toBe(true);
    expect(first.committedThrough).not.toBeNull();
    const second = reader.read("workspace-1", "vega", "owns", 1, 1, first.committedThrough);
    expect(second.observations.map((row) => row.assertionId)).toEqual([ids[0]]);
    expect(second.observations[0]?.evidenceRefs).toHaveLength(1);
    expect(new Set([...first.observations[0]!.evidenceRefs, ...second.observations[0]!.evidenceRefs]).size).toBe(2);
    const third = reader.read("workspace-1", "vega", "owns", 1, 1, second.committedThrough);
    expect(third.observations.map((row) => row.assertionId)).toEqual([ids[1]]);
  });

  it("retains one evidence fragment per native visit across a thousand receipts", () => {
    const database = openDatabase();
    const ids = plantAssertions(database, 2);
    const insert = database.connection.prepare(`
      INSERT INTO relation_assertion_evidence (
        assertion_id, evidence_id, source_event_type, source_event_id, source_occurred_at
      ) VALUES (?, ?, 'soul.signal.emitted', ?, ?)
    `);
    for (let index = 0; index < 999; index += 1) {
      insert.run(ids[0], `evidence-extra-${index}`, `event-extra-${index}`, "2026-01-01T00:00:00.000Z");
    }
    const reader = new SqliteRelationRecallReader(database);
    reader.prepareIndex();
    const seen: string[] = [];
    const evidence = new Set<string>();
    let after: string | null = null;
    for (let step = 0; step < 1010; step += 1) {
      const page = reader.read("workspace-1", "vega", "owns", 1, 1, after);
      seen.push(...page.observations.map((row) => row.assertionId));
      expect(page.nativeVisits).toBeLessThanOrEqual(1);
      expect(page.observations.flatMap((row) => row.evidenceRefs)).toHaveLength(page.rowsRead);
      expect(page.bytesRead).toBe(Buffer.byteLength(JSON.stringify(page.rawRows), "utf8"));
      for (const row of page.observations) for (const ref of row.evidenceRefs) evidence.add(ref);
      after = page.committedThrough;
      if (!page.truncated) break;
    }
    expect([...new Set(seen)]).toEqual(ids);
    expect(evidence.size).toBe(1001);
  });

  it("emits a 32-row prefix of 40 matches and concatenates resume without skip or dup", () => {
    const database = openDatabase();
    const ids = plantAssertions(database, 40);
    const reader = new SqliteRelationRecallReader(database);
    reader.prepareIndex();
    const first = reader.read("workspace-1", "vega", "owns", 32, 32);
    expect(first.observations.map((row) => row.assertionId)).toEqual(ids.slice(0, 32));
    expect(first.truncated).toBe(true);
    const second = reader.read("workspace-1", "vega", "owns", 32, 32, first.committedThrough);
    const concatenated = [
      ...first.observations.map((row) => row.assertionId),
      ...second.observations.map((row) => row.assertionId)
    ];
    expect(concatenated).toEqual(ids);
    expect(new Set(concatenated).size).toBe(ids.length);
  });
});

function openDatabase(): StorageDatabase {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  new SqliteWorkspaceRepo(database).create({
    workspace_id: "workspace-1",
    name: "workspace one",
    root_path: "/tmp/ws1",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  return database;
}

function plantAssertions(database: StorageDatabase, count: number): readonly string[] {
  const ids = Array.from({ length: count }, (_, index) => `assert-${String(index + 1).padStart(2, "0")}`);
  const asOf = "2026-01-01T00:00:00.000Z";
  const assertion = database.connection.prepare(`
    INSERT INTO relation_assertions (
      assertion_id, workspace_id, admission_event_id, identity_key,
      anchors_json, relation_kind, validity_json, formation_receipt_json, admitted_at
    ) VALUES (?, 'workspace-1', ?, ?, ?, 'owns', ?, ?, ?)
  `);
  const evidence = database.connection.prepare(`
    INSERT INTO relation_assertion_evidence (
      assertion_id, evidence_id, source_event_type, source_event_id, source_occurred_at
    ) VALUES (?, ?, 'soul.signal.emitted', ?, ?)
  `);
  for (const [index, assertionId] of ids.entries()) {
    const target = `person-${String(index + 1).padStart(2, "0")}`;
    assertion.run(
      assertionId,
      `event-${assertionId}`,
      `identity-${assertionId}`,
      JSON.stringify({
        source_anchor: { kind: "object", object_id: "vega" },
        target_anchor: { kind: "object", object_id: target }
      }),
      JSON.stringify({ kind: "open", valid_from: asOf }),
      JSON.stringify({ parameters: { result_object_id: target } }),
      asOf
    );
    evidence.run(assertionId, `evidence-${assertionId}`, `event-${assertionId}`, asOf);
  }
  return ids;
}
