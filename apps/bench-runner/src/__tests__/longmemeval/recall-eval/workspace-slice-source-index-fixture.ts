import {
  hashContentDigest,
  hashSourceRecordId,
  SOURCE_SPAN_IDENTITY_OPERATOR_ID,
  UNKNOWN_UTTERANCE_ATTRIBUTION,
  type SourceIndexConfiguration,
  type SourceIndexDocument,
  type SourceIndexGeneration,
  type SourceIndexVector,
  type SourceIndexWindow,
  type SourceRepresentation
} from "@do-soul/alaya-protocol";
import { fieldContractSha256, SourceIndexLifecycle } from "@do-soul/alaya-core";
import {
  closeCachedDatabase,
  initDatabase,
  SqliteFieldSourceRecordRepo,
  SqliteSourceIndexRepository,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { assertQuiescentMainDb } from "../../../runs/snapshot/recall-eval/workspace-slice/slice-snapshot.js";
import { WORKSPACE_A, WORKSPACE_B } from "./workspace-slice-fixture.js";

export { fieldContractSha256 };

export const SOURCE_INDEX_BUDGET = Object.freeze({
  work: 100_000,
  native_bytes: 16 * 1024 * 1024
});
export const SOURCE_QUERY_BUDGET = Object.freeze({
  work_units: 100_000,
  memory_bytes: 16 * 1024 * 1024
});
/** Explicit id gap so copied FTS rowids cannot be mistaken for dense 1..n assignment. */
export const SOURCE_INDEX_TEXT_ID_GAP = 100_003;
export const SOURCE_LATIN_A = "zyxsourcealphauniq";
export const SOURCE_LATIN_B = "zyxsourcebetauniq";
export const SOURCE_TRIGRAM_A = "甲乙丙丁戊";
export const SOURCE_TRIGRAM_B = "壬癸子丑寅";
// Independently authored numerical fixtures; not embedding-model output.
export const FIXTURE_VECTOR_A = Object.freeze([0.6, 0.8, 0]);
export const FIXTURE_VECTOR_B = Object.freeze([0, 0.6, 0.8]);

const CLOCK = "2026-08-10T00:00:00.000Z";
const ID_GAP_WORKSPACE = "id-gap-workspace";
const SOURCE_INDEX_TABLES = [
  "source_index_epochs",
  "source_index_selections",
  "source_index_generations",
  "source_index_roots",
  "source_index_dependencies",
  "source_index_targets",
  "source_index_text",
  "source_index_windows",
  "source_index_vectors"
] as const;
const SOURCE_INDEX_ORDER: Readonly<Record<(typeof SOURCE_INDEX_TABLES)[number], string>> = {
  source_index_epochs: "workspace_id",
  source_index_selections: "workspace_id",
  source_index_generations: "generation_id",
  source_index_roots: "root_key",
  source_index_dependencies: "root_key, dependency_record_id",
  source_index_targets: "generation_id, root_key",
  source_index_text: "id",
  source_index_windows: "generation_id, window_id",
  source_index_vectors: "generation_id, window_id"
};

export type SourceIndexSnapshot = Readonly<Record<string, readonly Record<string, unknown>[]>>;

export function sourceIndexConfiguration(): SourceIndexConfiguration {
  return {
    revision: "fixture-v1",
    profile: {
      provider_kind: "fixture-only",
      model_id: "fixed-vectors",
      model_revision: "v1",
      artifact_digest: `sha256:${"a".repeat(64)}`,
      tokenizer_revision: "fixture-v1",
      dimensions: 3,
      preprocessing: "exact-utf8",
      normalization: "none",
      max_input_tokens: 8,
      windowing: "utf8-byte-windows.v1",
      window_bytes: 64
    }
  };
}

export function workspaceSourceBody(workspaceId: string): string {
  if (workspaceId === WORKSPACE_B) return `${SOURCE_LATIN_B} ${SOURCE_TRIGRAM_B}`;
  return `${SOURCE_LATIN_A} ${SOURCE_TRIGRAM_A}`;
}

export function labelledFixtureVector(
  workspaceId: string,
  window: SourceIndexWindow
): SourceIndexVector {
  const values = workspaceId === WORKSPACE_B ? FIXTURE_VECTOR_B : FIXTURE_VECTOR_A;
  return {
    window_id: window.window_id,
    input_digest: window.content_digest,
    embedding: new Float32Array(values),
    token_count: 2,
    truncated: false
  };
}

export function populatePackedSourceIndexes(path: string): void {
  const database = initDatabase({ filename: path });
  try {
    plantSparseSourceIndexTextIds(database);
    for (const workspaceId of [WORKSPACE_A, WORKSPACE_B] as const) {
      publishWorkspaceSources(database, workspaceId);
      buildReadySourceIndex(database, workspaceId);
    }
    removeSparseSourceIndexTextGap(database);
  } finally {
    database.close();
    closeCachedDatabase(path);
  }
  assertQuiescentMainDb(path);
}

export function snapshotSourceIndex(
  database: StorageDatabase,
  workspaceId: string
): SourceIndexSnapshot {
  return Object.freeze(Object.fromEntries(SOURCE_INDEX_TABLES.map((table) => [
    table,
    Object.freeze(database.connection.prepare(
      `SELECT * FROM ${table} WHERE workspace_id = ? ORDER BY ${SOURCE_INDEX_ORDER[table]}`
    ).all(workspaceId).map(serializeRow))
  ])));
}

export function sourceIndexTextIds(database: StorageDatabase): readonly number[] {
  return (database.connection.prepare(
    "SELECT id FROM source_index_text ORDER BY id"
  ).all() as ReadonlyArray<{ readonly id: number }>).map((row) => row.id);
}

export function matchSourceIndexLane(
  database: StorageDatabase,
  table: "source_index_fts" | "source_index_fts_trigram",
  term: string,
  workspaceId: string
): ReadonlyArray<{
  readonly id: number;
  readonly fts_rowid: number;
  readonly root_key: string;
  readonly body: string;
}> {
  return database.connection.prepare(`
    SELECT x.id, ${table}.rowid AS fts_rowid, x.root_key, x.body
    FROM ${table}
    JOIN source_index_text x ON x.id = ${table}.rowid
    WHERE ${table} MATCH ? AND x.workspace_id = ?
    ORDER BY x.root_key
  `).all(quoteFtsLiteral(term), workspaceId) as Array<{
    readonly id: number;
    readonly fts_rowid: number;
    readonly root_key: string;
    readonly body: string;
  }>;
}

function quoteFtsLiteral(term: string): string {
  return `"${term.replaceAll("\"", "\"\"")}"`;
}

function plantSparseSourceIndexTextIds(database: StorageDatabase): void {
  database.connection.prepare(`
    INSERT INTO source_index_text (
      id, workspace_id, root_key, content_digest, body_bytes, body
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    SOURCE_INDEX_TEXT_ID_GAP,
    ID_GAP_WORKSPACE,
    "id-gap-root",
    `sha256:${"0".repeat(64)}`,
    1,
    "x"
  );
}

function removeSparseSourceIndexTextGap(database: StorageDatabase): void {
  database.connection.prepare(
    "DELETE FROM source_index_text WHERE workspace_id = ? AND root_key = ?"
  ).run(ID_GAP_WORKSPACE, "id-gap-root");
}

function publishWorkspaceSources(database: StorageDatabase, workspaceId: string): void {
  const origin = publishSourceRecord(database, {
    workspaceId,
    sourceId: `${workspaceId}-origin`,
    body: `retained origin ${workspaceId}`,
    representation: { kind: "retained_excerpt" }
  });
  publishSourceRecord(database, {
    workspaceId,
    sourceId: `${workspaceId}-projection`,
    body: workspaceSourceBody(workspaceId),
    representation: {
      kind: "canonical_projection",
      source_record_ids: [origin.record_id]
    }
  });
}

function publishSourceRecord(
  database: StorageDatabase,
  input: {
    readonly workspaceId: string;
    readonly sourceId: string;
    readonly body: string;
    readonly representation: SourceRepresentation;
  }
) {
  const contentDigest = hashContentDigest(input.body, fieldContractSha256);
  const row = {
    workspace_id: input.workspaceId,
    source_id: input.sourceId,
    source_version: "v1",
    content_digest: contentDigest,
    evidence_object_id: null,
    recorded_at: CLOCK,
    event_time: null,
    valid_from: null,
    valid_to: null,
    operator_id: SOURCE_SPAN_IDENTITY_OPERATOR_ID,
    speaker: null,
    scope_class: "project" as const,
    attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION,
    source_representation: input.representation,
    source_body: input.body
  };
  return new SqliteFieldSourceRecordRepo(database, fieldContractSha256).insert({
    ...row,
    record_id: hashSourceRecordId(row, fieldContractSha256)
  });
}

function buildReadySourceIndex(
  database: StorageDatabase,
  workspaceId: string
): SourceIndexGeneration {
  const index = new SqliteSourceIndexRepository(database, fieldContractSha256);
  const lifecycle = new SourceIndexLifecycle(index, fieldContractSha256);
  const generation = lifecycle.begin(lifecycle.select(workspaceId, sourceIndexConfiguration()));
  const captured = lifecycle.capture(
    workspaceId,
    generation.generation_id,
    128,
    SOURCE_INDEX_BUDGET
  );
  if (!captured.generation.enumeration_complete) {
    throw new Error("source index enumeration was incomplete");
  }
  const documents = prepareDocuments(lifecycle, index, workspaceId, generation.generation_id);
  acceptFixtureVectors(lifecycle, workspaceId, generation.generation_id, documents);
  const published = lifecycle.publish(workspaceId, generation.generation_id);
  if (published.status !== "accepted") {
    throw new Error("source index publication was rejected");
  }
  const ready = index.generation(workspaceId, generation.generation_id);
  if (ready === null || ready.status !== "ready") {
    throw new Error("source index generation was not ready after publication");
  }
  return ready;
}

function prepareDocuments(
  lifecycle: SourceIndexLifecycle,
  index: SqliteSourceIndexRepository,
  workspaceId: string,
  generationId: string
): readonly SourceIndexDocument[] {
  return index.listTargets(workspaceId, generationId, null, 128).map((source) => {
    const prepared = lifecycle.prepare(
      workspaceId,
      generationId,
      source.root_key,
      SOURCE_INDEX_BUDGET
    );
    if (prepared.status !== "ready") {
      throw new Error(`source index prepare was ${prepared.status}`);
    }
    return prepared.document;
  });
}

function acceptFixtureVectors(
  lifecycle: SourceIndexLifecycle,
  workspaceId: string,
  generationId: string,
  documents: readonly SourceIndexDocument[]
): void {
  for (const document of documents) {
    for (const window of document.windows) {
      const written = lifecycle.acceptVector(
        workspaceId,
        generationId,
        labelledFixtureVector(workspaceId, window)
      );
      if (written.status !== "accepted") {
        throw new Error("source index rejected labelled fixture vector");
      }
    }
  }
}

function serializeRow(row: unknown): Readonly<Record<string, unknown>> {
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    throw new Error("Source index snapshot expected a SQLite row object");
  }
  return Object.freeze(Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    Buffer.isBuffer(value) ? value.toString("hex") : value
  ])));
}
