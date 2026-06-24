import type BetterSqlite3 from "better-sqlite3";
import type { StorageDatabase } from "../../sqlite/db.js";

export type SqliteStatement = BetterSqlite3.Statement;

export interface SynthesisCapsuleStatements {
  readonly createStatement: SqliteStatement;
  readonly findByIdStatement: SqliteStatement;
  readonly findByWorkspaceIdStatement: SqliteStatement;
  readonly findByTopicKeyStatement: SqliteStatement;
  readonly updateEvidenceRefsStatement: SqliteStatement;
  readonly updateSourceMemoryRefsStatement: SqliteStatement;
  readonly updateStatusStatement: SqliteStatement;
  readonly searchByKeywordStatement: SqliteStatement;
  readonly searchByKeywordTrigramStatement: SqliteStatement;
}

export function prepareSynthesisCapsuleStatements(db: StorageDatabase): SynthesisCapsuleStatements {
  return {
    createStatement: db.connection.prepare(CREATE_SYNTHESIS_CAPSULE_SQL),
    findByIdStatement: db.connection.prepare(findSynthesisCapsuleSql("object_id = ?", "LIMIT 1")),
    findByWorkspaceIdStatement: db.connection.prepare(findSynthesisCapsuleSql("workspace_id = ?")),
    findByTopicKeyStatement: db.connection.prepare(
      findSynthesisCapsuleSql("workspace_id = ?\n        AND topic_key = ?")
    ),
    updateEvidenceRefsStatement: db.connection.prepare(updateRefsSql("evidence_refs")),
    updateSourceMemoryRefsStatement: db.connection.prepare(updateRefsSql("source_memory_refs")),
    updateStatusStatement: db.connection.prepare(`
      UPDATE synthesis_capsules
      SET synthesis_status = ?, updated_at = ?
      WHERE object_id = ?
    `),
    searchByKeywordStatement: db.connection.prepare(SEARCH_SYNTHESIS_KEYWORD_SQL),
    searchByKeywordTrigramStatement: db.connection.prepare(SEARCH_SYNTHESIS_KEYWORD_TRIGRAM_SQL)
  };
}

function findSynthesisCapsuleSql(whereClause: string, suffix = ""): string {
  const suffixSql = suffix.length === 0 ? "" : `\n      ${suffix}`;
  return `
      SELECT${SYNTHESIS_SELECT_COLUMNS}
      FROM synthesis_capsules
      WHERE ${whereClause}
      ORDER BY created_at ASC, object_id ASC${suffixSql}
    `;
}

function updateRefsSql(columnName: "evidence_refs" | "source_memory_refs"): string {
  return `
      UPDATE synthesis_capsules
      SET ${columnName} = ?, updated_at = ?
      WHERE object_id = ?
    `;
}

export const SYNTHESIS_SELECT_COLUMNS = `
        object_id,
        object_kind,
        schema_version,
        lifecycle_state,
        created_at,
        updated_at,
        created_by,
        topic_key,
        synthesis_type,
        summary,
        evidence_refs,
        source_memory_refs,
        workspace_id,
        run_id,
        synthesis_status
`;

const CREATE_SYNTHESIS_CAPSULE_SQL = `
      INSERT INTO synthesis_capsules (
        object_id,
        object_kind,
        schema_version,
        lifecycle_state,
        created_at,
        updated_at,
        created_by,
        topic_key,
        synthesis_type,
        summary,
        evidence_refs,
        source_memory_refs,
        workspace_id,
        run_id,
        synthesis_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const SEARCH_SYNTHESIS_KEYWORD_SQL = `
      SELECT
        synthesis_capsule_fts.object_id,
        bm25(synthesis_capsule_fts) AS raw_rank
      FROM synthesis_capsule_fts
      JOIN synthesis_capsules ON synthesis_capsules.object_id = synthesis_capsule_fts.object_id
      WHERE
        synthesis_capsule_fts.workspace_id = ?
        AND synthesis_capsule_fts MATCH ?
        AND COALESCE(synthesis_capsules.lifecycle_state, '') != 'retired'
      ORDER BY raw_rank ASC, synthesis_capsule_fts.object_id ASC
      LIMIT ?
`;

const SEARCH_SYNTHESIS_KEYWORD_TRIGRAM_SQL = `
      SELECT
        synthesis_capsule_fts_trigram.object_id,
        bm25(synthesis_capsule_fts_trigram) AS raw_rank
      FROM synthesis_capsule_fts_trigram
      JOIN synthesis_capsules
        ON synthesis_capsules.object_id = synthesis_capsule_fts_trigram.object_id
      WHERE
        synthesis_capsule_fts_trigram.workspace_id = ?
        AND synthesis_capsule_fts_trigram MATCH ?
        AND COALESCE(synthesis_capsules.lifecycle_state, '') != 'retired'
      ORDER BY raw_rank ASC, synthesis_capsule_fts_trigram.object_id ASC
      LIMIT ?
`;
