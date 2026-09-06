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
      after = page.observations.at(-1)?.assertionId ?? after;
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

  it("emits a 32-row prefix of 40 matches and concatenates resume without skip or dup", () => {
    const database = openDatabase();
    const ids = plantAssertions(database, 40);
    const reader = new SqliteRelationRecallReader(database);
    reader.prepareIndex();
    const first = reader.read("workspace-1", "vega", "owns", 32, 32);
    expect(first.observations.map((row) => row.assertionId)).toEqual(ids.slice(0, 32));
    expect(first.truncated).toBe(true);
    const after = first.observations.at(-1)?.assertionId ?? null;
    const second = reader.read("workspace-1", "vega", "owns", 32, 32, after);
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
