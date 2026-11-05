import BetterSqlite3 from "better-sqlite3";
import { initDatabase, initializeSemanticArtifactCandidateSchema } from "@do-soul/alaya-storage";
import { describe, expect, it } from "vitest";
import { createSqliteCatalogReader } from "../../../runs/snapshot/recall-eval/workspace-slice/catalog-reader.js";
import { classifyPackedTables } from "../../../runs/snapshot/recall-eval/workspace-slice/classify-tables.js";
import { GLOBAL_TABLE_POLICY } from "../../../runs/snapshot/recall-eval/workspace-slice/handled-global.js";

describe("workspace slice catalog boundaries", () => {
  it("classifies the complete migrated schema and binds each FK policy to a workspace-scoped parent", () => {
    const database = initDatabase({ filename: ":memory:" });
    try {
      initializeSemanticArtifactCandidateSchema(database.connection);
      const reader = createSqliteCatalogReader(database.connection);
      const catalog = classifyPackedTables(reader);
      expect(catalog.global.map(table => table.name).sort()).toEqual(Object.keys(GLOBAL_TABLE_POLICY).sort());
      for (const { name, policy } of catalog.global) {
        if (policy.action !== "copy_via_fk") continue;
        for (const reference of policy.references) {
          expect(catalog.workspace.map(table => table.name), name).toContain(reference.parentTable);
          expect(reader.listColumns(reference.parentTable).map(column => column.name), name)
            .toContain(reference.parentKey);
          const foreignKeys = database.connection.prepare("SELECT * FROM pragma_foreign_key_list(?)").all(name);
          expect(foreignKeys, name).toEqual(expect.arrayContaining([expect.objectContaining({
            table: reference.parentTable, from: reference.childKey, to: reference.parentKey
          })]));
        }
      }
    } finally {
      database.close();
    }
  });

  it("ignores genuine SQLite FTS shadows but preserves ordinary workspace tables with an FTS prefix", () => {
    const database = new BetterSqlite3(":memory:");
    try {
      database.exec(`CREATE VIRTUAL TABLE memory_content_fts_porter USING fts5(content);
        CREATE TABLE memory_content_fts_porter_audit (workspace_id TEXT NOT NULL, id TEXT)`);
      const reader = createSqliteCatalogReader(database);
      const catalog = classifyPackedTables(reader);
      expect(catalog.ftsVirtual).toEqual(["memory_content_fts_porter"]);
      expect(catalog.workspace).toEqual([{
        kind: "workspace", name: "memory_content_fts_porter_audit", columns: ["workspace_id", "id"]
      }]);
      const actualShadows = database.prepare("SELECT name FROM pragma_table_list WHERE type = 'shadow' ORDER BY name")
        .all();
      expect(actualShadows.length).toBeGreaterThan(0);
      expect(reader.listObjects().filter(object => object.type === "shadow").map(({ name }) => ({ name })))
        .toEqual(actualShadows);
    } finally {
      database.close();
    }
  });

  it.each(["memory_content_fts_porter_audit", "sqlitecustom", "unhandled_task_child", "constructor", "__proto__", "toString"])(
    "fails closed on unscoped ordinary table %s regardless of its name",
    (name) => {
      const database = new BetterSqlite3(":memory:");
      try {
        database.exec(`CREATE VIRTUAL TABLE memory_content_fts_porter USING fts5(content);
          CREATE TABLE "${name}" (id TEXT PRIMARY KEY)`);
        expect(() => classifyPackedTables(createSqliteCatalogReader(database)))
          .toThrow(`unhandled table ${name} without workspace_id`);
      } finally {
        database.close();
      }
    }
  );
});
