import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { CandidateMemorySignalSchema, SOURCE_INTERPRETATION_CONTRACT } from "@do-soul/alaya-protocol";
import { initDatabase, StorageDatabase } from "../../sqlite/db.js";
import { SqliteSignalRepo } from "../../repos/signal/signal-repo.js";
import { migrateLegacyPathRelationsToTemporalCandidate } from "../../sqlite/temporal-cutover-gate.js";
import { applyBaselineSql, seedWorkspaceRow, insertMemoryEntryRow } from "./apply-baseline.js";
import { removeTempDirectorySync } from "../temp-directory.js";

const roots: string[] = [];
const databases = new Set<StorageDatabase>();
const timestamp = "2026-09-14T00:00:00.000Z";
afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
  for (const root of roots.splice(0)) removeTempDirectorySync(root);
});

describe("source observation signal migration", () => {
  it("preserves historical bytes and foreign keys, then reopens null observation fields", async () => {
    const root = mkdtempSync(join(tmpdir(), "alaya-observation-migration-"));
    roots.push(root);
    const filename = join(root, "memory.db");
    const old = new StorageDatabase(filename, new BetterSqlite3(filename));
    applyBaselineSql(old.connection, 15);
    migrateLegacyPathRelationsToTemporalCandidate(old.connection, { selectionRequired: false });
    old.connection.exec("CREATE TABLE schema_version(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    for (let version = 1; version <= 15; version++) {
      old.connection.prepare("INSERT INTO schema_version VALUES (?, ?)").run(version, timestamp);
    }
    seedWorkspaceRow(old.connection, "workspace-1");
    old.connection.prepare(`INSERT INTO runs(run_id, workspace_id, title, run_mode, created_at, last_active_at)
      VALUES ('run-1', 'workspace-1', 'run', 'chat', ?, ?)`).run(timestamp, timestamp);
    const raw = '{ "excerpt": "A sent mail." }';
    old.connection.prepare(`INSERT INTO signals(signal_id, workspace_id, run_id, source, signal_kind,
      object_kind, domain_tags_json, confidence, evidence_refs_json, raw_payload_json, created_at)
      VALUES ('old-signal', 'workspace-1', 'run-1', 'model_tool', 'potential_claim', 'fact', '[]', 0.7, '[]', ?, ?)`)
      .run(raw, timestamp);
    insertMemoryEntryRow(old.connection, "old-memory", "old memory content");
    const oldRowid = old.connection.prepare("SELECT rowid FROM memory_entries WHERE object_id='old-memory'").get();
    old.close({ optimize: false });

    let database = initDatabase({ filename });
    databases.add(database);
    expect(database.connection.pragma("foreign_key_check")).toEqual([]);
    expect(database.connection.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(database.connection.prepare("SELECT rowid FROM memory_entries WHERE object_id='old-memory'").get()).toEqual(oldRowid);
    expect(database.connection.prepare("SELECT raw_payload_json FROM signals WHERE signal_id='old-signal'").get()).toEqual({ raw_payload_json: raw });
    const oldSignal = await new SqliteSignalRepo(database).getById("old-signal");
    expect(oldSignal).toMatchObject({ confidence: 0.7, object_kind: "fact" });
    expect(oldSignal).not.toHaveProperty("interpretation_contract");

    const observation = CandidateMemorySignalSchema.parse({
      ...oldSignal, signal_id: "observation", source: "garden_compile",
      signal_kind: "potential_semantic_observation", object_kind: null, confidence: null,
      interpretation_contract: SOURCE_INTERPRETATION_CONTRACT,
      source_observation: { observed_at: timestamp, authority: "trusted_host_event", source_event_id: "event-1" },
      raw_payload: { source_interpretation: {
        contract: SOURCE_INTERPRETATION_CONTRACT, artifact_key: "artifact-1", source_corpus_digest: "a".repeat(64),
        assertion_binding: { assertion_id: 1, source_span: [0, 12], text: "A sent mail.", context_id: "context-1" },
        outcome: "empty", candidates: [], diagnostics: []
      } }
    });
    await new SqliteSignalRepo(database).create(observation);
    database.connection.prepare("UPDATE memory_entries SET dimension='observation', confidence=NULL, retention_score=0.5, activation_score=0.3 WHERE object_id='old-memory'").run();
    expect(() => database.connection.prepare("UPDATE signals SET confidence=1 WHERE signal_id='observation'").run()).toThrow(/CHECK/);
    expect(() => database.connection.prepare("UPDATE signals SET confidence=NULL WHERE signal_id='old-signal'").run()).toThrow(/CHECK/);
    expect(() => database.connection.prepare("UPDATE signals SET interpretation_contract='unknown' WHERE signal_id='observation'").run()).toThrow(/CHECK/);
    database.close();
    databases.delete(database);
    database = initDatabase({ filename });
    databases.add(database);
    expect(await new SqliteSignalRepo(database).getById("observation")).toEqual(observation);
    expect(await new SqliteSignalRepo(database).getById("old-signal")).toEqual(oldSignal);
    expect(database.connection.prepare("SELECT dimension, confidence, retention_score, activation_score FROM memory_entries WHERE object_id='old-memory'").get())
      .toEqual({ dimension: "observation", confidence: null, retention_score: 0.5, activation_score: 0.3 });
    expect(database.connection.prepare("SELECT object_id FROM memory_content_fts WHERE memory_content_fts MATCH 'content'").all())
      .toEqual([{ object_id: "old-memory" }]);
    expect(database.connection.pragma("foreign_key_check")).toEqual([]);
    expect(database.connection.prepare("SELECT max(version) AS version FROM schema_version").get()).toEqual({ version: 17 });
    // File-backed upgrade-and-reopen exceeds 5s under coverage remap and on NTFS.
  }, process.platform === "win32" ? 180_000 : 60_000);
});
