import {
  BoundSourceStatementSchema, BoundedIdSchema, hashContentDigest, SourceIndexOperationError, SourceIndexTargetSchema,
  SourceSemanticResourceExhausted,
  type FieldContractSha256, type SourceIndexBudget, type SourceIndexGuardedWriteResult,
  type SourceIndexReadResult, type SourceIndexResources, type SourceIndexStatementRelationTextRead,
  type SourceIndexStatementRelationVector, type SourceIndexStatementRelationVectorRead,
  type SourceSemanticResourceBudget
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { cachedReadStatement } from "../../sqlite/dynamic-prepared-statement-cache.js";
import { StorageError } from "../../shared/errors.js";
import { decodeValidEmbeddingBlob, encodeEmbeddingBlob, isFiniteNonzeroEmbedding } from "../memory/embedding-vector-validity.js";
import { readBufferField, readIntegerField, readJsonColumn, readRecord, readStringField } from "../shared/parse-row.js";
import type { SqliteFieldSourceRecordRepo } from "../field/source-repo.js";
import { SOURCE_INDEX_STANDALONE_BUDGET, assertIndexBudget, guardSourceIndexTarget } from "./native-source.js";
import { QueryReadMeter } from "./query-read-meter.js";
import { readSourceIndexGeneration, readSourceIndexQueryState, sourceIndexBuildGuard } from "./generation-state.js";

const RELATION_TABLE = "source_statement_relation_vectors";
const PENDING_TABLE = "source_statement_relation_pending";

function dequeueStatementRelationPending(database: StorageDatabase, workspaceId: string, generationId: string,
  rootKey: string): void {
  database.connection.prepare(`DELETE FROM ${PENDING_TABLE} WHERE workspace_id=? AND generation_id=? AND root_key=?`)
    .run(workspaceId, generationId, rootKey);
}

function rejected(reason: Extract<SourceIndexGuardedWriteResult, { status: "rejected" }>["reason"],
  resources: SourceIndexGuardedWriteResult["resources"]): SourceIndexGuardedWriteResult {
  return { status: "rejected", reason, resources };
}

function statementTarget(database: StorageDatabase, workspaceId: string, generationId: string, rootKey: string) {
  const raw = cachedReadStatement(database, `SELECT r.target_json FROM source_index_targets t
    JOIN source_index_roots r ON r.workspace_id=t.workspace_id AND r.root_key=t.root_key
    WHERE t.workspace_id=? AND t.generation_id=? AND t.root_key=?`).get(workspaceId, generationId, rootKey);
  return raw === undefined ? null : SourceIndexTargetSchema.parse(readJsonColumn(readRecord(raw, "source index target"), "target_json"));
}

function relationFromGist(database: StorageDatabase, workspaceId: string, artifactId: string, sha256: FieldContractSha256) {
  const raw = cachedReadStatement(database,
    "SELECT gist FROM evidence_capsules WHERE workspace_id=? AND object_id=? AND lifecycle_state='active'")
    .get(workspaceId, artifactId);
  if (raw === undefined) return null;
  const gist = readStringField(readRecord(raw, "statement relation gist"), "gist");
  let parsed: unknown;
  try { parsed = JSON.parse(gist); } catch { return null; }
  const bound = BoundSourceStatementSchema.safeParse(parsed);
  if (!bound.success) return null;
  const relation = bound.data.statement.relation;
  return { relation, digest: hashContentDigest(relation, sha256) };
}

export function readStatementRelationText(database: StorageDatabase, records: SqliteFieldSourceRecordRepo,
  workspaceId: string, generationId: string, rootKey: string, budget: SourceIndexBudget,
  sha256: FieldContractSha256): SourceIndexStatementRelationTextRead {
  BoundedIdSchema.parse(workspaceId);
  assertIndexBudget(budget);
  const resources = { work: 0, native_bytes: 0 };
  const unknown = (reason: string): SourceIndexStatementRelationTextRead => ({ status: "unknown", reason, resources });
  const unavailable = (reason: string, dequeue = false): SourceIndexStatementRelationTextRead => {
    if (dequeue) dequeueStatementRelationPending(database, workspaceId, generationId, rootKey);
    return { status: "unavailable", reason, resources };
  };
  const need = (work: number, bytes: number) => {
    if (resources.work + work > budget.work || resources.native_bytes + bytes > budget.native_bytes) {
      return unknown("statement_relation_text_read_budget");
    }
    return null;
  };
  const blocked = need(1, 0);
  if (blocked !== null) return blocked;
  const generation = readSourceIndexGeneration(database, workspaceId, generationId);
  resources.work++;
  if (generation === null) return unavailable("missing_generation");
  const targetBudget = need(1, 0);
  if (targetBudget !== null) return targetBudget;
  const source = statementTarget(database, workspaceId, generationId, rootKey);
  resources.work++;
  if (source === null || source.auxiliary === undefined) return unavailable("missing_target", true);
  const guard = guardSourceIndexTarget(database, records, source, {
    work: budget.work - resources.work, native_bytes: budget.native_bytes - resources.native_bytes });
  resources.work += guard.resources.work;
  resources.native_bytes += guard.resources.native_bytes;
  if (guard.status !== "ready") {
    return guard.reason === "read_budget" ? unknown("statement_relation_text_read_budget") : unavailable(guard.reason, true);
  }
  const gistBudget = need(1, 0);
  if (gistBudget !== null) return gistBudget;
  const gist = relationFromGist(database, source.target.workspace_id, source.auxiliary.artifact_id, sha256);
  resources.work++;
  if (gist === null) return unavailable("statement_relation_unavailable", true);
  const bytes = Buffer.byteLength(gist.relation);
  const readyBudget = need(0, bytes);
  if (readyBudget !== null) return readyBudget;
  resources.native_bytes += bytes;
  return { status: "ready", relation: gist.relation, resources };
}

export function writeStatementRelationVector(database: StorageDatabase, records: SqliteFieldSourceRecordRepo,
  sha256: FieldContractSha256, workspaceId: string, generationId: string, vector: SourceIndexStatementRelationVector,
  budget: SourceIndexBudget = SOURCE_INDEX_STANDALONE_BUDGET): SourceIndexGuardedWriteResult {
  const input = structuredClone({ workspaceId, generationId, vector, budget });
  BoundedIdSchema.parse(input.workspaceId);
  assertIndexBudget(input.budget);
  let resources = { work: 0, native_bytes: 0 };
  const generation = readSourceIndexGeneration(database, input.workspaceId, input.generationId);
  if (generation === null) return rejected("missing_generation", resources);
  const stale = sourceIndexBuildGuard(database, generation);
  if (stale !== null) return rejected(stale, resources);
  if (generation.status === "failed") return rejected("incomplete", resources);
  const source = statementTarget(database, input.workspaceId, input.generationId, input.vector.root_key);
  if (source === null || source.auxiliary === undefined) return rejected("missing_target", resources);
  const guard = guardSourceIndexTarget(database, records, source, input.budget);
  resources = guard.resources;
  if (guard.status !== "ready") return rejected(guard.status === "partial" ? guard.reason : "stale", resources);
  const profile = generation.selection.configuration.profile;
  const value = input.vector;
  if (value.root_key !== source.root_key || !(value.embedding instanceof Float32Array)
      || value.embedding.length !== profile.dimensions || !isFiniteNonzeroEmbedding(value.embedding)
      || !Number.isSafeInteger(value.token_count) || value.token_count < 1 || value.token_count > profile.max_input_tokens) {
    throw new StorageError("VALIDATION_FAILED", "statement relation vector requires compatible complete statement input");
  }
  const gist = relationFromGist(database, source.target.workspace_id, source.auxiliary.artifact_id, sha256);
  if (gist === null || value.input_digest !== gist.digest) {
    throw new StorageError("VALIDATION_FAILED", "statement relation vector requires the published relation digest");
  }
  const blob = encodeEmbeddingBlob(value.embedding);
  const previous = cachedReadStatement(database, `SELECT dimensions,embedding_blob,token_count,input_digest
    FROM ${RELATION_TABLE} WHERE workspace_id=? AND generation_id=? AND root_key=?`)
    .get(input.workspaceId, input.generationId, value.root_key);
  if (previous !== undefined) {
    const persisted = readRecord(previous, "statement relation vector");
    if (readIntegerField(persisted, "dimensions") !== profile.dimensions
        || readIntegerField(persisted, "token_count") !== value.token_count
        || readStringField(persisted, "input_digest") !== value.input_digest
        || !readBufferField(persisted, "embedding_blob").equals(blob)) {
      throw new StorageError("CONFLICT", "statement relation vector retry differs from its persisted result");
    }
    dequeueStatementRelationPending(database, input.workspaceId, input.generationId, value.root_key);
    return { status: "accepted", resources };
  }
  database.connection.prepare(`INSERT INTO ${RELATION_TABLE}
    (workspace_id,generation_id,root_key,input_digest,dimensions,embedding_blob,token_count) VALUES(?,?,?,?,?,?,?)`)
    .run(input.workspaceId, input.generationId, source.root_key, value.input_digest, profile.dimensions, blob, value.token_count);
  dequeueStatementRelationPending(database, input.workspaceId, input.generationId, source.root_key);
  return { status: "accepted", resources };
}

function overlayTableMissing(error: unknown): boolean {
  return error instanceof Error && /no such table: source_statement_relation_(vectors|pending)/u.test(error.message);
}

type OverlayTargetRead = Readonly<{ status: "ready"; root_key: string | null; resources: SourceIndexResources }> |
  Readonly<{ status: "resource_exhausted"; reason: string; resources: SourceIndexResources }> |
  Exclude<SourceIndexReadResult, { status: "ready" }>;

export function nextStatementRelationOverlayTarget(database: StorageDatabase, workspaceId: string, generationId: string,
  afterRootKey: string | null, budget: SourceIndexBudget): OverlayTargetRead {
  BoundedIdSchema.parse(workspaceId);
  assertIndexBudget(budget);
  const resources = { work: 0, native_bytes: 0 };
  if (budget.work < 2 || budget.native_bytes < 1) {
    return { status: "resource_exhausted", reason: "overlay_target_read_budget", resources };
  }
  try {
    const generation = readSourceIndexGeneration(database, workspaceId, generationId);
    resources.work++;
    if (generation === null) return { status: "unbound", reason: "missing_generation", resources };
    const raw = cachedReadStatement(database, `SELECT CASE WHEN octet_length(root_key) <= ? THEN root_key ELSE NULL END AS root_key,
      octet_length(root_key) AS key_bytes FROM ${PENDING_TABLE}
      WHERE workspace_id = ? AND generation_id = ? AND root_key > ? ORDER BY root_key LIMIT 1`)
      .get(budget.native_bytes, workspaceId, generationId, afterRootKey ?? "");
    resources.work++;
    if (raw === undefined) return { status: "ready", root_key: null, resources };
    const row = readRecord(raw, "statement relation overlay target");
    const keyBytes = readIntegerField(row, "key_bytes");
    if (keyBytes > budget.native_bytes) {
      return { status: "resource_exhausted", reason: "overlay_target_read_budget", resources };
    }
    const root_key = readStringField(row, "root_key");
    resources.native_bytes += keyBytes;
    return { status: "ready", root_key, resources };
  } catch (error) {
    if (overlayTableMissing(error)) return { status: "ready", root_key: null, resources };
    throw error instanceof SourceIndexOperationError ? error : new SourceIndexOperationError(error, resources);
  }
}

export function readStatementRelationVectors(database: StorageDatabase, workspaceId: string, keys: readonly string[],
  budget: SourceSemanticResourceBudget): SourceIndexStatementRelationVectorRead {
  BoundedIdSchema.parse(workspaceId);
  const captured = structuredClone({ keys: [...keys] });
  const meter = new QueryReadMeter(budget);
  const unknown = (reason: string): SourceIndexStatementRelationVectorRead =>
    ({ status: "unknown", reason, resources: meter.resources() });
  const ready = (vectors: readonly (Float32Array | null)[]): SourceIndexStatementRelationVectorRead =>
    ({ status: "ready", vectors, resources: meter.resources() });
  if (captured.keys.length === 0) return ready([]);
  try {
    const state = readSourceIndexQueryState(database, workspaceId, meter.remaining());
    meter.absorb(state.resources);
    if (!("binding" in state.state)) {
      if (state.state.status === "unbound" || state.state.reason === "missing_selection") {
        return ready(captured.keys.map(() => null));
      }
      return unknown(state.state.reason);
    }
    const dims = state.state.binding.dimensions, generationId = state.state.binding.generation_id;
    const expectedBytes = dims * 4;
    const lookup = cachedReadStatement(database, `SELECT dimensions, octet_length(embedding_blob) AS blob_bytes,
      CASE WHEN dimensions = ? AND octet_length(embedding_blob) = ? THEN embedding_blob ELSE NULL END AS embedding_blob
      FROM ${RELATION_TABLE} WHERE workspace_id=? AND generation_id=? AND root_key=?`);
    const vectors: (Float32Array | null)[] = [];
    for (const key of captured.keys) {
      if (typeof key !== "string" || key.length < 1 || key.length > 2048) return unknown("invalid_relation_key");
      meter.ledger.reserve(1, 32 + expectedBytes);
      meter.read(1, 0);
      const raw = lookup.get(dims, expectedBytes, workspaceId, generationId, key);
      if (raw === undefined) { vectors.push(null); continue; }
      const row = readRecord(raw, "statement relation vector");
      const blob = row.embedding_blob;
      if (readIntegerField(row, "dimensions") !== dims || readIntegerField(row, "blob_bytes") !== expectedBytes
          || !Buffer.isBuffer(blob)) {
        return unknown("statement_relation_vector_dimension_mismatch");
      }
      meter.read(1, expectedBytes);
      meter.ledger.charge(dims, expectedBytes, "statement relation vector decode");
      const embedding = decodeValidEmbeddingBlob(blob, dims);
      if (embedding === null) return unknown("statement_relation_invalid_vector");
      vectors.push(embedding);
    }
    return ready(vectors);
  } catch (error) {
    if (overlayTableMissing(error)) return ready(captured.keys.map(() => null));
    if (error instanceof SourceSemanticResourceExhausted) return unknown("read_budget");
    if (error instanceof StorageError) return unknown("statement_relation_invalid_vector");
    throw error instanceof SourceIndexOperationError ? error : new SourceIndexOperationError(error, meter.resources());
  }
}
