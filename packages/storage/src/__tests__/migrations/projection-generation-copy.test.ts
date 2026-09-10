import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initDatabase, readSchemaMigrationLedger, type StorageDatabase } from "../../index.js";
import { SqliteEventLogRepo } from "../../repos/runtime/event-log-repo.js";
import { SqliteFieldProjectionGenerationRepo } from "../../repos/field/generation-repo.js";
import { SqliteFieldSourceRecordRepo } from "../../repos/field/source-repo.js";
import {
  CLOCK,
  fieldSha256,
  hashedGeneration,
  hashedRecord,
  seedWorkspaces
} from "../repos/field/field-contract-fixture.js";

const tracked = new Set<StorageDatabase>();
const roots = new Set<string>();

afterEach(() => {
  for (const database of tracked) database.close();
  tracked.clear();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe("projection generation copy and pointer switch", () => {
  it("does not activate mixed or unverified generations on a copied store", async () => {
    const root = mkdtempSync(join(tmpdir(), "alaya-generation-copy-"));
    roots.add(root);
    const filename = join(root, "field.sqlite");
    const original = initDatabase({ filename });
    tracked.add(original);
    seedWorkspaces(original);
    const records = new SqliteFieldSourceRecordRepo(original, fieldSha256);
    const generations = new SqliteFieldProjectionGenerationRepo(original, fieldSha256);
    const events = new SqliteEventLogRepo(original);
    const record = records.insert(hashedRecord("workspace-1", "immutable source body"));
    const retained = events.append({
      event_type: "soul.field.source_record.admitted",
      entity_type: "source_record",
      entity_id: record.record_id,
      workspace_id: "workspace-1",
      run_id: null,
      caused_by: "test",
      payload_json: { record_id: record.record_id }
    });
    if (retained instanceof Promise) throw new Error("event log append must stay synchronous in this copy probe");
    const shadow = generations.insert(hashedGeneration("workspace-1", "event-1", "shadow"));
    const second = generations.insert(hashedGeneration("workspace-1", "event-2", "shadow"));
    expect(readSchemaMigrationLedger(filename).at(-1)).toBe(13);
    expect(readSchemaMigrationLedger(filename)).toContain(13);
    original.close();
    tracked.delete(original);

    const copy = join(root, "field-copy.sqlite");
    copyFileSync(filename, copy);
    for (const suffix of ["-wal", "-shm"] as const) {
      if (existsSync(`${filename}${suffix}`)) copyFileSync(`${filename}${suffix}`, `${copy}${suffix}`);
    }
    const copied = initDatabase({ filename: copy });
    tracked.add(copied);
    const copiedGenerations = new SqliteFieldProjectionGenerationRepo(copied, fieldSha256);
    const copiedRecords = new SqliteFieldSourceRecordRepo(copied, fieldSha256);
    const copiedEvents = new SqliteEventLogRepo(copied);

    expect(copiedRecords.findById("workspace-1", record.record_id)?.source_body)
      .toBe("immutable source body");
    const copiedHistory = await copiedEvents.queryByEntity("source_record", record.record_id);
    expect(copiedHistory.some((row) => row.event_id === retained.event_id)).toBe(true);
    expect(() => copiedGenerations.readByGenerationIds("workspace-1", [
      shadow.generation_id,
      second.generation_id
    ])).toThrow(/mixed generation/u);
    expect(() => copiedGenerations.activatePointer({
      workspace_id: "workspace-1",
      active_generation_id: shadow.generation_id,
      activated_at: CLOCK
    })).toThrow(/verified/u);
    copiedGenerations.persistStatus("workspace-1", shadow.generation_id, "verified");
    const pointer = copiedGenerations.activatePointer({
      workspace_id: "workspace-1",
      active_generation_id: shadow.generation_id,
      activated_at: CLOCK
    });
    expect(pointer.active_generation_id).toBe(shadow.generation_id);
    expect(copiedGenerations.readActive("workspace-1")?.status).toBe("active");

    const rereadOriginal = initDatabase({ filename });
    tracked.add(rereadOriginal);
    const originalGenerations = new SqliteFieldProjectionGenerationRepo(rereadOriginal, fieldSha256);
    expect(originalGenerations.readActive("workspace-1")).toBeNull();
    expect(originalGenerations.readPinned("workspace-1", shadow.generation_id)?.status).toBe("shadow");
  });
});
