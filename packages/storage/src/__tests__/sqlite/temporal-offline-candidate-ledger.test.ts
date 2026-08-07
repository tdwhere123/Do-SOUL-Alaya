import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { closeCachedDatabase, readSchemaMigrationLedger } from "../../sqlite/db.js";
import { prepareTemporalCandidate } from "../../sqlite/temporal-offline-candidate.js";

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL("../../migrations", import.meta.url));
const temporaryDirectories: string[] = [];
const TEMPORAL_CANDIDATE_TIMEOUT_MS = 15_000;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("prepareTemporalCandidate migration ledger", () => {
  it("strictly extends a complete legacy ledger through every known migration", async () => {
    const fixture = createFixture();
    seedLegacySource(fixture.sourceFilename);

    const result = await prepareTemporalCandidate(fixture);
    const knownVersions = migrationFiles().map((migration) => migration.version);

    expect(result.source.schemaVersions).toEqual(
      knownVersions.filter((version) => version < 108)
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
      database.prepare("DELETE FROM schema_version WHERE version = 50").run();
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
  return {
    sourceFilename: path.join(directory, "legacy.db"),
    candidateFilename: path.join(directory, "candidate.db"),
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
    for (const migration of migrationFiles().filter((candidate) => candidate.version < 108)) {
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
