import { afterEach, describe, expect, it } from "vitest";
import { hashLabeledIdentity, hashSourceRecordId, sourceRecallTarget, type SourceRepresentation } from "@do-soul/alaya-protocol";
import { type StorageDatabase } from "../../../../../sqlite/db.js";
import { SqliteFieldEraseBarrierRepo, SqliteFieldFactorRepo, SqliteFieldSourceRecordRepo,
  SqliteFieldSourceSpanRepo } from "../../../../../repos/field/index.js";
import {
  CLOCK,
  fieldSha256,
  hashedFactor,
  hashedIncidence,
  hashedRecord,
  hashedSpan,
  openFieldDatabase
} from "../../field-contract-fixture.js";
import { derivedPrivacyArtifactCounts, readDerivedPrivacyState, seedDerivedPrivacyClosure } from "./derived-closure-fixture.js";

const tracked = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of tracked) database.close();
  tracked.clear();
});

describe("source interpretation dependency erase", () => {
  it("scrubs a damaged v3 source-interpretation gist without a full semantic parse and leaves the source row", () => {
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
      contract: "published-source-interpretation-v4", source_target: target, broken: true
    }));
    seedCapsule(database, ids.packetV3, JSON.stringify({
      contract: "source-interpretation-v4", source_target: target, broken: true
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

  it("scrubs canonical projections and their evidence descendants when a retained origin is erased", () => {
    const database = openFieldDatabase();
    tracked.add(database);
    const records = new SqliteFieldSourceRecordRepo(database, fieldSha256);
    const spans = new SqliteFieldSourceSpanRepo(database, fieldSha256);
    const factors = new SqliteFieldFactorRepo(database, fieldSha256);
    const erase = new SqliteFieldEraseBarrierRepo(database, fieldSha256);
    const origin = records.insert(representedRecord("raw-private", "private\t source\n body", { kind: "retained_excerpt" }));
    const other = records.insert(representedRecord("raw-other", "Unrelated retained text.", { kind: "retained_excerpt" }));
    const aliasId = "00000000-0000-4000-8000-000000000021";
    const interpretationId = "00000000-0000-4000-8000-000000000022";
    seedCapsule(database, aliasId, "private projection evidence");
    const projection = records.insert({ ...representedRecord("canonical-private", "User: private source body\nUser: Unrelated retained text.", {
      kind: "canonical_projection", source_record_ids: [origin.record_id, other.record_id]
    }), evidence_object_id: aliasId });
    const span = spans.insert(hashedSpan("workspace-1", projection.record_id, 0, 7));
    const factor = factors.insertDescriptor(hashedFactor("workspace-1", "private projection factor"));
    const incidence = factors.insertIncidence(hashedIncidence("workspace-1", span.span_id, factor.factor_id, "claim"));
    seedCapsule(database, interpretationId, JSON.stringify({
      contract: "published-source-interpretation-v4", broken: true,
      source_target: sourceRecallTarget({ workspace_id: "workspace-1", root_kind: "source_record",
        root_id: projection.record_id, source_version: projection.source_version,
        content_digest: projection.content_digest, evidence_object_id: null })
    }));
    seedDerivedPrivacyClosure(database, interpretationId);
    expect(records.findById("workspace-1", projection.record_id)?.source_body).toBe(projection.source_body);

    erase.apply(barrier(origin.record_id));

    expect(records.findById("workspace-1", projection.record_id)?.source_body).toBeNull();
    expect.soft(database.connection.prepare(
      "SELECT source_body FROM source_records WHERE workspace_id = ? AND record_id = ?"
    ).get("workspace-1", projection.record_id)).toEqual({ source_body: null });
    expect.soft(database.connection.prepare(
      "SELECT count(*) AS count FROM retained_source_chunks WHERE workspace_id = ? AND root_id = ?"
    ).get("workspace-1", projection.record_id)).toEqual({ count: 0 });
    expect.soft(erase.isErased("workspace-1", projection.record_id)).toBe(true);
    expect.soft(spans.findById("workspace-1", span.span_id)).toBeNull();
    expect.soft(factors.findIncidence("workspace-1", incidence.incidence_id)).toBeNull();
    expect.soft(factors.findDescriptor("workspace-1", factor.factor_id)?.canonical_payload).toBeNull();
    expect.soft(readCapsule(database, aliasId)).toEqual({ lifecycle_state: "tombstone", gist: "erased" });
    expect.soft(readCapsule(database, interpretationId)).toEqual({ lifecycle_state: "tombstone", gist: "erased" });
    expect.soft(readDerivedPrivacyState(database)).toMatchObject({
      memory: { content: "erased", lifecycle_state: "tombstone" },
      synthesis: { summary: "erased", lifecycle_state: "tombstone" },
      hq: { hqs_json: "[]" }
    });
    expect.soft(derivedPrivacyArtifactCounts(database)).toEqual([0, 0, 0, 0, 0]);
    expect(records.findById("workspace-1", other.record_id)?.source_body).toBe(other.source_body);
    expect(erase.isErased("workspace-1", other.record_id)).toBe(false);
  });

  it("erases historical and transitive projection dependencies once without erasing newer independent roots", () => {
    const database = openFieldDatabase();
    tracked.add(database);
    const records = new SqliteFieldSourceRecordRepo(database, fieldSha256);
    const erase = new SqliteFieldEraseBarrierRepo(database, fieldSha256);
    const original = records.insert(representedRecord("revised-source", "private old source", { kind: "retained_excerpt" }));
    const current = records.insert({ ...representedRecord("revised-source", "public new source", { kind: "retained_excerpt" }, "v2"),
      recorded_at: "2026-08-17T00:00:00.000Z" });
    const historical = records.insert(representedRecord("revised-projection", "User: private old source", {
      kind: "canonical_projection", source_record_ids: [original.record_id]
    }));
    const currentProjection = records.insert({ ...representedRecord("revised-projection", "User: public new source", {
      kind: "canonical_projection", source_record_ids: [current.record_id]
    }, "v2"), recorded_at: "2026-08-17T00:00:00.000Z" });
    // Recovery scrubs retained lineage even if normal readers already reject a projection chain.
    const transitive = records.insert(representedRecord("retained-derived-projection", "private retained derivative", {
      kind: "canonical_projection", source_record_ids: [historical.record_id]
    }));
    records.insert({ ...original, workspace_id: "workspace-2" });
    records.insert({ ...historical, workspace_id: "workspace-2" });
    const receipt = erase.apply(barrier(original.record_id));
    expect(erase.apply(barrier(original.record_id))).toEqual(receipt);

    for (const row of [original, historical, transitive]) {
      expect(database.connection.prepare(
        "SELECT source_body FROM source_records WHERE workspace_id = ? AND record_id = ?"
      ).get("workspace-1", row.record_id)).toEqual({ source_body: null });
      expect(erase.isErased("workspace-1", row.record_id)).toBe(true);
    }
    expect(records.findCurrent("workspace-1", current.source_id)?.source_body).toBe(current.source_body);
    expect(records.findCurrent("workspace-1", currentProjection.source_id)?.source_body).toBe(currentProjection.source_body);
    expect(records.findById("workspace-2", original.record_id)?.source_body).toBe(original.source_body);
    expect(records.findById("workspace-2", historical.record_id)?.source_body).toBe(historical.source_body);
    expect(erase.isErased("workspace-2", historical.record_id)).toBe(false);
    expect(database.connection.prepare(
      "SELECT count(*) AS count FROM projection_erase_barriers WHERE workspace_id = 'workspace-1'"
    ).get()).toEqual({ count: 3 });
  });
});

function representedRecord(sourceId: string, body: string, source_representation: SourceRepresentation, sourceVersion = "v1") {
  const row = { ...hashedRecord("workspace-1", body, sourceId), source_version: sourceVersion, source_representation };
  return { ...row, record_id: hashSourceRecordId(row, fieldSha256) };
}

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
