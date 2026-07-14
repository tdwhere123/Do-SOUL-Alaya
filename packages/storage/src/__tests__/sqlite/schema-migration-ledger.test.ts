import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { readSchemaMigrationLedger } from "../../index.js";

const roots = new Set<string>();

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe("readSchemaMigrationLedger", () => {
  it("returns an immutable ordered ledger without changing the database file", () => {
    const filename = createDatabase();
    writeCanonicalLedger(filename, [4, 1, 2]);
    const before = fileIdentity(filename);

    const ledger = readSchemaMigrationLedger(filename);

    expect(ledger).toEqual([1, 2, 4]);
    expect(Object.isFrozen(ledger)).toBe(true);
    expect(fileIdentity(filename)).toEqual(before);
    const moved = `${filename}.moved`;
    renameSync(filename, moved);
    renameSync(moved, filename);
  });

  it.each([
    [102, "lower"],
    [103, "equal"],
    [104, "higher"]
  ] as const)("exposes max version %i for a consumer's %s comparison", (version, _comparison) => {
    const filename = createDatabase();
    writeCanonicalLedger(filename, [version]);

    expect(readSchemaMigrationLedger(filename).at(-1)).toBe(version);
  });

  it("rejects a missing or empty schema ledger", () => {
    const missingTable = createDatabase();
    const emptyLedger = createDatabase();
    writeCanonicalLedger(emptyLedger, []);

    expect(() => readSchemaMigrationLedger(missingTable)).toThrow(/schema_version/u);
    expect(() => readSchemaMigrationLedger(emptyLedger)).toThrow(/empty/u);
  });

  it("rejects a non-canonical table and unsafe ledger values", () => {
    const malformed = createDatabase();
    const db = new BetterSqlite3(malformed);
    db.exec("CREATE TABLE schema_version (version REAL, applied_at TEXT)");
    db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)")
      .run(1.5, "2026-07-12T00:00:00.000Z");
    db.close();

    expect(() => readSchemaMigrationLedger(malformed)).toThrow(/canonical/u);

    const unsafe = createDatabase();
    writeCanonicalLedger(unsafe, [-1]);
    expect(() => readSchemaMigrationLedger(unsafe)).toThrow(/unsafe/u);
  });
});

function createDatabase(): string {
  const root = mkdtempSync(join(tmpdir(), "alaya-schema-ledger-"));
  roots.add(root);
  const filename = join(root, "alaya.db");
  new BetterSqlite3(filename).close();
  return filename;
}

function writeCanonicalLedger(filename: string, versions: readonly number[]): void {
  const db = new BetterSqlite3(filename);
  db.exec(`CREATE TABLE schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
  const insert = db.prepare(
    "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)"
  );
  for (const version of versions) insert.run(version, "2026-07-12T00:00:00.000Z");
  db.close();
}

function fileIdentity(filename: string): Readonly<{ sha256: string; mtimeMs: number }> {
  return {
    sha256: createHash("sha256").update(readFileSync(filename)).digest("hex"),
    mtimeMs: statSync(filename).mtimeMs
  };
}
