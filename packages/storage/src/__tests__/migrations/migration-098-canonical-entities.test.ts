import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initDatabase } from "../../sqlite/db.js";

const tempDirs = new Set<string>();
const openDbs = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const db of openDbs) {
    db.close();
  }
  openDbs.clear();
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

function openTempDatabase(filename: string): ReturnType<typeof initDatabase> {
  const db = initDatabase({ filename });
  openDbs.add(db);
  return db;
}

function hasCanonicalEntitiesColumn(db: ReturnType<typeof initDatabase>): boolean {
  const columns = db.connection.pragma("table_info(memory_entries)") as ReadonlyArray<{ readonly name: string }>;
  return columns.some((column) => column.name === "canonical_entities");
}

describe("migration 098 memory_entries.canonical_entities", () => {
  it("adds the canonical_entities column on a fresh database", () => {
    const db = openTempDatabase(":memory:");
    expect(hasCanonicalEntitiesColumn(db)).toBe(true);
  });

  it("is idempotent when migrations are re-run against the same database file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alaya-migration-098-"));
    tempDirs.add(dir);
    const filename = path.join(dir, "alaya.db");

    const first = openTempDatabase(filename);
    expect(hasCanonicalEntitiesColumn(first)).toBe(true);
    first.close();
    openDbs.delete(first);

    const second = openTempDatabase(filename);
    expect(hasCanonicalEntitiesColumn(second)).toBe(true);
  });
});
