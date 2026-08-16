import { afterEach, describe, expect, it } from "vitest";
import { initDatabase, type StorageDatabase } from "../../../sqlite/db.js";
import {
  SqliteFieldCausalUsageRepo,
  SqliteFieldEraseBarrierRepo,
  SqliteFieldFactorRepo,
  SqliteFieldProjectionGenerationRepo,
  SqliteFieldProofEffectRepo,
  SqliteFieldSourceRecordRepo,
  SqliteFieldSourceSpanRepo
} from "../../../repos/field/index.js";

const CLOCK = "2026-08-16T00:00:00.000Z";
const tracked = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of tracked) database.close();
  tracked.clear();
});

describe("field contract repos", () => {
  it("replays the same identity insert and isolates generations", () => {
    const { records, spans, generations } = createRepos();
    const record = records.insert(sourceRecord("record-1", "visible body"));
    expect(records.insert(sourceRecord("record-1", "visible body"))).toEqual(record);
    expect(() => records.insert(sourceRecord("record-1", "other body", "src-2")))
      .toThrow(/identity collision/u);

    const span = spans.insert(sourceSpan("span-1", "record-1"));
    expect(spans.insert(sourceSpan("span-1", "record-1"))).toEqual(span);

    generations.insert(generation("gen-a", "shadow"));
    generations.insert(generation("gen-b", "shadow"));
    expect(() => generations.insert(generation("gen-c", "active"))).toThrow(/pointer swap/u);
    expect(() => generations.persistStatus("gen-a", "active")).toThrow(/pointer swap/u);

    expect(generations.activatePointer({
      workspace_id: "workspace-1",
      active_generation_id: "gen-a",
      activated_at: CLOCK
    }).active_generation_id).toBe("gen-a");
    expect(generations.readActive("workspace-1")?.generation_id).toBe("gen-a");
    expect(generations.readPinned("workspace-1", "gen-b")?.generation_id).toBe("gen-b");
    expect(() => generations.readByGenerationIds("workspace-1", ["gen-a", "gen-b"]))
      .toThrow(/mixed generation/u);

    generations.activatePointer({
      workspace_id: "workspace-1",
      active_generation_id: "gen-b",
      activated_at: "2026-08-16T01:00:00.000Z"
    });
    expect(generations.readActive("workspace-1")?.generation_id).toBe("gen-b");
    expect(generations.readPinned("workspace-1", "gen-a")?.status).toBe("retired");
  });

  it("erases plaintext from new tables and rejects inverted spans or delivery learning", () => {
    const { records, factors, erase, usage } = createRepos();
    records.insert(sourceRecord("record-1", "visible body"));
    factors.insertDescriptor({
      factor_id: "factor-1",
      family: "f0",
      canonical_payload: "secret token",
      operator_version: "factor_incidence_v1"
    });

    erase.apply({
      barrier_id: "barrier-1",
      workspace_id: "workspace-1",
      generation_id: null,
      subject_kind: "source_record",
      subject_id: "record-1",
      erased_at: CLOCK
    });
    erase.apply({
      barrier_id: "barrier-2",
      workspace_id: "workspace-1",
      generation_id: null,
      subject_kind: "factor",
      subject_id: "factor-1",
      erased_at: CLOCK
    });

    expect(records.findById("record-1")?.source_body).toBeNull();
    expect(factors.findDescriptor("factor-1")?.canonical_payload).toBeNull();
    expect(Object.keys(erase.findById("barrier-1") ?? {})).not.toEqual(
      expect.arrayContaining(["excerpt", "payload", "embedding", "factor_text", "source_body"])
    );
    expect(() => usage.insert({
      receipt_id: "usage-1",
      workspace_id: "workspace-1",
      causal_key: "use-1",
      occurred_at: CLOCK,
      downstream_ref: "path-1",
      weight: 0.2,
      scope: "workspace-1",
      usage_kind: "delivery"
    })).toThrow(/check failed|CHECK constraint failed/u);
  });
});

function createRepos() {
  const database = initDatabase({ filename: ":memory:" });
  tracked.add(database);
  seedWorkspace(database);
  return {
    records: new SqliteFieldSourceRecordRepo(database),
    spans: new SqliteFieldSourceSpanRepo(database),
    factors: new SqliteFieldFactorRepo(database),
    generations: new SqliteFieldProjectionGenerationRepo(database),
    erase: new SqliteFieldEraseBarrierRepo(database),
    usage: new SqliteFieldCausalUsageRepo(database),
    effects: new SqliteFieldProofEffectRepo(database)
  };
}

function seedWorkspace(database: StorageDatabase): void {
  database.connection.prepare(`
    INSERT INTO workspaces (
      workspace_id, name, root_path, workspace_kind, default_engine_binding,
      workspace_state, created_at, archived_at, default_engine_class
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "workspace-1",
    "Field Contract Workspace",
    "/tmp/workspace-1",
    "local_repo",
    null,
    "active",
    CLOCK,
    null,
    null
  );
}

function sourceRecord(
  recordId: string,
  sourceBody: string,
  sourceId = "src-1"
) {
  return {
    record_id: recordId,
    workspace_id: "workspace-1",
    source_id: sourceId,
    source_version: "v1",
    content_digest: "sha256:" + "a".repeat(64),
    evidence_object_id: null,
    recorded_at: CLOCK,
    operator_version: "source_span_identity_v1",
    source_body: sourceBody
  };
}

function sourceSpan(spanId: string, recordId: string) {
  return {
    span_id: spanId,
    record_id: recordId,
    start_offset: 0,
    end_offset: 4,
    purpose: "sentence",
    producer_version: "source_span_identity_v1",
    workspace_id: "workspace-1"
  };
}

function generation(generationId: string, status: "shadow" | "verified" | "active" | "retired") {
  return {
    generation_id: generationId,
    workspace_id: "workspace-1",
    operator_manifest_digest: "sha256:" + "b".repeat(64),
    schema_version: "1",
    input_event_frontier: "event-1",
    governance_frontier: "gov-1",
    status
  };
}
