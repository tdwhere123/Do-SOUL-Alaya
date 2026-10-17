import { quoteIdent } from "./names.js";

export interface FtsRebuildConnection {
  exec(sql: string): unknown;
  prepare(sql: string): { all(): unknown[] };
}

interface FtsRebuildSpec {
  readonly fts: string;
  /** replace: DELETE then sql. native_rebuild: sql only; never DELETE (external content). */
  readonly mode: "replace" | "native_rebuild";
  readonly sql: string;
}

const FTS_REBUILDS: readonly FtsRebuildSpec[] = Object.freeze([
  {
    fts: "memory_content_fts",
    mode: "replace",
    sql: `INSERT INTO memory_content_fts (rowid, object_id, workspace_id, content)
      SELECT rowid, object_id, workspace_id, content FROM memory_entries`
  },
  {
    fts: "memory_content_fts_porter",
    mode: "replace",
    sql: `INSERT INTO memory_content_fts_porter (rowid, object_id, workspace_id, content)
      SELECT rowid, object_id, workspace_id, content FROM memory_entries`
  },
  {
    fts: "evidence_capsule_fts",
    mode: "replace",
    sql: `INSERT INTO evidence_capsule_fts (rowid, object_id, workspace_id, content)
      SELECT rowid, object_id, workspace_id, COALESCE(gist, excerpt) FROM evidence_capsules`
  },
  {
    fts: "evidence_capsule_fts_trigram",
    mode: "replace",
    sql: `INSERT INTO evidence_capsule_fts_trigram (rowid, object_id, workspace_id, content)
      SELECT rowid, object_id, workspace_id, COALESCE(gist, excerpt) FROM evidence_capsules`
  },
  {
    fts: "synthesis_capsule_fts",
    mode: "replace",
    sql: `INSERT INTO synthesis_capsule_fts (rowid, object_id, workspace_id, content)
      SELECT rowid, object_id, workspace_id, summary FROM synthesis_capsules`
  },
  {
    fts: "synthesis_capsule_fts_trigram",
    mode: "replace",
    sql: `INSERT INTO synthesis_capsule_fts_trigram (rowid, object_id, workspace_id, content)
      SELECT rowid, object_id, workspace_id, summary FROM synthesis_capsules`
  },
  {
    fts: "evidence_search_projection_fts",
    mode: "replace",
    sql: `INSERT INTO evidence_search_projection_fts (
        rowid, evidence_object_id, projection_id, projection_kind, workspace_id, content
      ) SELECT rowid, evidence_object_id, projection_id, projection_kind, workspace_id, content
        FROM evidence_search_projections`
  },
  {
    fts: "evidence_search_projection_fts_trigram",
    mode: "replace",
    sql: `INSERT INTO evidence_search_projection_fts_trigram (
        rowid, evidence_object_id, projection_id, projection_kind, workspace_id, content
      ) SELECT rowid, evidence_object_id, projection_id, projection_kind, workspace_id, content
        FROM evidence_search_projections`
  },
  {
    fts: "memory_object_key_fts",
    mode: "replace",
    sql: `INSERT INTO memory_object_key_fts (rowid, owner_id, workspace_id, content)
      SELECT rowid, owner_id, workspace_id, surface FROM memory_object_keys`
  },
  {
    fts: "memory_object_key_fts_trigram",
    mode: "replace",
    sql: `INSERT INTO memory_object_key_fts_trigram (rowid, owner_id, workspace_id, content)
      SELECT rowid, owner_id, workspace_id, surface FROM memory_object_keys`
  },
  {
    fts: "garden_semantic_fts",
    mode: "replace",
    sql: `INSERT INTO garden_semantic_fts (workspace_id, object_id, search_text)
      SELECT workspace_id, object_id, search_text FROM garden_semantic_projections`
  },
  {
    fts: "source_index_fts",
    mode: "native_rebuild",
    sql: "INSERT INTO source_index_fts(source_index_fts) VALUES('rebuild')"
  },
  {
    fts: "source_index_fts_trigram",
    mode: "native_rebuild",
    sql: "INSERT INTO source_index_fts_trigram(source_index_fts_trigram) VALUES('rebuild')"
  }
]);

export function rebuildWorkspaceFts(
  connection: FtsRebuildConnection,
  ftsVirtual: readonly string[]
): void {
  const known = new Set(FTS_REBUILDS.map((spec) => spec.fts));
  for (const name of ftsVirtual) {
    if (!known.has(name)) {
      throw new Error(`packed working copy has unhandled FTS table ${name}`);
    }
  }
  for (const spec of FTS_REBUILDS) {
    if (!ftsVirtual.includes(spec.fts)) continue;
    if (spec.mode === "replace") connection.exec(`DELETE FROM ${quoteIdent(spec.fts)}`);
    connection.exec(spec.sql);
  }
}
