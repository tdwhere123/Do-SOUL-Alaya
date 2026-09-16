import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import {
  DecayProfileSchema,
  ForgetDispositionSchema,
  FormationKindSchema,
  ManifestationStateSchema,
  MemoryDimensionSchema,
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
import { StorageDatabase, initDatabase } from "../../sqlite/db.js";
import { migrateLegacyPathRelationsToTemporalCandidate } from "../../sqlite/temporal-cutover-gate.js";
import { applyBaselineSql } from "./apply-baseline.js";
import { removeTempDirectorySync } from "../temp-directory.js";

const databases = new Set<ReturnType<typeof initDatabase>>();
const directories: string[] = [];

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      removeTempDirectorySync(directory);
    }
  }
});

function openMemoryDatabase(): ReturnType<typeof initDatabase> {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  return database;
}

function memoryEntriesCreateSql(database: ReturnType<typeof initDatabase>): string {
  const row = database.connection.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_entries'"
  ).get() as { readonly sql: string } | undefined;
  expect(row?.sql).toEqual(expect.any(String));
  return row!.sql;
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

describe("memory_entries enum CHECKs", () => {
  it("keeps protocol enum sets identical to the rebuilt table CHECK lists", () => {
    const sql = memoryEntriesCreateSql(openMemoryDatabase());
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
  });

  it("rejects an illegal dimension or storage_tier on direct insert", () => {
    const database = openMemoryDatabase();
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
    const stored = database.connection.prepare(
      "SELECT dimension, storage_tier FROM memory_entries WHERE object_id = 'mem-legal'"
    ).get() as { readonly dimension: string; readonly storage_tier: string };
    expect(stored).toEqual({ dimension: "fact", storage_tier: "hot" });
  });

  it("applies enum CHECKs on upgrade even when an unrelated FK violation already exists", () => {
    const directory = mkdtempSync(join(tmpdir(), "alaya-enum-check-fk-"));
    directories.push(directory);
    const filename = join(directory, "alaya.db");
    const old = new StorageDatabase(filename, new BetterSqlite3(filename));
    applyBaselineSql(old.connection, 13);
    migrateLegacyPathRelationsToTemporalCandidate(old.connection, { selectionRequired: false });
    old.connection.exec(
      "CREATE TABLE schema_version(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)"
    );
    for (let version = 1; version <= 13; version += 1) {
      old.connection.prepare("INSERT INTO schema_version VALUES (?, ?)").run(
        version,
        "2026-09-01T00:00:00.000Z"
      );
    }
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

    const migrated = initDatabase({ filename });
    databases.add(migrated);
    expect(
      migrated.connection.prepare("SELECT MAX(version) AS version FROM schema_version").get()
    ).toEqual({ version: 17 });
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
    // File-backed upgrade-and-reopen exceeds the 5s storage default under coverage and NTFS.
  }, process.platform === "win32" ? 180_000 : 60_000);
});
