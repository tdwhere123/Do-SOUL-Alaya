import { expect } from "vitest";
import {
  hashLabeledIdentity, hashSourceRecordId, prepareSourceIndexDocument,
  type SourceIndexConfiguration, type SourceIndexDocument, type SourceIndexGeneration,
  type SourceIndexProfile, type SourceIndexVector, type SourceIndexWindow
} from "@do-soul/alaya-protocol";
import { initDatabase, type StorageDatabase } from "../../../sqlite/db.js";
import { SqliteFieldEraseBarrierRepo } from "../../../repos/field/erase-repo.js";
import { SqliteFieldSourceRecordRepo } from "../../../repos/field/source-repo.js";
import { SqliteFieldProjectionGenerationRepo } from "../../../repos/field/generation-repo.js";
import type { FieldSourceRecordRow } from "../../../repos/field/ports.js";
import { SqliteSourceIndexRepository } from "../../../repos/source-index/source-index-repo.js";
import {
  CLOCK, fieldSha256, hashedGeneration, hashedOriginalRecord, openFieldDatabase, seedWorkspaces
} from "../field/field-contract-fixture.js";

export { CLOCK, fieldSha256 };
export const WORKSPACE = "workspace-1";
export const BUDGET = { work: 100_000, native_bytes: 16 * 1024 * 1024 };

export function configuration(profile: Partial<SourceIndexProfile> = {}, revision = "fixture-v1"): SourceIndexConfiguration {
  return { revision, profile: {
    provider_kind: "fixture-only", model_id: "fixed-vectors", model_revision: "v1",
    artifact_digest: `sha256:${"a".repeat(64)}`, tokenizer_revision: "fixture-v1",
    dimensions: 3, preprocessing: "exact-utf8", normalization: "none", max_input_tokens: 8,
    windowing: "utf8-byte-windows.v1", window_bytes: 8, ...profile
  } };
}

export function fixture(filename?: string) {
  const database = filename === undefined ? openFieldDatabase() : initDatabase({ filename });
  if (filename !== undefined) seedWorkspaces(database);
  return {
    database, records: new SqliteFieldSourceRecordRepo(database, fieldSha256),
    index: new SqliteSourceIndexRepository(database, fieldSha256),
    erase: new SqliteFieldEraseBarrierRepo(database, fieldSha256)
  };
}
export type Fixture = ReturnType<typeof fixture>;

export function publishSource(environment: Fixture, body: string, sourceId = "source-a",
  changes: Partial<FieldSourceRecordRow> = {}) {
  const row = { ...hashedOriginalRecord(changes.workspace_id ?? WORKSPACE, body, sourceId), ...changes };
  return environment.records.insert({ ...row, record_id: hashSourceRecordId(row, fieldSha256) });
}

// Independently authored numerical fixtures exercise persistence/guards, not embedding inference.
export function vectorFor(window: SourceIndexWindow): SourceIndexVector {
  return { window_id: window.window_id, input_digest: window.content_digest,
    embedding: new Float32Array([0.6, 0.8, 0]), token_count: 2, truncated: false };
}

export function captureDocuments(environment: Fixture, generation: SourceIndexGeneration): SourceIndexDocument[] {
  const workspace = generation.selection.workspace_id;
  const captured = environment.index.capturePage(workspace, generation.generation_id, 128, BUDGET);
  expect(captured.generation.enumeration_complete).toBe(true);
  return environment.index.listTargets(workspace, generation.generation_id, null, 128).map(source => {
    const read = environment.index.readDocument(workspace, generation.generation_id, source.root_key, 4 * 1024 * 1024, BUDGET);
    expect(read.status).toBe("ready");
    if (read.status !== "ready") throw new Error(`fixture source read failed: ${read.reason}`);
    const document = prepareSourceIndexDocument({ source, body: read.body,
      profile: generation.selection.configuration.profile }, fieldSha256);
    const write = environment.index.writeDocument(workspace, generation.generation_id, document, BUDGET);
    const representation = environment.records.findById(workspace, read.source.target.root_id)?.source_representation;
    const dependencyCount = representation?.kind === "canonical_projection" ? representation.source_record_ids.length : 0;
    // Five-work current read, two native checks per dependency, a barrier per root/dependency,
    // and one SQLite-local INSERT ... SELECT lookup per persisted dependency.
    expect(write).toEqual({ status: "accepted", resources: {
      work: 6 + 4 * dependencyCount, native_bytes: expect.any(Number)
    } });
    expect(write.resources.native_bytes).toBeGreaterThan(0);
    expect(write.resources.native_bytes).toBeLessThanOrEqual(BUDGET.native_bytes);
    return document;
  });
}

export function writeVectors(environment: Fixture, generation: SourceIndexGeneration, documents: readonly SourceIndexDocument[]) {
  for (const document of documents) for (const window of document.windows) {
    expect(environment.index.writeVector(generation.selection.workspace_id, generation.generation_id, vectorFor(window)))
      .toEqual({ status: "accepted" });
  }
}

export function buildReady(environment: Fixture, config = configuration(), workspace = WORKSPACE) {
  const generation = environment.index.begin(environment.index.select(workspace, config));
  const documents = captureDocuments(environment, generation);
  writeVectors(environment, generation, documents);
  expect(environment.index.activate(workspace, generation.generation_id)).toEqual({ status: "accepted" });
  return { generation: environment.index.generation(workspace, generation.generation_id)!, documents };
}

export function eraseSource(environment: Fixture, recordId: string, workspace = WORKSPACE) {
  return environment.erase.apply({
    identity: hashLabeledIdentity("erase_barrier", [workspace, "source_record", recordId, ""], fieldSha256),
    barrier_id: `erase-${workspace}-${recordId}`, workspace_id: workspace, generation_id: null,
    subject_kind: "source_record", subject_id: recordId, erased_at: CLOCK
  });
}

export function lexicalRows(database: StorageDatabase, workspace = WORKSPACE) {
  return database.connection.prepare("SELECT root_key, body, body_bytes FROM source_index_text WHERE workspace_id=? ORDER BY root_key")
    .all(workspace);
}

export function ftsMatches(database: StorageDatabase, term: string, workspace = WORKSPACE) {
  return database.connection.prepare(`SELECT x.root_key FROM source_index_fts f JOIN source_index_text x ON x.id=f.rowid
    WHERE source_index_fts MATCH ? AND x.workspace_id=? ORDER BY x.root_key`).all(term, workspace);
}

export function fieldPointer(database: StorageDatabase) {
  const repository = new SqliteFieldProjectionGenerationRepo(database, fieldSha256);
  const generation = repository.insert(hashedGeneration(WORKSPACE, "source-index-independent-field", "verified"));
  const pointer = repository.activatePointer({ workspace_id: WORKSPACE,
    active_generation_id: generation.generation_id, activated_at: CLOCK });
  return { repository, generation, pointer };
}
