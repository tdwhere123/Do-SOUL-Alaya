import { SourceSemanticResourceExhausted, type SourceIndexStatementKeyVectorRead, type SourceIndexTarget,
  type SourceSemanticResourceBudget } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { cachedReadStatement } from "../../sqlite/dynamic-prepared-statement-cache.js";
import { decodeValidEmbeddingBlob } from "../memory/embedding-vector-validity.js";
import { readBufferField, readIntegerField, readRecord } from "../shared/parse-row.js";
import { readSourceIndexQueryState } from "./generation-state.js";
import { QueryReadMeter } from "./query-read-meter.js";

const KEY_VECTOR_SQL = `SELECT v.dimensions,v.embedding_blob FROM source_index_vectors v
  WHERE v.workspace_id=? AND v.generation_id=? AND v.root_key=?
    AND EXISTS (SELECT 1 FROM source_index_roots r WHERE r.workspace_id=v.workspace_id AND r.root_key=v.root_key)
  LIMIT 2`;

/** Active-generation vectors of statement keys, aligned with the request. A key without exactly one
 * valid stored window is null; an unreadable binding or budget leaves the whole read unknown. */
export function readStatementKeyVectors(database: StorageDatabase, keys: readonly SourceIndexTarget[],
  budget: SourceSemanticResourceBudget): SourceIndexStatementKeyVectorRead {
  const meter = new QueryReadMeter(budget);
  try {
    const workspace = keys[0]?.target.workspace_id;
    if (workspace === undefined) return { status: "ready", vectors: [], resources: meter.resources() };
    if (keys.some(key => key.auxiliary === undefined || key.target.workspace_id !== workspace)) {
      return { status: "unknown", reason: "statement_key_vector_key_invalid", resources: meter.resources() };
    }
    const read = readSourceIndexQueryState(database, workspace, meter.remaining());
    meter.absorb(read.resources);
    if (!("binding" in read.state)) {
      return { status: "unknown", reason: `statement_key_vector_${read.state.reason}`, resources: meter.resources() };
    }
    const { generation_id: generation, dimensions } = read.state.binding;
    const statement = cachedReadStatement(database, KEY_VECTOR_SQL);
    const vectors = keys.map(key => {
      meter.ledger.reserve(2, 8 * dimensions + 64, "statement key vector");
      meter.read(2, 8 * dimensions + 16);
      const rows = statement.all(workspace, generation, key.root_key).map(row => readRecord(row, "statement key vector"));
      meter.ledger.charge(dimensions, 4 * dimensions + 32, "statement key vector decode");
      const row = rows[0];
      return rows.length !== 1 || readIntegerField(row!, "dimensions") !== dimensions ? null
        : decodeValidEmbeddingBlob(readBufferField(row!, "embedding_blob"), dimensions);
    });
    return { status: "ready", vectors, resources: meter.resources() };
  } catch (error) {
    return { status: "unknown", reason: error instanceof SourceSemanticResourceExhausted
      ? `statement_key_vector_read_budget:${error.phase}` : "statement_key_vector_read_failed_unknown_additional_cost",
    resources: meter.resources() };
  }
}
