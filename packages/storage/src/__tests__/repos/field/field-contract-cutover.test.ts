import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { initDatabase, StorageDatabase } from "../../../sqlite/db.js";
import {
  SqliteFieldEraseBarrierRepo,
  SqliteFieldFactorRepo,
  SqliteFieldProjectionGenerationRepo,
  SqliteFieldSourceRecordRepo
} from "../../../repos/field/index.js";
import {
  CLOCK,
  fieldSha256,
  hashedFactor,
  hashedGeneration,
  hashedRecord,
  openFieldDatabase
} from "./field-contract-fixture.js";

const tracked = new Set<StorageDatabase>();
const tempDirectories = new Set<string>();

afterEach(() => {
  for (const database of tracked) database.close();
  tracked.clear();
  for (const directory of tempDirectories) fs.rmSync(directory, { recursive: true, force: true });
  tempDirectories.clear();
});

describe("field contract cutover", () => {
  it("activates a pointer atomically so pointer and status agree", () => {
    const { generations } = createRepos();
    const first = generations.insert(hashedGeneration("workspace-1", "event-1", "shadow"));
    const second = generations.insert(hashedGeneration("workspace-1", "event-2", "verified"));

    expect(() => generations.activatePointer({
      workspace_id: "workspace-1",
      active_generation_id: "sha256:" + "d".repeat(64),
      activated_at: CLOCK
    })).toThrow(/missing/u);
    expect(generations.readActive("workspace-1")).toBeNull();

    expect(() => generations.activatePointer({
      workspace_id: "workspace-1",
      active_generation_id: first.generation_id,
      activated_at: CLOCK
    })).toThrow(/verified/u);
    expect(generations.readActive("workspace-1")).toBeNull();

    const pointer = generations.activatePointer({
      workspace_id: "workspace-1",
      active_generation_id: second.generation_id,
      activated_at: "2026-08-16T01:00:00.000Z"
    });
    expect(pointer.active_generation_id).toBe(second.generation_id);
    expect(generations.readActive("workspace-1")?.generation_id).toBe(second.generation_id);
    expect(generations.readPinned("workspace-1", first.generation_id)?.status).toBe("shadow");
  });

  it("refuses persistStatus on the live pointed generation", () => {
    const { generations } = createRepos();
    const first = generations.insert(hashedGeneration("workspace-1", "event-1", "verified"));
    generations.activatePointer({
      workspace_id: "workspace-1",
      active_generation_id: first.generation_id,
      activated_at: CLOCK
    });

    expect(() => generations.persistStatus(
      "workspace-1",
      first.generation_id,
      "retired"
    )).toThrow(/pointer|active generation/u);
    expect(generations.readActive("workspace-1")?.generation_id).toBe(first.generation_id);
    expect(generations.readActive("workspace-1")?.status).toBe("active");
  });

  it("releases one reader lease without releasing another", () => {
    const { generations } = createRepos();
    const generation = generations.insert(hashedGeneration("workspace-1", "event-1", "verified"));
    const first = projectionPin(generation.generation_id, "reader-1");
    const second = projectionPin(generation.generation_id, "reader-2");

    generations.pin(first);
    generations.pin(second);
    expect(generations.releasePin({
      workspace_id: first.workspace_id,
      generation_id: first.generation_id,
      reader_id: first.reader_id,
      released_at: "2026-08-16T00:01:00.000Z"
    }).released_at).toBe("2026-08-16T00:01:00.000Z");
    expect(generations.pin(second).released_at).toBeNull();
  });

  it("garbage-collects retired artifacts only after every live lease ends", () => {
    const { generations } = createRepos();
    const first = generations.insert(hashedGeneration("workspace-1", "event-1", "verified"));
    const second = generations.insert(hashedGeneration("workspace-1", "event-2", "verified"));
    generations.putArtifacts({
      workspace_id: "workspace-1",
      generation_id: first.generation_id,
      artifact_digest: `sha256:${"a".repeat(64)}`,
      artifacts_json: "{}",
      recorded_at: CLOCK
    });
    generations.activatePointer({
      workspace_id: "workspace-1",
      active_generation_id: first.generation_id,
      activated_at: CLOCK
    });
    const firstPin = projectionPin(first.generation_id, "reader-1");
    const secondPin = projectionPin(first.generation_id, "reader-2");
    generations.pin(firstPin);
    generations.pin(secondPin);
    generations.activatePointer({
      workspace_id: "workspace-1",
      active_generation_id: second.generation_id,
      activated_at: "2026-08-16T00:01:00.000Z"
    });

    expect(generations.collectRetired("workspace-1", "2026-08-16T00:02:00.000Z"))
      .toEqual([]);
    generations.releasePin({
      workspace_id: firstPin.workspace_id,
      generation_id: firstPin.generation_id,
      reader_id: firstPin.reader_id,
      released_at: "2026-08-16T00:03:00.000Z"
    });
    expect(generations.collectRetired("workspace-1", "2026-08-16T00:04:00.000Z"))
      .toEqual([]);
    expect(generations.collectRetired("workspace-1", "2026-08-16T00:05:00.000Z"))
      .toEqual([first.generation_id]);
    expect(generations.readPinned("workspace-1", first.generation_id)).toBeNull();
    expect(generations.readArtifacts("workspace-1", first.generation_id)).toBeNull();
  });

  it("serializes pointer cutover across independent file connections", () => {
    const { databaseA, databaseB, generationsA, generationsB } = createConcurrentGenerations();
    const first = generationsA.insert(hashedGeneration("workspace-1", "event-1", "verified"));
    const second = generationsA.insert(hashedGeneration("workspace-1", "event-2", "verified"));
    generationsA.activatePointer({
      workspace_id: "workspace-1",
      active_generation_id: first.generation_id,
      activated_at: CLOCK
    });

    databaseA.connection.exec("BEGIN IMMEDIATE");
    expect(generationsA.readActive("workspace-1")?.generation_id).toBe(first.generation_id);
    expect(() => generationsB.activatePointer({
      workspace_id: "workspace-1",
      active_generation_id: second.generation_id,
      activated_at: "2026-08-16T00:01:00.000Z"
    })).toThrow(/persist projection generation pointer/u);
    databaseA.connection.exec("ROLLBACK");

    generationsB.activatePointer({
      workspace_id: "workspace-1",
      active_generation_id: second.generation_id,
      activated_at: "2026-08-16T00:01:00.000Z"
    });
    expect(generationsA.readActive("workspace-1")?.generation_id).toBe(second.generation_id);
    expect(databaseB.connection.inTransaction).toBe(false);
  });

  it("fails closed on erase identity collision and does not wipe another subject", () => {
    const { records, factors, erase } = createRepos();
    const record = records.insert(hashedRecord("workspace-1", "visible body"));
    const other = records.insert(hashedRecord("workspace-1", "other body", "src-2"));
    const factor = factors.insertDescriptor(hashedFactor("workspace-1", "secret token"));

    erase.apply(eraseBarrier("barrier-1", "workspace-1", "source_record", record.record_id));
    expect(() => erase.apply(
      eraseBarrier("barrier-1", "workspace-1", "source_record", other.record_id)
    )).toThrow(/identity collision/u);
    expect(records.findById("workspace-1", record.record_id)?.source_body).toBeNull();
    expect(records.findById("workspace-1", other.record_id)?.source_body).toBe("other body");

    erase.apply(eraseBarrier("barrier-2", "workspace-1", "factor", factor.factor_id));
    expect(factors.findDescriptor("workspace-1", factor.factor_id)?.canonical_payload).toBeNull();
  });

  it("does not restore plaintext on replay and rejects admit after erase", () => {
    const { records, erase } = createRepos();
    const record = hashedRecord("workspace-1", "visible body");
    records.insert(record);
    erase.apply(eraseBarrier("barrier-1", "workspace-1", "source_record", record.record_id));

    expect(records.insert(record).source_body).toBeNull();
    expect(() => records.insert(hashedRecord("workspace-1", "fresh body", "src-new"))).not.toThrow();
    expect(() => records.insert({
      ...record,
      source_body: "restored"
    }).source_body).not.toBe("restored");
    expect(records.findById("workspace-1", record.record_id)?.source_body).toBeNull();

    const unseen = hashedRecord("workspace-2", "later body");
    erase.apply(eraseBarrier("barrier-3", "workspace-2", "source_record", unseen.record_id));
    expect(() => records.insert(unseen)).toThrow(/erased|CONFLICT|check failed/u);
  });

  it("does not erase workspace B when workspace A is tombstoned", () => {
    const { records, erase } = createRepos();
    const left = records.insert(hashedRecord("workspace-1", "shared body"));
    const right = records.insert(hashedRecord("workspace-2", "shared body"));
    erase.apply(eraseBarrier("barrier-a", "workspace-1", "source_record", left.record_id));

    expect(records.findById("workspace-1", left.record_id)?.source_body).toBeNull();
    expect(records.findById("workspace-2", right.record_id)?.source_body).toBe("shared body");
    expect(erase.findById("workspace-2", "barrier-a")).toBeNull();
  });

  it("rejects source plaintext that does not match its content digest", () => {
    const { records } = createRepos();
    const record = hashedRecord("workspace-1", "bound body");

    expect(() => records.insert({
      ...record,
      source_body: "different body"
    })).toThrow(/body digest/u);
    expect(records.findById("workspace-1", record.record_id)).toBeNull();
  });
});

function createRepos() {
  const database = openFieldDatabase();
  tracked.add(database);
  return {
    records: new SqliteFieldSourceRecordRepo(database, fieldSha256),
    factors: new SqliteFieldFactorRepo(database, fieldSha256),
    generations: new SqliteFieldProjectionGenerationRepo(database, fieldSha256),
    erase: new SqliteFieldEraseBarrierRepo(database, fieldSha256)
  };
}

function eraseBarrier(
  barrierId: string,
  workspaceId: string,
  subjectKind: "source_record" | "factor",
  subjectId: string
) {
  return {
    barrier_id: barrierId,
    workspace_id: workspaceId,
    generation_id: null,
    subject_kind: subjectKind,
    subject_id: subjectId,
    erased_at: CLOCK
  };
}

function projectionPin(generationId: string, readerId: string) {
  return {
    workspace_id: "workspace-1",
    generation_id: generationId,
    reader_id: readerId,
    pinned_at: CLOCK,
    expires_at: "2026-08-16T00:05:00.000Z",
    released_at: null
  } as const;
}

function createConcurrentGenerations() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "field-generation-race-"));
  const filename = path.join(directory, "alaya.db");
  tempDirectories.add(directory);
  const seed = initDatabase({ filename });
  seedWorkspace(seed);
  seed.close();
  const databaseA = independentDatabase(filename, 5_000);
  const databaseB = independentDatabase(filename, 0);
  return {
    databaseA,
    databaseB,
    generationsA: new SqliteFieldProjectionGenerationRepo(databaseA, fieldSha256),
    generationsB: new SqliteFieldProjectionGenerationRepo(databaseB, fieldSha256)
  };
}

function independentDatabase(filename: string, busyTimeoutMs: number): StorageDatabase {
  const connection = new BetterSqlite3(filename);
  connection.pragma("foreign_keys = ON");
  connection.pragma("journal_mode = WAL");
  connection.pragma(`busy_timeout = ${busyTimeoutMs}`);
  const database = new StorageDatabase(filename, connection);
  tracked.add(database);
  return database;
}

function seedWorkspace(database: StorageDatabase): void {
  database.connection.prepare(`
    INSERT INTO workspaces (
      workspace_id, name, root_path, workspace_kind, default_engine_binding,
      workspace_state, created_at, archived_at, default_engine_class
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "workspace-1", "Field workspace", "/tmp/workspace-1", "local_repo",
    null, "active", CLOCK, null, null
  );
}
