import { afterEach, describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { insertEvidenceCapsule, openBaselineDatabase } from "./apply-baseline.js";

const databases = new Set<BetterSqlite3.Database>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("associative fact-key projections", () => {
  it("indexes fact keys in both lexical lanes", () => {
    const database = openBaselineDatabase();
    databases.add(database);
    insertEvidenceCapsule(database, "evidence-1", { gist: "I use Atlas" });
    database.prepare(`
      INSERT INTO evidence_search_projections (
        evidence_object_id, projection_id, projection_kind,
        workspace_id, source_hash, content
      ) VALUES ('evidence-1', 1, 'fact_key', 'workspace-1', 'hash-1', ?)
    `).run("I use Atlas");

    expect(database.prepare(`
      SELECT projection_kind FROM evidence_search_projection_fts
      WHERE evidence_search_projection_fts MATCH ?
    `).all('content:"Atlas"')).toEqual([{ projection_kind: "fact_key" }]);
    expect(database.prepare(`
      SELECT projection_kind FROM evidence_search_projection_fts_trigram
      WHERE evidence_search_projection_fts_trigram MATCH ?
    `).all('content:"Atlas"')).toEqual([{ projection_kind: "fact_key" }]);
  });
});
