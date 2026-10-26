import { canonicalJson, type SourceIndexBudget, type SourceIndexCaptureResult, type SourceIndexTarget } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { BoundedCapsuleSourceReader } from "../capsules/reads/bounded-capsule-source-reader.js";
import { encodeCapsuleCursor, parseCapsuleCursor } from "../capsules/evidence-capsule-repo.js";
import type { SqliteFieldSourceRecordRepo } from "../field/source-repo.js";
import { capsuleReadCost, capsuleTargetFromRead } from "./capsule-source.js";
import { requireSourceIndexGeneration, sourceIndexBuildGuard } from "./generation-state.js";
import { guardSourceIndexTarget, sourceReadCost, sourceTargetFromRead } from "./native-source.js";

/** Persist roots/dependencies in the enclosing lifecycle transaction. Identity keys include root kind. */
function persistSourceIndexRoot(database: StorageDatabase, source: SourceIndexTarget, dependencies: readonly string[],
  budget: SourceIndexBudget, resources: { work: number; native_bytes: number }): boolean {
  if (budget.work - resources.work < dependencies.length) return false;
  database.connection.prepare(`INSERT INTO source_index_roots
    (workspace_id,root_key,root_kind,record_id,source_id,target_json) VALUES(?,?,?,?,?,?)
    ON CONFLICT(workspace_id,root_key) DO UPDATE SET target_json=excluded.target_json`)
    .run(source.target.workspace_id, source.root_key, source.target.root_kind, source.target.root_id, source.source_id, canonicalJson(source));
  database.connection.prepare(`DELETE FROM source_index_dependencies WHERE workspace_id=? AND root_key=?`)
    .run(source.target.workspace_id, source.root_key);
  const insert = database.connection.prepare(`INSERT INTO source_index_dependencies
    (workspace_id,root_key,dependency_kind,dependency_record_id,dependency_source_id)
    SELECT workspace_id,?,'source_record',record_id,source_id FROM source_records WHERE workspace_id=? AND record_id=?`);
  for (const id of dependencies) { insert.run(source.root_key, source.target.workspace_id, id); resources.work++; }
  return true;
}

/** Exact retained bytes shared by all vector profiles and the raw/default lexical reader. */
export function persistSourceIndexLexical(database: StorageDatabase, source: SourceIndexTarget, body: string,
  dependencies: readonly string[], budget: SourceIndexBudget, resources: { work: number; native_bytes: number }): boolean {
  if (!persistSourceIndexRoot(database, source, dependencies, budget, resources)) return false;
  database.connection.prepare(`INSERT INTO source_index_text(workspace_id,root_key,content_digest,body_bytes,body)
    VALUES(?,?,?,?,?) ON CONFLICT(workspace_id,root_key) DO UPDATE SET content_digest=excluded.content_digest,
    body_bytes=excluded.body_bytes,body=excluded.body`).run(source.target.workspace_id, source.root_key,
    source.target.content_digest, source.body_bytes, body);
  return true;
}

/** Both physical families resume durably; rejected and empty reads spend the same capture ledger. */
export function captureSourceIndexTargets(database: StorageDatabase, records: SqliteFieldSourceRecordRepo,
  input: { workspaceId: string; generationId: string; limit: number; budget: SourceIndexBudget },
  resources: { work: number; native_bytes: number }): SourceIndexCaptureResult {
  let generation = requireSourceIndexGeneration(database, input.workspaceId, input.generationId);
  if (sourceIndexBuildGuard(database, generation) !== null || generation.enumeration_complete || generation.status === "failed") {
    return { generation, added: 0, resources };
  }
  const page = enumerateSourceIndexTargets(database, records, { ...input, ...generation }, resources, source =>
    database.connection.prepare(`INSERT INTO source_index_targets
      (workspace_id,generation_id,root_key) VALUES(?,?,?) ON CONFLICT DO NOTHING`)
      .run(input.workspaceId, input.generationId, source.root_key).changes);
  database.connection.prepare(`UPDATE source_index_generations SET after_source_id=?, after_capsule_cursor=?, records_complete=?,
    enumeration_complete=?,status=?,reason=? WHERE workspace_id=? AND generation_id=?`)
    .run(page.after_source_id, page.after_capsule_cursor, page.records_complete ? 1 : 0,
      page.enumeration_complete ? 1 : 0, page.enumeration_complete ? "building" : "partial", page.reason,
      input.workspaceId, input.generationId);
  generation = requireSourceIndexGeneration(database, input.workspaceId, input.generationId);
  return { generation, added: page.added, resources };
}

/** One bounded native census for lexical and vector preparation; bookkeeping belongs to each generation. */
export function enumerateSourceIndexTargets(database: StorageDatabase, records: SqliteFieldSourceRecordRepo,
  input: { workspaceId: string; limit: number; budget: SourceIndexBudget; after_source_id: string | null;
    after_capsule_cursor: string | null; records_complete: boolean },
  resources: { work: number; native_bytes: number }, accept: (source: SourceIndexTarget) => number) {
  let cursor = input.after_source_id, capsulesCursor = input.after_capsule_cursor;
  let recordsDone = input.records_complete, added = 0, complete = false, reason: string | null = null;
  const remaining = () => ({ work: input.budget.work - resources.work, native_bytes: input.budget.native_bytes - resources.native_bytes });
  for (let index = 0; index < input.limit; index++) {
    if (remaining().work < 320 || remaining().native_bytes < 262144) { reason = "enumeration_budget"; break; }
    let source: SourceIndexTarget | null;
    let nextRecord = cursor, nextCapsule = capsulesCursor;
    if (!recordsDone) {
      const read = records.findNextCurrentBounded(input.workspaceId, cursor, 4,
        { workLimit: remaining().work, nativeByteLimit: remaining().native_bytes });
      if (read === null) { resources.work++; recordsDone = true; continue; }
      const cost = sourceReadCost(read); resources.work += cost.work; resources.native_bytes += cost.native_bytes;
      if (read.record === null || read.resourceLimited || read.record.source_body === null && read.bodyBytes > 0) {
        reason = "native_source_unknown"; break;
      }
      source = sourceTargetFromRead(read); nextRecord = read.record.source_id;
    } else {
      const read = new BoundedCapsuleSourceReader(database).page(input.workspaceId, parseCapsuleCursor(capsulesCursor), 1, 4)[0];
      if (read === undefined) { resources.work++; complete = true; break; }
      const cost = capsuleReadCost(read); resources.work += cost.work; resources.native_bytes += cost.native_bytes;
      if (typeof read.created_at !== "string" || typeof read.object_id !== "string") { reason = "native_source_unknown"; break; }
      source = read.linked === 1 ? null : capsuleTargetFromRead(read);
      if (read.linked !== 1 && source === null) { reason = "native_source_unknown"; break; }
      nextCapsule = encodeCapsuleCursor({ afterCreatedAt: read.created_at, afterObjectId: read.object_id });
    }
    if (source !== null) {
      const available = guardSourceIndexTarget(database, records, source, remaining());
      resources.work += available.resources.work; resources.native_bytes += available.resources.native_bytes;
      if (available.status === "partial") {
        reason = available.reason === "read_budget" ? "enumeration_budget" : "native_source_unknown"; break;
      }
      if (available.status === "ready") {
        if (!persistSourceIndexRoot(database, source, available.dependencies, input.budget, resources)) { reason = "enumeration_budget"; break; }
        added += accept(source);
      }
    }
    cursor = nextRecord; capsulesCursor = nextCapsule;
  }
  if (!complete && reason === null) reason = "enumeration_page";
  return { after_source_id: cursor, after_capsule_cursor: capsulesCursor, records_complete: recordsDone,
    enumeration_complete: complete, added, reason };

}
