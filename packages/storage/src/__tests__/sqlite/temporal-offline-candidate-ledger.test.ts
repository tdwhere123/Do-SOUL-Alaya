import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeCachedDatabase, readSchemaMigrationLedger } from "../../sqlite/db.js";
import { prepareTemporalCandidate } from "../../sqlite/temporal-offline-candidate.js";
import { removeTempDirectorySync } from "../temp-directory.js";

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL("../../migrations", import.meta.url));
const temporaryDirectories: string[] = [];
const fixtureFilenames: string[] = [];
const TEMPORAL_CANDIDATE_TIMEOUT_MS = process.platform === "win32" ? 60_000 : 15_000;

afterEach(() => {
  vi.restoreAllMocks();
  for (const filename of fixtureFilenames.splice(0)) {
    closeCachedDatabase(filename);
  }
  for (const directory of temporaryDirectories.splice(0)) {
    removeTempDirectorySync(directory);
  }
});

describe("prepareTemporalCandidate migration ledger", () => {
  it.each([false, true])("preserves a valid publication outcome after receipt directory sync fails (persistent=%s)", async persistent => {
    const fixture = createFixture();
    seedLegacySource(fixture.sourceFilename);
    const link = fs.linkSync.bind(fs);
    const sync = fs.fsyncSync.bind(fs);
    let receiptLinked = false;
    let failures = 0;
    vi.spyOn(fs, "linkSync").mockImplementation((source, destination) => {
      link(source, destination);
      if (destination === fixture.receiptFilename) receiptLinked = true;
    });
    vi.spyOn(fs, "fsyncSync").mockImplementation(descriptor => {
      if (receiptLinked && fs.fstatSync(descriptor).isDirectory() && (persistent || failures === 0)) {
        failures++;
        throw new Error("injected receipt directory sync failure");
      }
      sync(descriptor);
    });
    await expect(prepareTemporalCandidate(fixture)).rejects.toThrow(persistent ? /candidate retained for recovery/u : /directory sync failed/u);
    expect(fs.existsSync(fixture.candidateFilename)).toBe(persistent);
    if (!persistent) {
      expect(JSON.parse(fs.readFileSync(fixture.receiptFilename, "utf8"))).toMatchObject({ status: "failed" });
    } else {
      expect(readSchemaMigrationLedger(fixture.candidateFilename)).toEqual(migrationFiles().map(migration => migration.version));
    }
  }, TEMPORAL_CANDIDATE_TIMEOUT_MS);

  it("keeps exactly one complete prepared output when callers compete for the same paths", async () => {
    const fixture = createFixture();
    seedLegacySource(fixture.sourceFilename);
    const results = await Promise.allSettled([prepareTemporalCandidate(fixture), prepareTemporalCandidate(fixture)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(fixture.receiptFilename, "utf8"))).toMatchObject({ status: "prepared" });
    expect(readSchemaMigrationLedger(fixture.candidateFilename)).toEqual(migrationFiles().map(migration => migration.version));
  }, TEMPORAL_CANDIDATE_TIMEOUT_MS);

  it("strictly extends a complete legacy ledger through every known migration", async () => {
    const fixture = createFixture();
    seedLegacySource(fixture.sourceFilename);

    const result = await prepareTemporalCandidate(fixture);
    const knownVersions = migrationFiles().map((migration) => migration.version);

    expect(result.source.schemaVersions).toEqual(
      knownVersions.filter((version) => version < 7)
    );
    expect(result.candidate.schemaVersions).toEqual(knownVersions);
    expect(readSchemaMigrationLedger(fixture.candidateFilename)).toEqual(knownVersions);
    closeCachedDatabase(fixture.candidateFilename);
  }, TEMPORAL_CANDIDATE_TIMEOUT_MS);

  it("rejects a legacy ledger with a missing known migration", async () => {
    const fixture = createFixture();
    seedLegacySource(fixture.sourceFilename);
    const database = new BetterSqlite3(fixture.sourceFilename);
    try {
      database.prepare("DELETE FROM schema_version WHERE version = 3").run();
    } finally {
      database.close();
    }

    await expect(prepareTemporalCandidate(fixture)).rejects.toThrow(
      /complete known pre-temporal migration ledger/
    );
  }, TEMPORAL_CANDIDATE_TIMEOUT_MS);
});

function createFixture(): {
  readonly sourceFilename: string;
  readonly candidateFilename: string;
  readonly receiptFilename: string;
} {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "alaya-temporal-ledger-"));
  temporaryDirectories.push(directory);
  const sourceFilename = path.join(directory, "legacy.db");
  const candidateFilename = path.join(directory, "candidate.db");
  fixtureFilenames.push(sourceFilename, candidateFilename);
  return {
    sourceFilename,
    candidateFilename,
    receiptFilename: path.join(directory, "receipt.json")
  };
}

function seedLegacySource(filename: string): void {
  const database = new BetterSqlite3(filename);
  try {
    database.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    const markApplied = database.prepare(
      "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)"
    );
    for (const migration of migrationFiles().filter((candidate) => candidate.version < 7)) {
      database.transaction(() => {
        database.exec(migration.sql);
        markApplied.run(migration.version, "2026-07-28T00:00:00.000Z");
      })();
    }
  } finally {
    database.close();
  }
}

function migrationFiles(): readonly {
  readonly version: number;
  readonly sql: string;
}[] {
  return fs.readdirSync(MIGRATIONS_DIRECTORY)
    .map((name) => ({ name, match: /^(\d+)-.+\.sql$/u.exec(name) }))
    .filter(
      (entry): entry is { readonly name: string; readonly match: RegExpExecArray } =>
        entry.match !== null
    )
    .map(({ name, match }) => ({
      version: Number(match[1]),
      sql: fs.readFileSync(path.join(MIGRATIONS_DIRECTORY, name), "utf8")
    }))
    .sort((left, right) => left.version - right.version);
}
