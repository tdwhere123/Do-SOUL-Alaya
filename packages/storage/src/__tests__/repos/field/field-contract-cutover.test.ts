import { afterEach, describe, expect, it } from "vitest";
import type { StorageDatabase } from "../../../sqlite/db.js";
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

afterEach(() => {
  for (const database of tracked) database.close();
  tracked.clear();
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

    const pointer = generations.activatePointer({
      workspace_id: "workspace-1",
      active_generation_id: first.generation_id,
      activated_at: CLOCK
    });
    expect(pointer.active_generation_id).toBe(first.generation_id);
    expect(generations.readActive("workspace-1")?.status).toBe("active");
    expect(generations.readActive("workspace-1")?.generation_id).toBe(first.generation_id);

    generations.activatePointer({
      workspace_id: "workspace-1",
      active_generation_id: second.generation_id,
      activated_at: "2026-08-16T01:00:00.000Z"
    });
    expect(generations.readActive("workspace-1")?.generation_id).toBe(second.generation_id);
    expect(generations.readPinned("workspace-1", first.generation_id)?.status).toBe("retired");
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
