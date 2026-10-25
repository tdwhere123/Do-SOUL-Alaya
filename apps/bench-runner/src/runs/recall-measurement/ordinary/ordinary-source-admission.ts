import { AlayaError, canonicalJson, sourceEvidenceRootTarget, sourceIndexTarget, sourceRecallTarget,
  type MemorySearchResult, type SourceEvidenceTarget } from "@do-soul/alaya-protocol";
import { authorizeSemanticScope, authorizeSourceIndexScope, fieldContractSha256, hydrateUtf8Chunk,
  resolveCurrentSource } from "@do-soul/alaya-core";
import { SqliteEvidenceCapsuleRepo, SqliteFieldSourceRecordRepo, SqliteSourceRootRecallReader,
  type StorageDatabase } from "@do-soul/alaya-storage";
import { sourceLookupStores } from "../../snapshot/source-records/publish.js";
import { admitEmittedSourcePreview } from "../library-admission.js";

/** Label-blind frozen ordinary admission. Retained capsules use their native kind,
 * revision, digest and retained extent, never a fabricated SourceRecord alias. */
export function admitOrdinarySourceDelivery(database: StorageDatabase, workspace: string,
  scopes: readonly string[] | null, target: SourceEvidenceTarget, result?: MemorySearchResult): void {
  if (target.workspace_id !== workspace) throw new AlayaError("CONFLICT", "ordinary source workspace changed");
  if (target.root_kind === "evidence_capsule") {
    admitCapsule(database, workspace, scopes, target, result);
    return;
  }
  const stores = sourceLookupStores(database), stored = stores.getStoredRecord(workspace, target.root_id);
  if (stored === null) throw new AlayaError("CONFLICT", "ordinary source unbound");
  const current = resolveCurrentSource(stores, workspace, { artifact_key: stored.record.source_id,
    source_corpus_digest: target.content_digest.replace(/^sha256:/u, "") }, fieldContractSha256);
  authorizeSemanticScope(current.record.scope_class, scopes);
  const expected = sourceRecallTarget({ ...current.record, root_kind: "source_record", root_id: current.record.identity });
  if (canonicalJson(sourceEvidenceRootTarget(target)) !== canonicalJson(expected)) {
    throw new AlayaError("CONFLICT", "ordinary source identity changed");
  }
  if (result !== undefined) admitEmittedSourcePreview(target.span, result, undefined, target, current.content_bytes, false);
}

function admitCapsule(database: StorageDatabase, workspace: string, scopes: readonly string[] | null,
  target: SourceEvidenceTarget, result?: MemorySearchResult): void {
  const reader = new SqliteSourceRootRecallReader(new SqliteFieldSourceRecordRepo(database, fieldContractSha256),
    new SqliteEvidenceCapsuleRepo(database));
  const span = target.span, offset = span?.content_start ?? 0;
  const read = reader.hydrate(workspace, target, 65536, offset, 1048576, 100000);
  if (read.unavailable || read.row === null) throw new AlayaError("CONFLICT", "ordinary retained capsule unavailable");
  const row = read.row;
  const expected = sourceRecallTarget({ workspace_id: row.workspace_id, root_kind: row.kind, root_id: row.root_id,
    source_version: row.revision, content_digest: row.digest, evidence_object_id: row.evidence_object_id });
  if (canonicalJson(sourceEvidenceRootTarget(target)) !== canonicalJson(expected)) {
    throw new AlayaError("CONFLICT", "ordinary retained capsule identity changed");
  }
  authorizeSourceIndexScope(row.scope_class ?? null, sourceIndexTarget(sourceEvidenceRootTarget(target), null, row.content_end), scopes);
  if (result === undefined) return;
  if (canonicalJson(result.target) !== canonicalJson(target) || span === undefined || span.retained_extent !== row.retained_extent
    || span.content_end > row.content_end || row.content === undefined) {
    throw new AlayaError("CONFLICT", "ordinary retained capsule span changed or exceeds admitted native read");
  }
  if (result.content_preview === "[payload omitted]" && !result.budget_state.within_budget) return;
  const text = result.content_preview === "[empty source]" && span.content_start === span.content_end ? "" : result.content_preview;
  const bytes = Buffer.byteLength(text, "utf8");
  const chunk = hydrateUtf8Chunk(row.content, { offset: 0, byteLimit: bytes });
  if (bytes > span.content_end - span.content_start || result.budget_state.within_budget && bytes !== span.content_end - span.content_start
    || chunk.status !== "chunk" || chunk.end_offset !== bytes || chunk.text !== text) {
    throw new AlayaError("CONFLICT", "ordinary retained capsule preview differs from sealed source");
  }
}
