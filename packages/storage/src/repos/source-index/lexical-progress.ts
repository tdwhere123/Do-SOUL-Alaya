import { SourceIndexOperationError, type SourceIndexBudget, type SourceIndexGuardedWriteResult,
  type SourceIndexTarget } from "@do-soul/alaya-protocol";
import { advanceSourceIndexLexicalV2, SOURCE_INDEX_SEGMENTED_UNIT_BYTES } from "@do-soul/alaya-cjk-segmentation";
import type { StorageDatabase } from "../../sqlite/db.js";
import { SqliteFieldSourceRecordRepo } from "../field/source-repo.js";
import { RETAINED_SOURCE_READ_RESERVATION } from "../field/retained-source-chunks.js";
import { guardSourceIndexTarget, sourceReadCost } from "./native-source.js";
import { readCapsuleIndexChunk } from "./capsule-source.js";

type ProgressResult = SourceIndexGuardedWriteResult & Readonly<{ analysis_units: number; complete: boolean }>;

/** Called inside the lexical generation's write transaction, after its selection/epoch guard. */
export function advanceSegmentedLexicalDocument(database: StorageDatabase, records: SqliteFieldSourceRecordRepo,
  source: SourceIndexTarget, generationId: string, budget: SourceIndexBudget): ProgressResult {
  const resources = { work: 0, native_bytes: 0 };
  let analysis = 0;
  const rejected = (reason: Extract<SourceIndexGuardedWriteResult, { status: "rejected" }>["reason"]): ProgressResult =>
    ({ status: "rejected", reason, resources, analysis_units: analysis, complete: false });
  try {
    const guard = guardSourceIndexTarget(database, records, source, budget);
    Object.assign(resources, guard.resources);
    if (guard.status !== "ready") return rejected(guard.status === "partial" ? guard.reason : "stale");
    if (budget.work - resources.work < 2 || budget.native_bytes - resources.native_bytes < 8 + SOURCE_INDEX_SEGMENTED_UNIT_BYTES) return rejected("read_budget");
    const last = database.connection.prepare(`SELECT end_byte,pending FROM source_index_lexical_progress
      WHERE workspace_id=? AND generation_id=? AND root_key=? ORDER BY start_byte DESC LIMIT 1`)
      .get(source.target.workspace_id, generationId, source.root_key) as { end_byte: number; pending: string } | undefined;
    resources.work++; resources.native_bytes += 8 + Buffer.byteLength(last?.pending ?? "");
    const offset = last?.end_byte ?? 0;
    if (offset > source.body_bytes) return rejected("stale");
    if (offset === source.body_bytes) {
      if ((last?.pending ?? "") !== "") return rejected("stale");
      if (budget.work - resources.work < 4) return rejected("read_budget");
      publishSegmentedDocument(database, source, generationId);
      resources.work += 4;
      return { status: "accepted", resources, analysis_units: analysis, complete: true };
    }
    // One indivisible unit and its source read are reserved before either starts.
    if (budget.work - resources.work < 10 * SOURCE_INDEX_SEGMENTED_UNIT_BYTES + 6 ||
        budget.native_bytes - resources.native_bytes < RETAINED_SOURCE_READ_RESERVATION) return rejected("read_budget");
    const remaining = { work: budget.work - resources.work, native_bytes: budget.native_bytes - resources.native_bytes };
    let body: string | undefined, end: number;
    if (source.target.root_kind === "evidence_capsule") {
      const read = readCapsuleIndexChunk(database, source, SOURCE_INDEX_SEGMENTED_UNIT_BYTES, offset);
      resources.work += read.resources.work; resources.native_bytes += read.resources.native_bytes;
      body = read.row?.content; end = read.row?.content_end ?? offset;
    } else {
      const read = records.findByIdBounded(source.target.workspace_id, source.target.root_id,
        SOURCE_INDEX_SEGMENTED_UNIT_BYTES, offset,
        { workLimit: remaining.work, nativeByteLimit: remaining.native_bytes });
      if (read === null) { resources.work++; return rejected("stale"); }
      const cost = sourceReadCost(read); resources.work += cost.work; resources.native_bytes += cost.native_bytes;
      if (read.resourceLimited) return rejected("read_budget");
      body = read.record?.source_body ?? undefined; end = offset + read.prefixBytes;
    }
    if (body === undefined || end <= offset || end > source.body_bytes) return rejected("native_source_unavailable");
    if (resources.work + body.length + 1 > budget.work || resources.native_bytes > budget.native_bytes) return rejected("read_budget");
    analysis = body.length; resources.work += analysis;
    const { projection, pending } = advanceSourceIndexLexicalV2(body, last?.pending ?? "", end === source.body_bytes,
      units => { resources.work += units; });
    database.connection.prepare(`INSERT INTO source_index_lexical_progress
      (workspace_id,generation_id,root_key,start_byte,end_byte,body,projection,pending) VALUES(?,?,?,?,?,?,?,?)`)
      .run(source.target.workspace_id, generationId, source.root_key, offset, end, body, projection, pending);
    resources.work++;
    return { status: "accepted", resources, analysis_units: analysis, complete: false };
  } catch (error) { throw new SourceIndexOperationError(error, resources, 0, analysis); }
}

function publishSegmentedDocument(database: StorageDatabase, source: SourceIndexTarget, generationId: string): void {
  const parameters = [source.target.workspace_id, generationId, source.root_key];
  const chunks = `SELECT body,projection FROM source_index_lexical_progress
    WHERE workspace_id=? AND generation_id=? AND root_key=? ORDER BY start_byte`;
  // SQLite-local aggregation/indexing is not measured physical work; each source byte and
  // analyzer unit was already admitted and charged before its durable chunk was written.
  database.connection.prepare(`INSERT INTO source_index_text(workspace_id,root_key,content_digest,body_bytes,body)
    SELECT ?,?,?,?,COALESCE(group_concat(body,''),'') FROM (${chunks}) WHERE true
    ON CONFLICT(workspace_id,root_key) DO UPDATE SET content_digest=excluded.content_digest,
      body_bytes=excluded.body_bytes,body=excluded.body`)
    .run(source.target.workspace_id, source.root_key, source.target.content_digest, source.body_bytes, ...parameters);
  database.connection.prepare(`INSERT INTO source_index_lexical_projections
    (workspace_id,generation_id,root_key,content_digest,body_bytes,projection)
    SELECT ?,?,?,?,?,COALESCE(group_concat(body,''),'') || ' ' || COALESCE(group_concat(projection,' '),'') FROM (${chunks}) WHERE true
    ON CONFLICT(workspace_id,generation_id,root_key) DO UPDATE SET content_digest=excluded.content_digest,
      body_bytes=excluded.body_bytes,projection=excluded.projection`)
    .run(source.target.workspace_id, generationId, source.root_key, source.target.content_digest, source.body_bytes, ...parameters);
  database.connection.prepare(`UPDATE source_index_lexical_targets SET complete=1
    WHERE workspace_id=? AND generation_id=? AND root_key=?`).run(...parameters);
  database.connection.prepare(`DELETE FROM source_index_lexical_progress
    WHERE workspace_id=? AND generation_id=? AND root_key=?`).run(...parameters);
}
