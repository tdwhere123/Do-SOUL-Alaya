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
import { migrateLegacyPathRelationsToTemporalCandidate } from "../../sqlite/temporal-cutover-gate.js";

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
        SELECT active_projection_generation, projection_count, status,
               projection_refresh_required
        FROM temporal_schema_state
        WHERE state_id = 1
      `).get() as {
        readonly active_projection_generation: string;
        readonly projection_count: number;
        readonly status: string;
      };

      expect(readSchemaMigrationLedger(context.filename).at(-1)).toBe(119);
      expect(state).toEqual({
        active_projection_generation: "temporal-bootstrap-empty-v1",
        projection_count: 0,
        status: "ready",
        projection_refresh_required: 0
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

  it("quarantines pre-receipt assertions and resets selected temporal state", () => {
    seedMigrationsThrough(context.filename, 107);
    seedTemporalMigrationsThrough(context.filename, 116);
    seedLegacyRelationAssertion(context.filename);

    const database = initDatabase({ filename: context.filename, temporalMode: "candidate" });
    try {
      const quarantine = database.connection.prepare(`
        SELECT source_kind, source_identity, reason, source_json, source_digest
        FROM relation_assertion_quarantine
        WHERE source_kind = 'legacy_relation_assertion'
          AND source_identity = 'legacy-assertion'
      `).get() as {
        readonly source_kind: string;
        readonly source_identity: string;
        readonly reason: string;
        readonly source_json: string;
        readonly source_digest: string;
      };
      const source = JSON.parse(quarantine.source_json) as Record<string, unknown>;
      const state = database.connection.prepare(`
        SELECT assertion_schema_generation, assertion_event_contract_generation,
               projection_count, temporal_projection_selection_required,
               temporal_projection_selected, selection_id,
               projection_refresh_required
        FROM temporal_schema_state
        WHERE state_id = 1
      `).get();

      expect(readSchemaMigrationLedger(context.filename).at(-1)).toBe(119);
      expect(database.connection.prepare("SELECT COUNT(*) AS count FROM relation_assertions").get())
        .toEqual({ count: 0 });
      expect(database.connection.prepare(
        "SELECT COUNT(*) AS count FROM relation_assertion_resolution_current"
      ).get()).toEqual({ count: 0 });
      expect(quarantine).toMatchObject({
        source_kind: "legacy_relation_assertion",
        source_identity: "legacy-assertion",
        reason: "missing_formation_receipt",
        source_digest: "f".repeat(64)
      });
      expect(source).toMatchObject({
        assertion_id: "legacy-assertion",
        evidence_ids: ["legacy-evidence"],
        resolution: {
          resolution_id: "legacy-resolution",
          resolution_kind: "retracted"
        }
      });
      expect(state).toEqual({
        assertion_schema_generation: "relation_assertion_v2",
        assertion_event_contract_generation: "relation_assertion_event_v2",
        projection_count: 0,
        temporal_projection_selection_required: 1,
        temporal_projection_selected: 0,
        selection_id: null,
        projection_refresh_required: 0
      });
    } finally {
      database.close();
    }
  }, 30_000);
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

function seedTemporalMigrationsThrough(filename: string, maxVersion: number): void {
  const seed = new BetterSqlite3(filename);
  try {
    seed.pragma("foreign_keys = ON");
    const markApplied = seed.prepare(
      "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)"
    );
    for (const file of readMigrationInventory().files.filter(
      (candidate) => candidate.version >= 108 && candidate.version <= maxVersion
    )) {
      seed.transaction(() => {
        seed.exec(file.sql);
        if (file.version === 108) {
          migrateLegacyPathRelationsToTemporalCandidate(seed, { selectionRequired: false });
        }
        markApplied.run(file.version, `2026-07-17T00:01:${String(file.version).padStart(2, "0")}.000Z`);
      })();
    }
  } finally {
    seed.close();
  }
}

function seedLegacyRelationAssertion(filename: string): void {
  const seed = new BetterSqlite3(filename);
  try {
    seed.pragma("foreign_keys = ON");
    seed.transaction(() => {
      seed.prepare(`
        INSERT INTO workspaces (
          workspace_id, name, root_path, workspace_kind, default_engine_binding,
          workspace_state, created_at, archived_at
        ) VALUES ('workspace-legacy-assertion', 'Legacy assertion', '/tmp/legacy-assertion',
                  'local_repo', NULL, 'active', '2026-07-17T00:00:00.000Z', NULL)
      `).run();
      seed.prepare(`
        INSERT INTO relation_assertions (
          assertion_id, workspace_id, admission_event_id, identity_key,
          anchors_json, relation_kind, validity_json, admitted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "legacy-assertion",
        "workspace-legacy-assertion",
        "legacy-admission-event",
        "f".repeat(64),
        JSON.stringify({
          source_anchor: { kind: "object", object_id: "memory-a" },
          target_anchor: { kind: "object", object_id: "memory-b" }
        }),
        "supports",
        JSON.stringify({ kind: "open", valid_from: "2026-07-17T00:00:00.000Z" }),
        "2026-07-17T00:00:00.000Z"
      );
      seed.prepare(
        "INSERT INTO relation_assertion_evidence (assertion_id, evidence_id) VALUES (?, ?)"
      ).run("legacy-assertion", "legacy-evidence");
      seed.prepare(`
        INSERT INTO relation_assertions (
          assertion_id, workspace_id, admission_event_id, identity_key,
          anchors_json, relation_kind, validity_json, admitted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "legacy-assertion-other",
        "workspace-legacy-assertion",
        "legacy-admission-event-other",
        "e".repeat(64),
        JSON.stringify({
          source_anchor: { kind: "object", object_id: "memory-c" },
          target_anchor: { kind: "object", object_id: "memory-d" }
        }),
        "supports",
        JSON.stringify({ kind: "open", valid_from: "2026-07-17T00:00:00.000Z" }),
        "2026-07-17T00:00:00.000Z"
      );
      seed.prepare(
        "INSERT INTO relation_assertion_evidence (assertion_id, evidence_id) VALUES (?, ?)"
      ).run("legacy-assertion-other", "legacy-evidence-other");
      seed.prepare(`
        INSERT INTO relation_assertion_resolution_current (
          assertion_id, resolution_id, workspace_id, resolution_event_id,
          resolution_kind, resolved_at, reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        "legacy-assertion",
        "legacy-resolution",
        "workspace-legacy-assertion",
        "legacy-resolution-event",
        "retracted",
        "2026-07-17T01:00:00.000Z",
        "legacy resolution"
      );
      seed.prepare(`
        INSERT INTO relation_path_projections (
          generation, path_id, assertion_id, workspace_id, projection_json
        ) VALUES ('temporal-bootstrap-empty-v1', 'legacy-path', ?, ?, '{}')
      `).run("legacy-assertion", "workspace-legacy-assertion");
      seed.prepare(`
        UPDATE temporal_schema_state
        SET temporal_projection_selected = 1,
            selection_id = 'legacy-selection',
            selected_at = '2026-07-17T02:00:00.000Z'
        WHERE state_id = 1
      `).run();
    })();
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
