import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { initDatabase } from "../db.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(currentDirectory, "../../../..");
const sourceMigrationsDirectory = path.join(
  repositoryRoot,
  "vendor/do-what-new-snapshot/packages/storage/src/migrations"
);
const targetMigrationsDirectory = path.join(repositoryRoot, "packages/storage/src/migrations");

const expectedVendorMigrationCount = 55;
const expectedFirstMigration = "001-initial.sql";
const expectedLastMigration = "055-global-memory-recall-cache-global-object-index.sql";
const expectedAlayaOnlyMigrations = [
  "056-trust-state-persistence.sql",
  "057-event-log-orphan-radar.sql",
  // A1 (HITL daemon backbone): adds reviewer_identity + HITL summary
  // projection columns (target_object_kind, proposed_change_summary,
  // created_at) to the proposals table.
  "058-reviewer-identity.sql"
];

function listSqlMigrations(directory: string): string[] {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function sha256File(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

describe("migration parity", () => {
  it("keeps storage migration filenames and content byte-for-byte with the vendor snapshot", () => {
    expect(fs.existsSync(sourceMigrationsDirectory)).toBe(true);
    expect(fs.existsSync(targetMigrationsDirectory)).toBe(true);

    const sourceFiles = listSqlMigrations(sourceMigrationsDirectory);
    const targetFiles = listSqlMigrations(targetMigrationsDirectory);

    expect(sourceFiles).toHaveLength(expectedVendorMigrationCount);
    expect(targetFiles).toHaveLength(expectedVendorMigrationCount + expectedAlayaOnlyMigrations.length);
    expect(sourceFiles[0]).toBe(expectedFirstMigration);
    expect(sourceFiles.at(-1)).toBe(expectedLastMigration);
    expect(targetFiles[0]).toBe(expectedFirstMigration);
    expect(targetFiles.slice(0, sourceFiles.length)).toEqual(sourceFiles);
    expect(targetFiles.slice(sourceFiles.length)).toEqual(expectedAlayaOnlyMigrations);

    const mismatches = sourceFiles.filter((fileName) => {
      const sourceHash = sha256File(path.join(sourceMigrationsDirectory, fileName));
      const targetHash = sha256File(path.join(targetMigrationsDirectory, fileName));

      return sourceHash !== targetHash;
    });

    expect(mismatches).toEqual([]);
  });

  it("exposes the trust-state tables and event-log orphan radar shape after migrations 056 and 057", () => {
    const database = initDatabase();
    try {
      const tableRows = database.connection
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type='table'
             AND name IN ('trust_context_delivery', 'trust_usage_proof', 'orphan_radar')
           ORDER BY name`
        )
        .all() as ReadonlyArray<Readonly<{ name: string }>>;
      expect(tableRows.map((row) => row.name)).toEqual([
        "orphan_radar",
        "trust_context_delivery",
        "trust_usage_proof"
      ]);

      const deliveryIndexes = database.connection
        .prepare(`PRAGMA index_list('trust_context_delivery')`)
        .all() as ReadonlyArray<Readonly<{ name: string }>>;
      expect(deliveryIndexes.map((row) => row.name)).toEqual(
        expect.arrayContaining(["idx_trust_context_delivery_agent_target_delivered_at"])
      );

      const orphanColumns = database.connection
        .prepare(`PRAGMA table_info('orphan_radar')`)
        .all() as ReadonlyArray<Readonly<{ name: string }>>;
      const columnNames = orphanColumns.map((row) => row.name);
      expect(columnNames).toEqual(
        expect.arrayContaining([
          "target_memory_id",
          "target_event_id",
          "target_event_type",
          "expected_table"
        ])
      );

      const orphanIndexes = database.connection
        .prepare(`PRAGMA index_list('orphan_radar')`)
        .all() as ReadonlyArray<Readonly<{ name: string }>>;
      expect(orphanIndexes.map((row) => row.name)).toEqual(
        expect.arrayContaining(["idx_orphan_radar_target_event"])
      );
    } finally {
      database.close();
    }
  });
});
