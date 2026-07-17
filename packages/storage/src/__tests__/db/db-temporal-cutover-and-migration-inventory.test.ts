import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeCachedDatabase,
  initDatabase,
  readSchemaMigrationLedger
} from "../../sqlite/db.js";

interface TempContext {
  readonly directory: string;
  readonly filename: string;
}

function createTempDatabasePath(): TempContext {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "alaya-db-test-"));
  return { directory, filename: path.join(directory, "alaya.db") };
}

function cleanupTempDirectory(directory: string): void {
  fs.rmSync(directory, { recursive: true, force: true });
}

describe("temporal cutover startup gate", () => {
  let context: TempContext;

  beforeEach(() => {
    context = createTempDatabasePath();
  });

  afterEach(() => {
    closeCachedDatabase(context.filename);
    cleanupTempDirectory(context.directory);
  });

  it("refuses a complete pre-temporal source before a runtime open can mutate it", () => {
    seedMigrationsThrough(context.filename, 107);
    const before = readFileSha256(context.filename);

    expect(() => initDatabase({ filename: context.filename })).toThrow(
      /Temporal relation migration is pending/
    );

    expect(readFileSha256(context.filename)).toBe(before);
    expect(readSchemaMigrationLedger(context.filename).at(-1)).toBe(107);
  }, 30_000);

  it("fresh bootstrap records a verified empty temporal generation", () => {
    const database = initDatabase({ filename: context.filename });
    try {
      const state = database.connection.prepare(`
        SELECT active_projection_generation, projection_count, status
        FROM temporal_schema_state
        WHERE state_id = 1
      `).get() as {
        readonly active_projection_generation: string;
        readonly projection_count: number;
        readonly status: string;
      };

      expect(readSchemaMigrationLedger(context.filename).at(-1)).toBe(108);
      expect(state).toEqual({
        active_projection_generation: "temporal-bootstrap-empty-v1",
        projection_count: 0,
        status: "ready"
      });
    } finally {
      database.close();
    }
  });

  it("refuses a mixed temporal state without changing the selected database", () => {
    const database = initDatabase({ filename: context.filename });
    database.close();

    const tamper = new BetterSqlite3(context.filename);
    try {
      tamper.prepare("UPDATE temporal_schema_state SET status = 'building' WHERE state_id = 1").run();
    } finally {
      tamper.close();
    }
    const before = readFileSha256(context.filename);

    expect(() => initDatabase({ filename: context.filename })).toThrow(
      /Temporal relation schema is missing, unknown, or mixed/
    );

    expect(readFileSha256(context.filename)).toBe(before);
  });
});

describe("SQLite migration inventory guardrail", () => {
  it("keeps migration versions unique and gaps explicitly documented", () => {
    const inventory = readMigrationInventory();
    const duplicateVersions = [...inventory.versionCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([version]) => version);
    const zeroByteFiles = inventory.files
      .filter((file) => file.sql.trim().length === 0)
      .map((file) => file.name);
    const unallowlistedGaps = inventory.gaps.filter(
      (version) => !INTENTIONAL_MIGRATION_GAPS.has(version)
    );

    expect(duplicateVersions).toEqual([]);
    expect(zeroByteFiles).toEqual([]);
    expect(unallowlistedGaps).toEqual([]);
  });

  it("keeps comment-only migrations rare and explicitly marked", () => {
    const commentOnlyFiles = readMigrationInventory().files
      .filter((file) => stripSqlComments(file.sql).trim().length === 0)
      .map((file) => file.name);
    const unexpectedCommentOnly = commentOnlyFiles.filter(
      (fileName) => !INTENTIONAL_NOOP_MIGRATIONS.has(fileName)
    );
    const missingMarker = commentOnlyFiles.filter((fileName) => {
      const marker = "INTENTIONAL_NOOP_MIGRATION";
      const file = readMigrationInventory().files.find((item) => item.name === fileName);
      return file === undefined || !file.sql.includes(marker);
    });

    expect(unexpectedCommentOnly).toEqual([]);
    expect(missingMarker).toEqual([]);
  });

  it("keeps migration SQL comments free of task-history narrative", () => {
    const forbiddenPatterns = [
      /#BL-\d+/u,
      /\bvendor snapshot\b/iu,
      /\bpre-A1\b/iu,
      /\bfix-loop\b/iu,
      /\bv0\.\d+(?:\.\d+)?\b/iu,
      /\bv0\.3\.9\s+Cat-/iu,
      /\bCat-[A-Z0-9.]+\b/u
    ];
    const hits = readMigrationInventory().files.flatMap((file) =>
      file.sql
        .split(/\r?\n/u)
        .map((line, index) => ({ line, index: index + 1 }))
        .filter(({ line }) => line.trimStart().startsWith("--"))
        .filter(({ line }) => forbiddenPatterns.some((pattern) => pattern.test(line)))
        .map(({ line, index }) => `${file.name}:${index}:${line.trim()}`)
    );

    expect(hits).toEqual([]);
  });
});

const INTENTIONAL_MIGRATION_GAPS = new Set([70, 75]);
const INTENTIONAL_NOOP_MIGRATIONS = new Set([
  "074-claim-kind-expanded.sql",
  "104-engine-bindings-api-key-encrypt.sql",
]);

function readMigrationInventory(): {
  readonly files: readonly { readonly name: string; readonly version: number; readonly sql: string }[];
  readonly versionCounts: ReadonlyMap<number, number>;
  readonly gaps: readonly number[];
} {
  const migrationsDirectory = fileURLToPath(new URL("../../migrations", import.meta.url));
  const files = fs
    .readdirSync(migrationsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => {
      const match = /^(\d+)-.+\.sql$/u.exec(entry.name);
      expect(match, `invalid migration filename: ${entry.name}`).not.toBeNull();
      const version = Number(match?.[1] ?? Number.NaN);
      return {
        name: entry.name,
        version,
        sql: fs.readFileSync(path.join(migrationsDirectory, entry.name), "utf8")
      };
    })
    .sort((left, right) => left.version - right.version);
  const versionCounts = new Map<number, number>();
  for (const file of files) {
    versionCounts.set(file.version, (versionCounts.get(file.version) ?? 0) + 1);
  }
  const versions = new Set(files.map((file) => file.version));
  const maxVersion = Math.max(...versions);
  const gaps: number[] = [];
  for (let version = 1; version <= maxVersion; version += 1) {
    if (!versions.has(version)) {
      gaps.push(version);
    }
  }
  return { files, versionCounts, gaps };
}

function seedMigrationsThrough(filename: string, maxVersion: number): void {
  const seed = new BetterSqlite3(filename);
  try {
    seed.pragma("foreign_keys = ON");
    seed.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);
    const markApplied = seed.prepare(
      "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)"
    );
    for (const file of readMigrationInventory().files.filter((candidate) => candidate.version <= maxVersion)) {
      seed.transaction(() => {
        seed.exec(file.sql);
        markApplied.run(file.version, `2026-07-17T00:00:${String(file.version).padStart(2, "0")}.000Z`);
      })();
    }
  } finally {
    seed.close();
  }
}

function readFileSha256(filename: string): string {
  return createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .split(/\r?\n/u)
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}
