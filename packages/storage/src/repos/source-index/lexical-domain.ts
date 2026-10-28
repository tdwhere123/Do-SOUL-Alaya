import { FieldContractDigestSchema } from "@do-soul/alaya-protocol";
import type { SqliteConnection } from "../../sqlite/db.js";
import { readRecord, readStringField } from "../shared/parse-row.js";

/** Only validated generation digests become SQL identifiers. Both lanes share one corpus owner. */
export function lexicalDomainTables(generationId: string) {
  const digest = FieldContractDigestSchema.parse(generationId).slice("sha256:".length);
  return { unicode61: `source_lexical_${digest}_unicode61`, trigram: `source_lexical_${digest}_trigram` };
}

export function isLexicalDomainTable(name: string): boolean {
  return /^source_lexical_[a-f0-9]{64}_(unicode61|trigram)$/u.test(name);
}

export function isLexicalDomainTrigger(name: string): boolean {
  const suffix = /_(?:update_)?(?:insert|delete)$/u.exec(name);
  return suffix !== null && isLexicalDomainTable(name.slice(0, suffix.index));
}

/** Contentless-delete indexes retain tokens, never another copy of native evidence bytes.
 * SQLite triggers keep invalidation/erasure atomic with the existing projection owner, including
 * raw-text loss. Deletion needs only rowid, so even AFTER raw replacement can scrub old tokens. */
export function createLexicalDomain(connection: Pick<SqliteConnection, "exec" | "prepare">, workspaceId: string, generationId: string): void {
  const tables = lexicalDomainTables(generationId);
  const workspace = `'${workspaceId.replaceAll("'", "''")}'`, generation = `'${generationId}'`;
  const matches = (row: string) => `${row}.workspace_id=${workspace} AND ${row}.generation_id=${generation}`;
  for (const [lane, table] of Object.entries(tables)) {
    connection.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING fts5(body,
      content='',contentless_delete=1,tokenize='${lane}')`);
    const insert = `INSERT INTO ${table}(rowid,body) ${lane === "unicode61" ? "VALUES(NEW.id,NEW.projection)"
      : "SELECT NEW.id,body FROM source_index_text WHERE workspace_id=NEW.workspace_id AND root_key=NEW.root_key"};`;
    connection.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_insert AFTER INSERT ON source_index_lexical_projections
      WHEN ${matches("NEW")} BEGIN ${insert} END;
      CREATE TRIGGER IF NOT EXISTS ${table}_delete AFTER DELETE ON source_index_lexical_projections
      WHEN ${matches("OLD")} BEGIN DELETE FROM ${table} WHERE rowid=OLD.id; END;
      CREATE TRIGGER IF NOT EXISTS ${table}_update_delete BEFORE UPDATE ON source_index_lexical_projections
      WHEN ${matches("OLD")} BEGIN DELETE FROM ${table} WHERE rowid=OLD.id; END;
      CREATE TRIGGER IF NOT EXISTS ${table}_update_insert AFTER UPDATE ON source_index_lexical_projections
      WHEN ${matches("NEW")} BEGIN ${insert} END;`);
  }
}

export function dropLexicalDomain(connection: Pick<SqliteConnection, "exec" | "prepare">, generationId: string): void {
  for (const table of Object.values(lexicalDomainTables(generationId))) {
    for (const suffix of ["insert", "delete", "update_delete", "update_insert"]) {
      connection.exec(`DROP TRIGGER IF EXISTS ${table}_${suffix}`);
    }
    connection.exec(`DROP TABLE IF EXISTS ${table}`);
  }
}

/** Migration and the offline workspace-snapshot copier rebuild from the same projection authority.
 * Caller owns atomic publication (migration transaction or sealed offline copy). No native/source or
 * lifecycle state is changed. Ordinary query/preparation paths never call this whole-corpus entry. */
export function rebuildSourceIndexLexicalDomains(connection: Pick<SqliteConnection, "exec" | "prepare">): void {
  // An offline slice may replace the entire workspace set. Remove its old domains as well as
  // rebuilding the new set, so absent generations leave neither orphan indexes nor stale triggers.
  const obsolete = new Set(connection.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
    .map(raw => readStringField(readRecord(raw, "lexical domain table"), "name"))
    .filter(isLexicalDomainTable).map(name => `sha256:${name.split("_")[2]}`));
  for (const generation of obsolete) dropLexicalDomain(connection, generation);
  for (const raw of connection.prepare("SELECT workspace_id,generation_id FROM source_index_lexical_generations").all()) {
    const row = readRecord(raw, "lexical domain generation"), workspace = readStringField(row, "workspace_id");
    const generation = readStringField(row, "generation_id"), tables = lexicalDomainTables(generation);
    createLexicalDomain(connection, workspace, generation);
    connection.prepare(`INSERT INTO ${tables.unicode61}(rowid,body) SELECT id,projection
      FROM source_index_lexical_projections WHERE workspace_id=? AND generation_id=?`).run(workspace, generation);
    connection.prepare(`INSERT INTO ${tables.trigram}(rowid,body) SELECT p.id,x.body FROM source_index_lexical_projections p
      JOIN source_index_text x ON x.workspace_id=p.workspace_id AND x.root_key=p.root_key
      WHERE p.workspace_id=? AND p.generation_id=?`).run(workspace, generation);
  }
}
