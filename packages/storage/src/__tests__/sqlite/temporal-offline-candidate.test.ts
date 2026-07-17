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
import { prepareTemporalCandidate } from "../../sqlite/temporal-offline-candidate.js";
import {
  inspectTemporalProjectionSelection,
  isTemporalProjectionSelected,
  rollbackTemporalProjection,
  selectTemporalProjection
} from "../../sqlite/temporal-projection-selection.js";
import { SqlitePathRelationRepo } from "../../repos/path/path-relation-repo.js";

interface CandidateFixture {
  readonly directory: string;
  readonly sourceFilename: string;
  readonly candidateFilename: string;
  readonly receiptFilename: string;
}

describe("prepareTemporalCandidate", () => {
  let fixture: CandidateFixture;

  beforeEach(() => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "alaya-temporal-candidate-"));
    fixture = {
      directory,
      sourceFilename: path.join(directory, "legacy.db"),
      candidateFilename: path.join(directory, "candidate.db"),
      receiptFilename: path.join(directory, "candidate-receipt.json")
    };
  });

  afterEach(() => {
    closeCachedDatabase(fixture.sourceFilename);
    closeCachedDatabase(fixture.candidateFilename);
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  });

  it("copies a legacy source, quarantines every untyped path, and retains the original", async () => {
    seedLegacySource(fixture.sourceFilename);
    const sourceHash = fileSha256(fixture.sourceFilename);
    const sourceLedger = readSchemaMigrationLedger(fixture.sourceFilename);

    const result = await prepareTemporalCandidate({
      sourceFilename: fixture.sourceFilename,
      candidateFilename: fixture.candidateFilename,
      receiptFilename: fixture.receiptFilename
    });

    expect(result.selected).toBe(false);
    expect(result.source.schemaVersions).toEqual(sourceLedger);
    expect(result.quarantine).toMatchObject({ convertedCount: 0, quarantinedCount: 2 });
    expect(fileSha256(fixture.sourceFilename)).toBe(sourceHash);
    expect(readSchemaMigrationLedger(fixture.sourceFilename)).toEqual(sourceLedger);
    expect(readSchemaMigrationLedger(fixture.candidateFilename).at(-1)).toBe(108);

    const candidate = new BetterSqlite3(fixture.candidateFilename, { readonly: true });
    try {
      expect(candidate.prepare("SELECT COUNT(*) AS count FROM relation_assertions").get()).toEqual({ count: 0 });
      expect(candidate.prepare("SELECT COUNT(*) AS count FROM relation_assertion_quarantine").get()).toEqual({ count: 2 });
    } finally {
      candidate.close();
    }

    const receipt = JSON.parse(fs.readFileSync(fixture.receiptFilename, "utf8")) as Record<string, unknown>;
    expect(receipt).toMatchObject({
      status: "prepared",
      selected: false,
      quarantine: { converted_count: 0, quarantined_count: 2 }
    });

    expect(() => initDatabase({ filename: fixture.candidateFilename }))
      .toThrow(/not selected/);
    const candidateMode = initDatabase({
      filename: fixture.candidateFilename,
      temporalMode: "candidate"
    });
    try {
      expect(inspectTemporalProjectionSelection(candidateMode)).toMatchObject({
        selectionRequired: true,
        selected: false
      });
      expect(() => initDatabase({ filename: fixture.candidateFilename }))
        .toThrow(/not selected/);
    } finally {
      candidateMode.close();
    }
  });

  it("rejects an in-place candidate path before mutating the legacy source", async () => {
    seedLegacySource(fixture.sourceFilename);
    const sourceHash = fileSha256(fixture.sourceFilename);

    await expect(prepareTemporalCandidate({
      sourceFilename: fixture.sourceFilename,
      candidateFilename: fixture.sourceFilename,
      receiptFilename: fixture.receiptFilename
    })).rejects.toThrow(/must be distinct/);

    expect(fileSha256(fixture.sourceFilename)).toBe(sourceHash);
    expect(fs.existsSync(fixture.receiptFilename)).toBe(false);
  });

  it("keeps fresh bootstrap as an explicit legacy-compatible pre-cutover state", () => {
    const ephemeral = initDatabase();
    try {
      expect(isTemporalProjectionSelected(ephemeral)).toBe(false);
      seedWorkspace(ephemeral.connection);
      expect(() => insertLegacyPath(ephemeral.connection, "ephemeral-path")).not.toThrow();
    } finally {
      ephemeral.close();
    }

    const freshFilename = path.join(fixture.directory, "fresh-bootstrap.db");
    const fresh = initDatabase({ filename: freshFilename });
    try {
      expect(inspectTemporalProjectionSelection(fresh)).toMatchObject({
        schema: "temporal",
        selectionRequired: false,
        selected: false
      });
    } finally {
      fresh.close();
    }
    const reopened = initDatabase({ filename: freshFilename });
    try {
      expect(inspectTemporalProjectionSelection(reopened)).toMatchObject({
        schema: "temporal",
        selectionRequired: false,
        selected: false
      });
    } finally {
      reopened.close();
    }
  });

  it("seals a WAL-backed source snapshot without selecting or changing its source files", async () => {
    seedLegacySource(fixture.sourceFilename);
    const writer = new BetterSqlite3(fixture.sourceFilename);
    try {
      writer.pragma("journal_mode = WAL");
      insertLegacyPath(writer, "legacy-path-wal");
      const sourceBefore = sourceFileSet(fixture.sourceFilename);

      const result = await prepareTemporalCandidate({
        sourceFilename: fixture.sourceFilename,
        candidateFilename: fixture.candidateFilename,
        receiptFilename: fixture.receiptFilename
      });

      expect(sourceBefore.some((entry) => entry.role === "wal")).toBe(true);
      expect(sourceFileSet(fixture.sourceFilename)).toEqual(sourceBefore);
      expect(result.quarantine).toMatchObject({ convertedCount: 0, quarantinedCount: 3 });
      expect(readSchemaMigrationLedger(fixture.candidateFilename).at(-1)).toBe(108);
    } finally {
      writer.close();
    }
  });

  it("permits legacy path mutations until an operator explicitly selects the temporal projection", async () => {
    seedLegacySource(fixture.sourceFilename);
    const sourceBefore = sourceFileSet(fixture.sourceFilename);
    await prepareTemporalCandidate({
      sourceFilename: fixture.sourceFilename,
      candidateFilename: fixture.candidateFilename,
      receiptFilename: fixture.receiptFilename
    });

    const candidateConnection = new BetterSqlite3(fixture.candidateFilename);
    try {
      expect(candidateConnection.prepare(
        "UPDATE path_relations SET updated_at = ? WHERE path_id = ?"
      ).run("2026-07-17T01:00:00.000Z", "legacy-path-1").changes).toBe(1);
    } finally {
      candidateConnection.close();
    }

    const candidate = initDatabase({
      filename: fixture.candidateFilename,
      temporalMode: "candidate"
    });
    try {
      expect(inspectTemporalProjectionSelection(candidate)).toMatchObject({
        schema: "temporal",
        selectionRequired: true,
        selected: false,
        audit: []
      });
      expect(() => selectTemporalProjection(candidate, {
        receiptFilename: fixture.receiptFilename,
        reason: "test candidate must reconcile before selection"
      })).toThrow(/no longer matches its prepared receipt seal/);
    } finally {
      candidate.close();
    }
    expect(sourceFileSet(fixture.sourceFilename)).toEqual(sourceBefore);
  });

  it("validates the candidate gate before it can flip the selected state", async () => {
    seedLegacySource(fixture.sourceFilename);
    const sourceBefore = sourceFileSet(fixture.sourceFilename);
    await prepareTemporalCandidate({
      sourceFilename: fixture.sourceFilename,
      candidateFilename: fixture.candidateFilename,
      receiptFilename: fixture.receiptFilename
    });

    const candidate = initDatabase({
      filename: fixture.candidateFilename,
      temporalMode: "candidate"
    });
    try {
      candidate.connection.prepare(
        "UPDATE temporal_schema_state SET status = 'mixed' WHERE state_id = 1"
      ).run();

      expect(() => selectTemporalProjection(candidate, {
        receiptFilename: fixture.receiptFilename,
        reason: "test gate before selection"
      })).toThrow(/schema is missing, unknown, or mixed/);
      expect(inspectTemporalProjectionSelection(candidate)).toMatchObject({
        selectionRequired: true,
        selected: false,
        audit: []
      });
      expect(sourceFileSet(fixture.sourceFilename)).toEqual(sourceBefore);
    } finally {
      candidate.close();
    }
  });

  it("fails closed when a selected candidate loses its active generation", async () => {
    await prepareAndSelectCandidate(fixture);
    tamperTemporalState(fixture.candidateFilename,
      "UPDATE temporal_schema_state SET active_projection_generation = 'missing-generation' WHERE state_id = 1");
    const before = fileSha256(fixture.candidateFilename);

    expect(() => initDatabase({ filename: fixture.candidateFilename }))
      .toThrow(/Temporal relation schema is missing, unknown, or mixed/);
    expect(fileSha256(fixture.candidateFilename)).toBe(before);
  });

  it("fails closed when selected state disagrees with its active generation tuple", async () => {
    await prepareAndSelectCandidate(fixture);
    tamperTemporalState(fixture.candidateFilename,
      "UPDATE temporal_schema_state SET projection_digest = ? WHERE state_id = 1",
      "0".repeat(64));
    const before = fileSha256(fixture.candidateFilename);

    expect(() => initDatabase({ filename: fixture.candidateFilename }))
      .toThrow(/Temporal relation schema is missing, unknown, or mixed/);
    expect(fileSha256(fixture.candidateFilename)).toBe(before);
  });

  it("fails closed when selected projection rows differ from their recorded count", async () => {
    await prepareAndSelectCandidate(fixture);
    const database = new BetterSqlite3(fixture.candidateFilename);
    try {
      const state = database.prepare("SELECT active_projection_generation AS generation FROM temporal_schema_state WHERE state_id = 1")
        .get() as { readonly generation: string };
      database.pragma("foreign_keys = OFF");
      database.prepare("INSERT INTO relation_path_projections (generation, path_id, assertion_id, workspace_id, projection_json) VALUES (?, ?, ?, ?, ?)")
        .run(state.generation, "tampered-path", "tampered-assertion", "workspace-1", "{}");
    } finally { database.close(); }
    const before = fileSha256(fixture.candidateFilename);
    expect(() => initDatabase({ filename: fixture.candidateFilename }))
      .toThrow(/Temporal relation schema is missing, unknown, or mixed/);
    expect(fileSha256(fixture.candidateFilename)).toBe(before);
  });

  it("persists explicit selection, blocks raw and repository legacy access, and audits rollback", async () => {
    seedLegacySource(fixture.sourceFilename);
    const sourceBefore = sourceFileSet(fixture.sourceFilename);
    await prepareTemporalCandidate({
      sourceFilename: fixture.sourceFilename,
      candidateFilename: fixture.candidateFilename,
      receiptFilename: fixture.receiptFilename
    });
    const candidateMode = initDatabase({
      filename: fixture.candidateFilename,
      temporalMode: "candidate"
    });
    try {
      const selected = selectTemporalProjection(candidateMode, {
        receiptFilename: fixture.receiptFilename,
        reason: "test explicit temporal projection selection"
      });
      expect(selected).toMatchObject({
        schema: "temporal",
        selectionRequired: true,
        selected: true
      });
      expect(selected.selectionId).toEqual(expect.any(String));
      expect(selected.audit).toHaveLength(1);
      expect(sourceFileSet(fixture.sourceFilename)).toEqual(sourceBefore);
      expect(initDatabase({ filename: fixture.candidateFilename })).toBe(candidateMode);

      candidateMode.close();
      const runtime = initDatabase({ filename: fixture.candidateFilename });
      try {
        expect(isTemporalProjectionSelected(runtime)).toBe(true);

        const raw = new BetterSqlite3(fixture.candidateFilename);
        try {
          expect(() => raw.prepare(
            "UPDATE path_relations SET updated_at = ? WHERE path_id = ?"
          ).run("2026-07-17T02:00:00.000Z", "legacy-path-1")).toThrow(/Legacy path relation writes are disabled/);
          expect(() => raw.prepare("DELETE FROM path_relations WHERE path_id = ?").run("legacy-path-1"))
            .toThrow(/Legacy path relation writes are disabled/);
          expect(() => raw.prepare(`
            INSERT INTO path_relations (
              path_id, workspace_id, anchors_json, constitution_json,
              effect_vector_json, plasticity_state_json, lifecycle_json, legitimacy_json,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            "legacy-path-insert",
            "workspace-1",
            JSON.stringify({
              source_anchor: { kind: "object", object_id: "memory-a" },
              target_anchor: { kind: "object", object_id: "memory-b" }
            }),
            JSON.stringify({ relation_kind: "supports", why_this_relation_exists: ["legacy"] }),
            JSON.stringify({ salience: 0.5, recall_bias: 0.5 }),
            JSON.stringify({ strength: 0.3, stability_class: "stable" }),
            JSON.stringify({ status: "active", retirement_rule: "manual" }),
            JSON.stringify({ evidence_basis: ["legacy"], governance_class: "attention_only" }),
            "2026-07-17T00:00:00.000Z",
            "2026-07-17T00:00:00.000Z"
          )).toThrow(/Legacy path relation writes are disabled/);
        } finally {
          raw.close();
        }

        const repo = new SqlitePathRelationRepo(runtime);
        expect(() => repo.update("legacy-path-1", {
          updated_at: "2026-07-17T03:00:00.000Z"
        })).toThrow(/Legacy path relation writes are disabled/);
        await expect(repo.delete("legacy-path-1")).rejects.toThrow(/Legacy path relation writes are disabled/);
        await expect(repo.findByWorkspace("workspace-1")).rejects.toThrow(/Legacy path relation reads are disabled/);

        const reloaded = inspectTemporalProjectionSelection(runtime);
        expect(reloaded).toMatchObject({
          schema: "temporal",
          selected: true,
          selectionId: selected.selectionId
        });
        expect(reloaded.audit).toHaveLength(1);

        const rolledBack = rollbackTemporalProjection(runtime, {
          receiptFilename: fixture.receiptFilename,
          expectedSelectionId: selected.selectionId!,
          reason: "test rollback"
        });
        expect(rolledBack).toMatchObject({ schema: "temporal", selected: false });
        expect(rolledBack.audit).toHaveLength(2);
        expect(sourceFileSet(fixture.sourceFilename)).toEqual(sourceBefore);

        const reopened = new BetterSqlite3(fixture.candidateFilename);
        try {
          expect(reopened.prepare(
            "UPDATE path_relations SET updated_at = ? WHERE path_id = ?"
          ).run("2026-07-17T04:00:00.000Z", "legacy-path-1").changes).toBe(1);
        } finally {
          reopened.close();
        }
      } finally {
        runtime.close();
      }
    } finally {
      if (!candidateMode.isClosed()) candidateMode.close();
    }
  });
});

async function prepareAndSelectCandidate(fixture: CandidateFixture): Promise<void> {
  seedLegacySource(fixture.sourceFilename);
  await prepareTemporalCandidate({
    sourceFilename: fixture.sourceFilename,
    candidateFilename: fixture.candidateFilename,
    receiptFilename: fixture.receiptFilename
  });
  const candidate = initDatabase({ filename: fixture.candidateFilename, temporalMode: "candidate" });
  try {
    selectTemporalProjection(candidate, {
      receiptFilename: fixture.receiptFilename,
      reason: "test selected candidate projection gate"
    });
  } finally {
    candidate.close();
  }
}

function tamperTemporalState(filename: string, sql: string, ...params: readonly unknown[]): void {
  const database = new BetterSqlite3(filename);
  try {
    database.prepare(sql).run(...params);
  } finally {
    database.close();
  }
}

function seedLegacySource(filename: string): void {
  const database = new BetterSqlite3(filename);
  try {
    database.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    const markApplied = database.prepare(
      "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)"
    );
    for (const migration of migrationFilesThrough(107)) {
      database.transaction(() => {
        database.exec(migration.sql);
        markApplied.run(migration.version, "2026-07-17T00:00:00.000Z");
      })();
    }
    seedWorkspace(database);
    for (const pathId of ["legacy-path-1", "legacy-path-2"]) {
      insertLegacyPath(database, pathId);
    }
  } finally {
    database.close();
  }
}

function seedWorkspace(database: BetterSqlite3.Database): void {
  database.prepare(`
      INSERT INTO workspaces (
        workspace_id, name, root_path, workspace_kind,
        default_engine_binding, workspace_state, created_at, archived_at, default_engine_class
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "workspace-1",
      "Temporal candidate fixture",
      "/tmp/temporal-candidate-fixture",
      "local_repo",
      null,
      "active",
      "2026-07-17T00:00:00.000Z",
      null,
      null
    );
}

function insertLegacyPath(database: BetterSqlite3.Database, pathId: string): void {
  database.prepare(`
    INSERT INTO path_relations (
      path_id, workspace_id, anchors_json, constitution_json,
      effect_vector_json, plasticity_state_json, lifecycle_json, legitimacy_json,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    pathId,
    "workspace-1",
    JSON.stringify({
      source_anchor: { kind: "object", object_id: "memory-a" },
      target_anchor: { kind: "object", object_id: "memory-b" }
    }),
    JSON.stringify({ relation_kind: "supports", why_this_relation_exists: ["legacy"] }),
    JSON.stringify({ salience: 0.5, recall_bias: 0.5 }),
    JSON.stringify({ strength: 0.3, stability_class: "stable" }),
    JSON.stringify({ status: "active", retirement_rule: "manual" }),
    JSON.stringify({ evidence_basis: ["legacy"], governance_class: "attention_only" }),
    "2026-07-17T00:00:00.000Z",
    "2026-07-17T00:00:00.000Z"
  );
}

function migrationFilesThrough(maxVersion: number): readonly { readonly version: number; readonly sql: string }[] {
  const migrationsDirectory = fileURLToPath(new URL("../../migrations", import.meta.url));
  return fs.readdirSync(migrationsDirectory)
    .map((name) => ({ name, match: /^(\d+)-.+\.sql$/u.exec(name) }))
    .filter((entry): entry is { readonly name: string; readonly match: RegExpExecArray } => entry.match !== null)
    .map(({ name, match }) => ({
      version: Number(match[1]),
      sql: fs.readFileSync(path.join(migrationsDirectory, name), "utf8")
    }))
    .filter((migration) => migration.version <= maxVersion)
    .sort((left, right) => left.version - right.version);
}

function fileSha256(filename: string): string {
  return createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}

function sourceFileSet(filename: string): readonly { readonly role: string; readonly sha256: string }[] {
  return ["database", "journal", "wal"].flatMap((role) => {
    const part = role === "database" ? filename : `${filename}-${role}`;
    return fs.existsSync(part) ? [{ role, sha256: fileSha256(part) }] : [];
  });
}
