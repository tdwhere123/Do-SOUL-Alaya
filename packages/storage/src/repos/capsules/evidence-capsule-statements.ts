import type BetterSqlite3 from "better-sqlite3";
import type { StorageDatabase } from "../../sqlite/db.js";
import { EVIDENCE_CAPSULE_SELECT_COLUMNS } from "./evidence-capsule-mappers.js";

export type SqliteStatement = BetterSqlite3.Statement;

export interface EvidenceCapsuleStatements {
  readonly createStatement: SqliteStatement;
  readonly findByIdStatement: SqliteStatement;
  readonly findByRunIdStatement: SqliteStatement;
  readonly findByRunIdPagedStatement: SqliteStatement;
  readonly findByWorkspaceIdStatement: SqliteStatement;
  readonly findByWorkspaceIdPagedStatement: SqliteStatement;
  readonly findByHealthStatement: SqliteStatement;
  readonly findByHealthPagedStatement: SqliteStatement;
  readonly updateHealthStatement: SqliteStatement;
  readonly searchByKeywordStatement: SqliteStatement;
  readonly searchByKeywordTrigramStatement: SqliteStatement;
}

export function prepareEvidenceCapsuleStatements(db: StorageDatabase): EvidenceCapsuleStatements {
  return {
    createStatement: db.connection.prepare(CREATE_EVIDENCE_CAPSULE_SQL),
    findByIdStatement: db.connection.prepare(findEvidenceCapsuleSql("byId", "limitOne")),
    findByRunIdStatement: db.connection.prepare(findEvidenceCapsuleSql("byRun")),
    findByRunIdPagedStatement: db.connection.prepare(findEvidenceCapsuleSql("byRun", "paged")),
    findByWorkspaceIdStatement: db.connection.prepare(findEvidenceCapsuleSql("byWorkspace")),
    findByWorkspaceIdPagedStatement: db.connection.prepare(
      findEvidenceCapsuleSql("byWorkspace", "paged")
    ),
    findByHealthStatement: db.connection.prepare(findEvidenceCapsuleSql("byHealth")),
    findByHealthPagedStatement: db.connection.prepare(
      findEvidenceCapsuleSql("byHealth", "paged")
    ),
    updateHealthStatement: db.connection.prepare(UPDATE_EVIDENCE_HEALTH_SQL),
    searchByKeywordStatement: db.connection.prepare(SEARCH_EVIDENCE_KEYWORD_SQL),
    searchByKeywordTrigramStatement: db.connection.prepare(SEARCH_EVIDENCE_KEYWORD_TRIGRAM_SQL)
  };
}

type EvidenceCapsuleWhereKey = "byId" | "byRun" | "byWorkspace" | "byHealth";
type EvidenceCapsuleSuffixKey = "limitOne" | "paged";

const EVIDENCE_CAPSULE_WHERE_CLAUSES: Readonly<Record<EvidenceCapsuleWhereKey, string>> = Object.freeze({
  byId: "object_id = ?",
  byRun: "run_id = ?",
  byWorkspace: "workspace_id = ?",
  byHealth: "evidence_health_state = ?"
});

const EVIDENCE_CAPSULE_SUFFIXES: Readonly<Record<EvidenceCapsuleSuffixKey, string>> = Object.freeze({
  limitOne: "LIMIT 1",
  paged: "LIMIT ? OFFSET ?"
});

function findEvidenceCapsuleSql(whereKey: EvidenceCapsuleWhereKey, suffixKey?: EvidenceCapsuleSuffixKey): string {
  const suffixSql = suffixKey === undefined ? "" : `\n      ${EVIDENCE_CAPSULE_SUFFIXES[suffixKey]}`;
  return `
      SELECT${EVIDENCE_CAPSULE_SELECT_COLUMNS}
      FROM evidence_capsules
      WHERE ${EVIDENCE_CAPSULE_WHERE_CLAUSES[whereKey]}
      ORDER BY created_at ASC, object_id ASC${suffixSql}
    `;
}

const CREATE_EVIDENCE_CAPSULE_SQL = `
      INSERT INTO evidence_capsules (
        object_id,
        object_kind,
        schema_version,
        lifecycle_state,
        created_at,
        updated_at,
        created_by,
        evidence_kind,
        semantic_anchor,
        event_anchor,
        physical_anchor,
        evidence_health_state,
        gist,
        excerpt,
        source_hash,
        run_id,
        workspace_id,
        surface_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const UPDATE_EVIDENCE_HEALTH_SQL = `
      UPDATE evidence_capsules
      SET evidence_health_state = ?, updated_at = ?
      WHERE object_id = ?
`;

const SEARCH_EVIDENCE_KEYWORD_SQL = `
      SELECT
        evidence_capsule_fts.object_id,
        bm25(evidence_capsule_fts) AS raw_rank
      FROM evidence_capsule_fts
      JOIN evidence_capsules ON evidence_capsules.object_id = evidence_capsule_fts.object_id
      WHERE
        evidence_capsule_fts.workspace_id = ?
        AND evidence_capsule_fts MATCH ?
        AND COALESCE(evidence_capsules.lifecycle_state, '') != 'retired'
      ORDER BY raw_rank ASC, evidence_capsule_fts.object_id ASC
      LIMIT ?
`;

const SEARCH_EVIDENCE_KEYWORD_TRIGRAM_SQL = `
      SELECT
        evidence_capsule_fts_trigram.object_id,
        bm25(evidence_capsule_fts_trigram) AS raw_rank
      FROM evidence_capsule_fts_trigram
      JOIN evidence_capsules
        ON evidence_capsules.object_id = evidence_capsule_fts_trigram.object_id
      WHERE
        evidence_capsule_fts_trigram.workspace_id = ?
        AND evidence_capsule_fts_trigram MATCH ?
        AND COALESCE(evidence_capsules.lifecycle_state, '') != 'retired'
      ORDER BY raw_rank ASC, evidence_capsule_fts_trigram.object_id ASC
      LIMIT ?
`;
