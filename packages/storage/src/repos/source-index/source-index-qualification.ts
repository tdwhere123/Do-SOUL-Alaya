import { AlayaError, SourceIndexLexicalSelectionSchema, type SourceIndexTarget, type SourceIndexVectorQueryState,
  type SourceIndexGeneration, type SourceIndexSelection, type SourceIndexLexicalSelection, type FieldContractSha256 } from "@do-soul/alaya-protocol";
import { readSourceIndexLexicalAnalysisStatus } from "@do-soul/alaya-cjk-segmentation";
import type { StorageDatabase } from "../../sqlite/db.js";
import { SqliteFieldSourceRecordRepo } from "../field/source-repo.js";
import { readSourceIndexGeneration, readSourceIndexSelection, readSourceIndexQueryState, sourceIndexEpoch, SOURCE_INDEX_LEXICAL_CURRENT } from "./generation-state.js";
import { guardSourceIndexTarget, sourceTargetFromRead, SOURCE_INDEX_STANDALONE_BUDGET } from "./native-source.js";
import { decodeValidEmbeddingBlob } from "../memory/embedding-vector-validity.js";
import { sourceIndexWindowWithinSource } from "./source-index-query-reader.js";
import { readSourceIndexLexicalBinding } from "./lexical-generation.js";

export const SOURCE_INDEX_QUALIFICATION_STATUSES = ["ready", "not_indexed", "stale", "partial", "unknown"] as const;
type Status = typeof SOURCE_INDEX_QUALIFICATION_STATUSES[number];
export type SourceIndexSnapshotFact = {
  workspace_id: string; source_epoch: number; query_state: SourceIndexVectorQueryState;
  selection: SourceIndexSelection | null; generation: SourceIndexGeneration | null;
  lexical: { selection: SourceIndexLexicalSelection | null;
    selected: ReturnType<typeof readSourceIndexLexicalBinding>["state"];
    serving: "raw" | "generation" | "unavailable" };
};
export type SourceIndexRootQualification = {
  snapshot: SourceIndexSnapshotFact; source_id: string; source: SourceIndexTarget | null;
  status: Status; reason: string | null; currentness: Exclude<Status, "not_indexed">;
  lexical: { status: Status; start_byte: number | null; end_byte: number | null };
  vector: { status: Status; generation_member: boolean | null; expected_windows: number | null;
    coverage_complete: boolean | null; windows: { window_id: string; ordinal: number; start_byte: number;
      end_byte: number; content_digest: string; status: Status; reason: string | null }[];
    capture: "complete" | "partial" | "unknown"; next_ordinal: number | null };
};

/** Private measurement reader. Caller owns the frozen read transaction; no activation, build,
 * model invocation or recall-ledger debit. State/currentness/coverage reuse the serving owners.
 * Its SQL reads stored metadata, never defines an alternate index admission policy. */
export function readSourceIndexSnapshotFact(database: StorageDatabase, workspaceId: string): SourceIndexSnapshotFact {
  const read = readSourceIndexQueryState(database, workspaceId, SOURCE_INDEX_STANDALONE_BUDGET);
  const selected = readSourceIndexLexicalBinding(database, workspaceId, SOURCE_INDEX_STANDALONE_BUDGET).state;
  const row = database.connection.prepare(`SELECT workspace_id,selection_revision,representation
    FROM source_index_lexical_selections WHERE workspace_id=?`).get(workspaceId);
  const selection = row === undefined ? null : SourceIndexLexicalSelectionSchema.parse(row);
  const serving = selected.status === "unavailable" ? "unavailable"
    : !("binding" in selected) || selected.binding.representation !== "raw-unicode61.v1"
      && readSourceIndexLexicalAnalysisStatus() !== "ready" ? "raw" : "generation";
  return { workspace_id: workspaceId, source_epoch: sourceIndexEpoch(database, workspaceId), query_state: read.state,
    selection: readSourceIndexSelection(database, workspaceId),
    generation: "binding" in read.state ? readSourceIndexGeneration(database, workspaceId, read.state.binding.generation_id) : null,
    lexical: { selection, selected, serving } };
}

/** Page all windows, including those without vectors. [] is absence only when capture=complete.
 * Native diagnostic reads are bounded separately from recall; SQL-internal/physical cost is unknown. */
export function readSourceIndexRootQualification(database: StorageDatabase, sha256: FieldContractSha256,
  workspaceId: string, sourceId: string, afterOrdinal = -1): SourceIndexRootQualification {
  if (!database.connection.inTransaction) throw new AlayaError("CONFLICT", "index qualification requires a caller-owned frozen read transaction");
  if (!Number.isSafeInteger(afterOrdinal) || afterOrdinal < -1) throw new AlayaError("CONFLICT", "invalid qualification window cursor");
  const snapshot = readSourceIndexSnapshotFact(database, workspaceId);
  const result: SourceIndexRootQualification = { snapshot, source_id: sourceId, source: null,
    status: "unknown", reason: "native_source_unavailable", currentness: "unknown",
    lexical: { status: "unknown", start_byte: null, end_byte: null },
    vector: { status: "unknown", generation_member: null, expected_windows: null, coverage_complete: null,
      windows: [], capture: "unknown", next_ordinal: null } };
  const records = new SqliteFieldSourceRecordRepo(database, sha256);
  const read = records.findCurrentBounded(workspaceId, sourceId, 4, 0,
    { workLimit: SOURCE_INDEX_STANDALONE_BUDGET.work, nativeByteLimit: SOURCE_INDEX_STANDALONE_BUDGET.native_bytes });
  if (read === null) return { ...result, status: "stale", currentness: "stale", reason: "missing_source" };
  if (read.resourceLimited || read.record === null) return { ...result, status: "partial", currentness: "partial", reason: "native_source_partial" };
  const source = sourceTargetFromRead(read);
  if (source === null) return result;
  result.source = source;
  const guard = guardSourceIndexTarget(database, records, source);
  result.currentness = guard.status;
  if (guard.status !== "ready") { result.status = guard.status; result.reason = guard.reason; return result; }
  const lexicalGeneration = snapshot.lexical.serving === "generation" && "binding" in snapshot.lexical.selected
    ? snapshot.lexical.selected.binding.generation_id : undefined;
  const projectionJoin = lexicalGeneration === undefined ? "" : `JOIN source_index_lexical_projections p
    ON p.workspace_id=x.workspace_id AND p.root_key=x.root_key AND p.generation_id=?
      AND p.content_digest=x.content_digest AND p.body_bytes=x.body_bytes
    JOIN source_index_lexical_targets t ON t.workspace_id=p.workspace_id AND t.generation_id=p.generation_id
      AND t.root_key=p.root_key AND t.complete=1`;
  const lexical = snapshot.lexical.serving === "unavailable" ? undefined : database.connection.prepare(`SELECT x.body_bytes FROM source_index_roots r JOIN source_index_text x
    ON x.workspace_id=r.workspace_id AND x.root_key=r.root_key WHERE r.workspace_id=? AND r.root_key=?
    AND ${SOURCE_INDEX_LEXICAL_CURRENT}`).get(workspaceId, source.root_key) as { body_bytes: number } | undefined;
  const servingLexical = lexicalGeneration === undefined || lexical === undefined ? lexical : database.connection.prepare(`SELECT x.body_bytes
    FROM source_index_text x ${projectionJoin} WHERE x.workspace_id=? AND x.root_key=?`)
    .get(lexicalGeneration, workspaceId, source.root_key) as { body_bytes: number } | undefined;
  result.lexical = snapshot.lexical.serving === "unavailable" ? { status: "unknown", start_byte: null, end_byte: null }
    : servingLexical === undefined ? { status: "not_indexed", start_byte: null, end_byte: null }
    : { status: "ready", start_byte: 0, end_byte: servingLexical.body_bytes };
  const state = readSourceIndexQueryState(database, workspaceId, SOURCE_INDEX_STANDALONE_BUDGET).state;
  if (!("binding" in state)) {
    result.vector.status = state.status === "unbound" || state.status === "unknown" ? "not_indexed" : "unknown";
    result.status = result.lexical.status; result.reason = state.reason; return result;
  }
  const generation = state.binding.generation_id;
  const target = database.connection.prepare(`SELECT expected_windows,complete FROM source_index_targets
    WHERE workspace_id=? AND generation_id=? AND root_key=?`).get(workspaceId, generation, source.root_key) as
    { expected_windows: number | null; complete: number } | undefined;
  result.vector.generation_member = target !== undefined;
  result.vector.expected_windows = target?.expected_windows ?? null;
  result.vector.coverage_complete = target === undefined ? false : target.complete === 1;
  result.vector.status = target === undefined ? "not_indexed" : target.complete === 1 ? "ready" : "partial";
  result.status = combinedStatus(result.lexical.status, result.vector.status);
  result.reason = target === undefined ? "root_not_in_active_generation" : target.expected_windows === null ? "manifest_unprepared" : null;
  if (target === undefined || target.expected_windows === null) {
    result.vector.capture = "complete"; return result;
  }
  const rows = database.connection.prepare(`SELECT w.window_id,w.ordinal,w.start_byte,w.end_byte,w.content_digest,
    v.dimensions,length(v.embedding_blob) AS vector_bytes FROM source_index_windows w LEFT JOIN source_index_vectors v
    ON v.workspace_id=w.workspace_id AND v.generation_id=w.generation_id AND v.root_key=w.root_key AND v.window_id=w.window_id
    WHERE w.workspace_id=? AND w.generation_id=? AND w.root_key=? AND w.ordinal>? ORDER BY w.ordinal LIMIT 33`)
    .all(workspaceId, generation, source.root_key, afterOrdinal) as Array<{ window_id: string; ordinal: number;
      start_byte: number; end_byte: number; content_digest: string; dimensions: number | null; vector_bytes: number | null }>;
  let bytes = 0;
  for (const row of rows.slice(0, 32)) {
    let status: SourceIndexRootQualification["status"] = "not_indexed", reason: string | null = "vector_missing";
    if (row.vector_bytes !== null) {
      status = "unknown"; reason = "diagnostic_vector_byte_limit";
      if (bytes + row.vector_bytes <= 262144) {
        const vector = database.connection.prepare(`SELECT embedding_blob FROM source_index_vectors
          WHERE workspace_id=? AND generation_id=? AND root_key=? AND window_id=?`)
          .get(workspaceId, generation, source.root_key, row.window_id) as { embedding_blob: Buffer };
        bytes += row.vector_bytes;
        const valid = row.dimensions === state.binding.dimensions
          && decodeValidEmbeddingBlob(vector.embedding_blob, state.binding.dimensions) !== null
          && sourceIndexWindowWithinSource(row, source);
        status = valid ? "ready" : "partial"; reason = valid ? null : "invalid_vector_or_window";
      }
    }
    result.vector.windows.push({ window_id: row.window_id, ordinal: row.ordinal, start_byte: row.start_byte,
      end_byte: row.end_byte, content_digest: row.content_digest, status, reason });
  }
  if (result.vector.windows.some(window => window.status === "not_indexed" || window.status === "partial")) result.vector.status = "partial";
  else if (result.vector.windows.some(window => window.status === "unknown")) result.vector.status = "unknown";
  result.status = combinedStatus(result.lexical.status, result.vector.status);
  result.vector.capture = rows.length > 32 ? "partial" : "complete";
  result.vector.next_ordinal = rows.length > 32 ? rows[31]!.ordinal : null;
  return result;
}

function combinedStatus(lexical: Status, vector: Status): Status {
  if (lexical === "ready" || vector === "ready") return "ready";
  if (lexical === "unknown" || vector === "unknown") return "unknown";
  if (lexical === "partial" || vector === "partial") return "partial";
  if (lexical === "stale" || vector === "stale") return "stale";
  return "not_indexed";
}
