import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { closeCachedDatabase, initDatabase, type StorageDatabase } from "../../sqlite/db.js";
import { SqliteMemoryEntryRepo } from "../../repos/memory-entry/sqlite-memory-entry-repo.js";
import { SqliteSynthesisCapsuleRepo } from "../../repos/capsules/synthesis-capsule-repo.js";
import { createRepo, trackedDatabases } from "../repos/memory-entry/memory-entry-repo-fixture.js";
import { seedHistoricalMember } from "../repos/memory-entry/historical-preservation-fixture.js";
import { removeHistoricalPreservationMigration } from "./historical-preservation-migration-fixture.js";

const directories: string[] = [];
afterEach(() => {
  for (const database of trackedDatabases) { database.close(); closeCachedDatabase(database.filename); }
  trackedDatabases.clear();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const MEMORY = "11111111-1111-4111-8111-111111111111";
const CAPSULE = "22222222-2222-4222-8222-222222222222";
const schema = (database: StorageDatabase) => database.connection.prepare(
  "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();

it("reinstalls the exact preservation schema on reopen and admits historical GC after upgrade", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alaya-preservation-upgrade-"));
  directories.push(directory);
  const filename = join(directory, "memory.sqlite");
  const { database } = await createRepo({ filename });
  const currentSchema = schema(database);
  removeHistoricalPreservationMigration(database);
  expect(database.connection.prepare("SELECT MAX(version) AS version FROM schema_version").get()).toEqual({ version: 52 });
  expect(database.connection.prepare("SELECT name FROM sqlite_master WHERE name='historical_memory_captures'").get()).toBeUndefined();
  // The restored old view is executable, not an unresolved reference to removed tables.
  expect(database.connection.prepare("SELECT * FROM privacy_dependency_candidates").all()).toEqual([]);
  closeCachedDatabase(filename);
  const upgraded = initDatabase({ filename });
  trackedDatabases.add(upgraded);
  expect(schema(upgraded)).toEqual(currentSchema);
  const memories = new SqliteMemoryEntryRepo(upgraded);
  await seedHistoricalMember(upgraded, memories, MEMORY, CAPSULE);
  expect(await memories.hardDeleteTombstonedWithDisposition(MEMORY, { requireLiveCapsuleRef: true })).toBe(true);
  expect(await new SqliteSynthesisCapsuleRepo(upgraded).readHistoricalMember("workspace-1", CAPSULE, MEMORY))
    .toMatchObject({ status: "ready" });
});

it("refuses fixture downgrade without changing retained captures or protections", async () => {
  const { database, repo } = await createRepo();
  await seedHistoricalMember(database, repo, MEMORY, CAPSULE);
  const currentSchema = schema(database);
  expect(() => removeHistoricalPreservationMigration(database)).toThrow("containing historical captures");
  expect(schema(database)).toEqual(currentSchema);
  expect(database.connection.prepare("SELECT version FROM schema_version WHERE version=46").get()).toEqual({ version: 46 });
  expect(await new SqliteSynthesisCapsuleRepo(database).readHistoricalMember("workspace-1", CAPSULE, MEMORY))
    .toMatchObject({ status: "ready" });
});
