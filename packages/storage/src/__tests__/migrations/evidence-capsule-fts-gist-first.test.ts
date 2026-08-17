import { afterEach, describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { insertEvidenceCapsule, openBaselineDatabase } from "./apply-baseline.js";

const databases = new Set<BetterSqlite3.Database>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("evidence capsule FTS gist-first", () => {
  it("indexes gist when excerpt is a narrow distilled fact", () => {
    const database = openBaselineDatabase();
    databases.add(database);
    insertEvidenceCapsule(database, "evidence-1", {
      excerpt: "I bought my bookshelf from IKEA.",
      gist: "User: I bought my bookshelf from IKEA. The patio table is weatherproof cedar."
    });

    expect(matchPorter(database, "weatherproof")).toEqual([
      { object_id: "evidence-1" }
    ]);
    expect(matchPorter(database, "bookshelf")).toEqual([
      { object_id: "evidence-1" }
    ]);
  });
});

function matchPorter(database: BetterSqlite3.Database, term: string) {
  return database.prepare(`
    SELECT object_id FROM evidence_capsule_fts WHERE evidence_capsule_fts MATCH ?
  `).all(term);
}
