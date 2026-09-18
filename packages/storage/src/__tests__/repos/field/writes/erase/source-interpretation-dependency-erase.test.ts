import { afterEach, describe, expect, it } from "vitest";
import { hashLabeledIdentity, sourceRecallTarget } from "@do-soul/alaya-protocol";
import { type StorageDatabase } from "../../../../../sqlite/db.js";
import { SqliteFieldEraseBarrierRepo, SqliteFieldSourceRecordRepo } from "../../../../../repos/field/index.js";
import {
  CLOCK,
  fieldSha256,
  hashedRecord,
  openFieldDatabase
} from "../../field-contract-fixture.js";

const tracked = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of tracked) database.close();
  tracked.clear();
});

describe("source interpretation dependency erase", () => {
  it("scrubs damaged v3 H gist without a full semantic parse and leaves the source row", () => {
    const database = openFieldDatabase();
    tracked.add(database);
    const records = new SqliteFieldSourceRecordRepo(database, fieldSha256);
    const record = records.insert(hashedRecord("workspace-1", "private source body"));
    const target = sourceRecallTarget({
      workspace_id: "workspace-1",
      root_kind: "source_record",
      root_id: record.record_id,
      source_version: record.source_version,
      content_digest: record.content_digest,
      evidence_object_id: null
    });
    const ids = {
      publishedV3: "00000000-0000-4000-8000-000000000011",
      packetV3: "00000000-0000-4000-8000-000000000012",
      publishedV2: "00000000-0000-4000-8000-000000000013",
      unrelated: "00000000-0000-4000-8000-000000000014"
    };
    seedCapsule(database, ids.publishedV3, JSON.stringify({
      contract: "published-source-interpretation-v3", source_target: target, broken: true
    }));
    seedCapsule(database, ids.packetV3, JSON.stringify({
      contract: "source-interpretation-v3", source_target: target, broken: true
    }));
    seedCapsule(database, ids.publishedV2, JSON.stringify({
      contract: "published-source-interpretation-v2", source_target: target, broken: true
    }));
    seedCapsule(database, ids.unrelated, JSON.stringify({
      contract: "other", source_target: target
    }));
    new SqliteFieldEraseBarrierRepo(database, fieldSha256).apply(barrier(record.record_id));
    expect(readCapsule(database, ids.publishedV3)).toEqual({ lifecycle_state: "tombstone", gist: "erased" });
    expect(readCapsule(database, ids.packetV3)).toEqual({ lifecycle_state: "tombstone", gist: "erased" });
    expect(readCapsule(database, ids.publishedV2)).toEqual({ lifecycle_state: "tombstone", gist: "erased" });
    expect(readCapsule(database, ids.unrelated)).toEqual({
      lifecycle_state: "active", gist: JSON.stringify({ contract: "other", source_target: target })
    });
    expect(records.findById("workspace-1", record.record_id)?.source_body).toBeNull();
    expect(records.findById("workspace-1", record.record_id)?.record_id).toBe(record.record_id);
  });
});

function barrier(subjectId: string) {
  return {
    identity: hashLabeledIdentity("erase_barrier", ["workspace-1", "source_record", subjectId, ""], fieldSha256),
    barrier_id: "barrier-semantic-dependency",
    workspace_id: "workspace-1",
    generation_id: null,
    subject_kind: "source_record" as const,
    subject_id: subjectId,
    erased_at: CLOCK
  };
}

function seedCapsule(database: StorageDatabase, evidenceId: string, gist: string): void {
  database.connection.prepare(`
    INSERT INTO evidence_capsules (
      object_id, object_kind, schema_version, lifecycle_state, created_at, updated_at,
      created_by, evidence_kind, semantic_anchor, event_anchor, physical_anchor,
      evidence_health_state, gist, excerpt, source_hash, run_id, workspace_id, surface_id
    ) VALUES (?, 'evidence_capsule', 1, 'active', ?, ?, 'test', 'conversation_excerpt',
      '{"topic":"unreviewed","keywords":[],"summary":"unreviewed"}',
      NULL, NULL, 'questionable', ?, 'excerpt', 'hash', 'run-1', 'workspace-1', NULL)
  `).run(evidenceId, CLOCK, CLOCK, gist);
}

function readCapsule(database: StorageDatabase, evidenceId: string): unknown {
  return database.connection.prepare(
    "SELECT lifecycle_state, gist FROM evidence_capsules WHERE object_id = ?"
  ).get(evidenceId);
}
