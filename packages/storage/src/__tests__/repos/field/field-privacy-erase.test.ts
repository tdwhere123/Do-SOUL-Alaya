import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashLabeledIdentity } from "@do-soul/alaya-protocol";
import { initDatabase, type StorageDatabase } from "../../../sqlite/db.js";
import {
  parseEvidenceCapsuleRow,
  type EvidenceCapsuleRow
} from "../../../repos/capsules/evidence-capsule-mappers.js";
import {
  SqliteFieldEraseBarrierRepo,
  SqliteFieldFactorRepo,
  SqliteFieldProjectionGenerationRepo,
  SqliteFieldSourceRecordRepo,
  SqliteFieldSourceSpanRepo
} from "../../../repos/field/index.js";
import {
  CLOCK,
  fieldSha256,
  hashedFactor,
  hashedGeneration,
  hashedIncidence,
  hashedRecord,
  hashedSpan,
  openFieldDatabase,
  seedWorkspaces
} from "./field-contract-fixture.js";
import {
  derivedPrivacyArtifactCounts,
  readDerivedPrivacyState,
  restoreDerivedMemoryContent,
  restoreDerivedMemoryEmbedding,
  restoreDerivedHq,
  restoreDerivedHqObservation,
  restoreDerivedPreference,
  restoreDerivedRouting,
  restoreDerivedSynthesis,
  restoreSourceMemorySynthesis,
  restoreSourceMemorySynthesisRouting,
  seedDerivedPrivacyClosure
} from "./privacy/derived-closure-fixture.js";

const tracked = new Set<StorageDatabase>();
const tempDirectories = new Set<string>();

afterEach(() => {
  for (const database of tracked) database.close();
  tracked.clear();
  for (const directory of tempDirectories) fs.rmSync(directory, { recursive: true, force: true });
  tempDirectories.clear();
});

describe("field privacy erase", () => {
  it("atomically tombstones a source closure and invalidates older generations", () => {
    const environment = createEnvironment(openFieldDatabase());
    const graph = seedSourceGraph(environment);
    const generation = seedGeneration(environment);
    seedEvidenceArtifacts(environment.database, graph.evidenceId);
    seedDerivedPrivacyClosure(environment.database, graph.evidenceId);
    seedDecisionHistory(environment.database);

    expect(environment.erase.isErased("workspace-1", graph.record.record_id)).toBe(false);
    environment.erase.apply(barrier(graph.record.record_id));
    expect(environment.erase.isErased("workspace-1", graph.record.record_id)).toBe(true);

    expect(environment.records.findById("workspace-1", graph.record.record_id)?.source_body)
      .toBeNull();
    expect(environment.spans.findById("workspace-1", graph.span.span_id)).toBeNull();
    expect(environment.factors.findIncidence("workspace-1", graph.incidence.incidence_id))
      .toBeNull();
    expect(environment.factors.findDescriptor("workspace-1", graph.factor.factor_id)
      ?.canonical_payload).toBeNull();
    expect(barrierSubjects(environment.database)).toEqual([
      ["factor", graph.factor.factor_id],
      ["generation", generation.generation_id],
      ["incidence", graph.incidence.incidence_id],
      ["source_record", graph.record.record_id],
      ["source_span", graph.span.span_id]
    ]);
    expect(readEvidenceContent(environment.database, graph.evidenceId)).toEqual({
      lifecycle_state: "tombstone",
      evidence_health_state: "broken",
      semantic_anchor: '{"topic":"erased","keywords":["erased"],"summary":"erased"}',
      event_anchor: null,
      physical_anchor: null,
      gist: "erased",
      excerpt: null,
      source_hash: null
    });
    expect(parseEvidenceCapsuleRow(readEvidenceRow(environment.database, graph.evidenceId))
      .lifecycle_state).toBe("tombstone");
    expect(derivedArtifactCounts(environment.database, graph.evidenceId)).toEqual([0, 0, 0, 0]);
    expect(derivedPrivacyArtifactCounts(environment.database)).toEqual([0, 0, 0, 0, 0]);
    expect(readDerivedPrivacyState(environment.database)).toEqual({
      memory: {
        content: "erased",
        domain_tags: "[]",
        lifecycle_state: "tombstone",
        retention_state: "tombstoned",
        manifestation_state: null,
        preference_subject: null,
        preference_object: null,
        facet_tags: null,
        canonical_entities: null
      },
      synthesis: {
        lifecycle_state: "tombstone",
        synthesis_status: "archived",
        topic_key: "erased",
        summary: "erased"
      },
      hq: { hqs_json: "[]" }
    });
    expect(ftsCount(environment.database, "evidence_capsule_fts", "private")).toBe(0);
    expect(ftsCount(environment.database, "evidence_search_projection_fts", "private")).toBe(0);
    expect(generationState(environment.database, generation.generation_id)).toEqual({
      status: "retired",
      pointer_count: 0,
      pin_count: 0,
      artifact_count: 0
    });
    expect(() => environment.generations.putArtifacts({
      workspace_id: "workspace-1",
      generation_id: generation.generation_id,
      artifact_digest: `sha256:${"e".repeat(64)}`,
      artifacts_json: JSON.stringify({ content: "restored projection" }),
      recorded_at: CLOCK
    })).toThrow(/pre-erase generation|projection generation artifacts/u);
    expect(() => environment.generations.pin({
      workspace_id: "workspace-1",
      generation_id: generation.generation_id,
      reader_id: "reader-replay",
      pinned_at: CLOCK,
      expires_at: "2026-08-17T00:00:00.000Z",
      released_at: null
    })).toThrow(/pre-erase generation|projection pin/u);
    const cleanGeneration = environment.generations.insert(
      hashedGeneration("workspace-1", "event-after-erase", "verified")
    );
    expect(() => environment.generations.putArtifacts({
      workspace_id: "workspace-1",
      generation_id: cleanGeneration.generation_id,
      artifact_digest: `sha256:${"f".repeat(64)}`,
      artifacts_json: "{}",
      recorded_at: "2026-08-16T01:00:00.000Z"
    })).not.toThrow();
    expect(count(environment.database, "proof_effect_decisions")).toBe(1);
    expect(count(environment.database, "source_record_evidence_refs")).toBe(1);
    expect(() => restoreDerivedMemoryContent(environment.database))
      .toThrow(/erased source memory/u);
    expect(() => restoreDerivedMemoryEmbedding(environment.database))
      .toThrow(/erased source memory embedding/u);
    expect(() => restoreDerivedPreference(environment.database))
      .toThrow(/erased source memory/u);
    expect(() => restoreDerivedHq(environment.database))
      .toThrow(/erased source memory HQ/u);
    expect(() => restoreDerivedHqObservation(environment.database, graph.evidenceId))
      .toThrow(/erased source memory HQ observation/u);
    expect(() => restoreDerivedRouting(environment.database))
      .toThrow(/erased source routing owner/u);
    expect(() => restoreDerivedSynthesis(environment.database))
      .toThrow(/erased source synthesis/u);
    expect(() => restoreSourceMemorySynthesis(environment.database))
      .toThrow(/erased source synthesis/u);
    expect(() => restoreSourceMemorySynthesisRouting(environment.database))
      .toThrow(/erased source routing owner/u);
  });

  it("is idempotent, rejects identity collisions, and blocks descendant replay", () => {
    const environment = createEnvironment(openFieldDatabase());
    const graph = seedSourceGraph(environment);
    const input = barrier(graph.record.record_id);

    expect(environment.erase.apply(input)).toEqual(input);
    expect(environment.erase.apply(input)).toEqual(input);
    expect(environment.erase.apply({ ...input, barrier_id: "different-request-id" })).toEqual(input);
    expect(() => environment.erase.apply({ ...input, subject_id: "different" }))
      .toThrow(/identity (collision|mismatch)/u);
    expect(environment.records.insert(graph.record).source_body).toBeNull();
    expect(() => environment.spans.insert(graph.span)).toThrow(/erased|check failed/u);
    expect(() => environment.factors.insertDescriptor(graph.factor)).toThrow(/collision|erased/u);
    expect(() => environment.factors.insertIncidence(graph.incidence))
      .toThrow(/erased|check failed/u);
    expect(count(environment.database, "projection_erase_barriers")).toBe(4);
  });

  it("rolls back the barrier and every scrub when a derived delete fails", () => {
    const environment = createEnvironment(openFieldDatabase());
    const graph = seedSourceGraph(environment);
    seedEvidenceArtifacts(environment.database, graph.evidenceId);
    environment.database.connection.exec(`
      CREATE TRIGGER fail_privacy_erase
      BEFORE DELETE ON evidence_search_projections
      BEGIN
        SELECT RAISE(ABORT, 'injected erase failure');
      END
    `);

    expect(() => environment.erase.apply(barrier(graph.record.record_id)))
      .toThrow(/erase barrier/u);
    expect(environment.records.findById("workspace-1", graph.record.record_id)?.source_body)
      .toBe("private source body");
    expect(environment.spans.findById("workspace-1", graph.span.span_id)).not.toBeNull();
    expect(count(environment.database, "projection_erase_barriers")).toBe(0);
    expect(count(environment.database, "evidence_search_projections")).toBe(1);
  });

  it("keeps the closure irreversible after reopening the SQLite file", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "field-privacy-erase-"));
    const filename = path.join(directory, "alaya.db");
    tempDirectories.add(directory);
    const initial = initDatabase({ filename });
    seedWorkspaces(initial, ["workspace-1"]);
    const graph = seedSourceGraph(createEnvironment(initial));
    new SqliteFieldEraseBarrierRepo(initial, fieldSha256).apply(barrier(graph.record.record_id));
    initial.close();

    const reopened = initDatabase({ filename });
    const environment = createEnvironment(reopened);
    expect(environment.records.findById("workspace-1", graph.record.record_id)?.source_body)
      .toBeNull();
    expect(() => environment.spans.insert(graph.span)).toThrow(/erased|check failed/u);
    expect(environment.erase.apply(barrier(graph.record.record_id))).toEqual(
      barrier(graph.record.record_id)
    );
  });

  it("rejects replay of source-linked formation payloads", () => {
    const environment = createEnvironment(openFieldDatabase());
    const graph = seedSourceGraph(environment);
    seedEvidenceArtifacts(environment.database, graph.evidenceId);
    environment.erase.apply(barrier(graph.record.record_id));

    expect(() => insertFactFrame(environment.database, graph.evidenceId))
      .toThrow(/erased source fact-frame formation/u);
    expect(() => insertSemanticFormation(environment.database, graph.evidenceId))
      .toThrow(/erased source semantic formation/u);
    expect(() => environment.database.connection.prepare(`
      UPDATE evidence_capsules SET gist = 'restored plaintext'
      WHERE object_id = ?
    `).run(graph.evidenceId)).toThrow(/erased source evidence/u);
  });
});

function createEnvironment(database: StorageDatabase) {
  tracked.add(database);
  return {
    database,
    records: new SqliteFieldSourceRecordRepo(database, fieldSha256),
    spans: new SqliteFieldSourceSpanRepo(database, fieldSha256),
    factors: new SqliteFieldFactorRepo(database, fieldSha256),
    generations: new SqliteFieldProjectionGenerationRepo(database, fieldSha256),
    erase: new SqliteFieldEraseBarrierRepo(database, fieldSha256)
  };
}

function seedSourceGraph(environment: ReturnType<typeof createEnvironment>) {
  const evidenceId = "00000000-0000-4000-8000-000000000001";
  seedEvidenceCapsule(environment.database, evidenceId);
  const record = { ...hashedRecord("workspace-1", "private source body"),
    evidence_object_id: evidenceId };
  const span = hashedSpan("workspace-1", record.record_id, 0, 7);
  const factor = hashedFactor("workspace-1", "private factor payload");
  const incidence = hashedIncidence("workspace-1", span.span_id, factor.factor_id, "claim");
  environment.records.insert(record);
  environment.spans.insert(span);
  environment.factors.insertDescriptor(factor);
  environment.factors.insertIncidence(incidence);
  return { evidenceId, record, span, factor, incidence };
}

function seedGeneration(environment: ReturnType<typeof createEnvironment>) {
  const generation = environment.generations.insert(
    hashedGeneration("workspace-1", "event-private", "verified")
  );
  environment.generations.putArtifacts({
    workspace_id: "workspace-1",
    generation_id: generation.generation_id,
    artifact_digest: `sha256:${"a".repeat(64)}`,
    artifacts_json: JSON.stringify({ content: "private projection" }),
    recorded_at: CLOCK
  });
  environment.generations.activatePointer({
    workspace_id: "workspace-1",
    active_generation_id: generation.generation_id,
    activated_at: CLOCK
  });
  environment.generations.pin({
    workspace_id: "workspace-1",
    generation_id: generation.generation_id,
    reader_id: "reader-private",
    pinned_at: CLOCK,
    expires_at: "2026-08-17T00:00:00.000Z",
    released_at: null
  });
  return generation;
}

function seedEvidenceCapsule(database: StorageDatabase, evidenceId: string): void {
  database.connection.prepare(`
    INSERT INTO evidence_capsules (
      object_id, object_kind, schema_version, lifecycle_state, created_at, updated_at,
      created_by, evidence_kind, semantic_anchor, event_anchor, physical_anchor,
      evidence_health_state, gist, excerpt, source_hash, run_id, workspace_id, surface_id
    ) VALUES (?, 'evidence_capsule', 1, 'active', ?, ?, 'test', 'file_content',
      '{"topic":"private","keywords":["private"],"summary":"private source"}',
      '{"event_type":"test","event_id":null,"occurred_at":"2026-08-16T00:00:00.000Z"}',
      '{"file_path":"private.txt","line_range":null,"symbol_name":null,"artifact_ref":null}', 'verified',
      'private gist', 'private excerpt', 'private hash', 'run-private', 'workspace-1', NULL)
  `).run(evidenceId, CLOCK, CLOCK);
}

function seedEvidenceArtifacts(database: StorageDatabase, evidenceId: string): void {
  database.connection.prepare(`
    INSERT INTO evidence_search_projections (
      evidence_object_id, projection_id, projection_kind, workspace_id, source_hash, content
    ) VALUES (?, 1, 'user_assertion', 'workspace-1', 'private hash', 'private search')
  `).run(evidenceId);
  database.connection.prepare(`
    INSERT INTO evidence_recall_embeddings (
      workspace_id, owner_object_id, document_identity, content_hash, document_role,
      provider_kind, model_id, schema_version, dimensions, embedding_blob,
      vector_valid, created_at, updated_at
    ) VALUES ('workspace-1', ?, 'document-private', 'private hash', 'evidence_document',
      'local', 'test', 1, 1, ?, 1, ?, ?)
  `).run(evidenceId, Buffer.from([1, 2, 3]), CLOCK, CLOCK);
  insertFactFrame(database, evidenceId);
  insertSemanticFormation(database, evidenceId);
}

function insertFactFrame(database: StorageDatabase, evidenceId: string): void {
  database.connection.prepare(`
    INSERT INTO evidence_fact_frame_formations (
      evidence_object_id, workspace_id, schema_version, operator_id, status,
      producer_operator_id, source_hash, fact_frame_json, capture_digest
    ) VALUES (?, 'workspace-1', 1, 'evidence_fact_frame_formation_v1', 'formed',
      'test-producer', 'private hash', '{"fact":"private"}', ?)
  `).run(evidenceId, `sha256:${"b".repeat(64)}`);
}

function insertSemanticFormation(database: StorageDatabase, evidenceId: string): void {
  database.connection.prepare(`
    INSERT INTO evidence_semantic_factor_formations (
      evidence_object_id, workspace_id, schema_version, operator_id, status,
      producer_operator_id, source_sha256, graph_json, capture_digest
    ) VALUES (?, 'workspace-1', 1, 'open_semantic_factor_formation_v1', 'formed',
      'test-producer', ?, '{"factor":"private"}', ?)
  `).run(evidenceId, `sha256:${"c".repeat(64)}`, `sha256:${"d".repeat(64)}`);
}

function seedDecisionHistory(database: StorageDatabase): void {
  database.connection.prepare(`
    INSERT INTO proof_effect_decisions (
      workspace_id, request_digest, schema_version, actor_id, run_id, delivery_id,
      action, target, scope, effective_as_of, decision,
      supporting_receipt_ids_json, supporting_proof_witnesses_json,
      governance_frontier, policy_operator_id, policy_operator_version, recorded_at
    ) VALUES ('workspace-1', 'decision-private', 2, 'reviewer', 'run-private',
      'delivery-private', 'erase', 'source', 'workspace-1', ?, 'allow', '[]', '[]',
      'sha256:test-frontier', 'proof_effect_v1', '1', ?)
  `).run(CLOCK, CLOCK);
}

function barrier(subjectId: string) {
  return {
    identity: hashLabeledIdentity(
      "erase_barrier",
      ["workspace-1", "source_record", subjectId, ""],
      fieldSha256
    ),
    barrier_id: "barrier-private",
    workspace_id: "workspace-1",
    generation_id: null,
    subject_kind: "source_record" as const,
    subject_id: subjectId,
    erased_at: CLOCK
  };
}

function barrierSubjects(database: StorageDatabase): readonly (readonly [string, string])[] {
  return (database.connection.prepare(`
    SELECT subject_kind, subject_id FROM projection_erase_barriers
    ORDER BY subject_kind, subject_id
  `).all() as { subject_kind: string; subject_id: string }[])
    .map((row) => [row.subject_kind, row.subject_id] as const);
}

function readEvidenceContent(database: StorageDatabase, evidenceId: string): unknown {
  return database.connection.prepare(`
    SELECT lifecycle_state, evidence_health_state, semantic_anchor,
      event_anchor, physical_anchor, gist, excerpt, source_hash
    FROM evidence_capsules WHERE object_id = ?
  `).get(evidenceId);
}

function readEvidenceRow(database: StorageDatabase, evidenceId: string): EvidenceCapsuleRow {
  return database.connection.prepare(`
    SELECT object_id, object_kind, schema_version, lifecycle_state, created_at, updated_at,
      created_by, evidence_kind, semantic_anchor, event_anchor, physical_anchor,
      evidence_health_state, gist, excerpt, source_hash, run_id, workspace_id, surface_id
    FROM evidence_capsules WHERE object_id = ?
  `).get(evidenceId) as EvidenceCapsuleRow;
}

function derivedArtifactCounts(database: StorageDatabase, evidenceId: string): readonly number[] {
  return [
    countWhere(database, "evidence_search_projections", "evidence_object_id", evidenceId),
    countWhere(database, "evidence_recall_embeddings", "owner_object_id", evidenceId),
    countWhere(database, "evidence_fact_frame_formations", "evidence_object_id", evidenceId),
    countWhere(database, "evidence_semantic_factor_formations", "evidence_object_id", evidenceId)
  ];
}

function generationState(database: StorageDatabase, generationId: string): unknown {
  return database.connection.prepare(`
    SELECT generation.status,
      (SELECT count(*) FROM projection_generation_pointer WHERE workspace_id = generation.workspace_id)
        AS pointer_count,
      (SELECT count(*) FROM projection_pins WHERE generation_id = generation.generation_id)
        AS pin_count,
      (SELECT count(*) FROM projection_generation_artifacts
        WHERE generation_id = generation.generation_id) AS artifact_count
    FROM projection_generations AS generation WHERE generation_id = ?
  `).get(generationId);
}

function count(database: StorageDatabase, table: string): number {
  return (database.connection.prepare(`SELECT count(*) AS count FROM ${table}`).get() as
    { count: number }).count;
}

function countWhere(
  database: StorageDatabase,
  table: string,
  column: string,
  value: string
): number {
  return (database.connection.prepare(
    `SELECT count(*) AS count FROM ${table} WHERE ${column} = ?`
  ).get(value) as { count: number }).count;
}

function ftsCount(database: StorageDatabase, table: string, query: string): number {
  return (database.connection.prepare(
    `SELECT count(*) AS count FROM ${table} WHERE ${table} MATCH ?`
  ).get(query) as { count: number }).count;
}
