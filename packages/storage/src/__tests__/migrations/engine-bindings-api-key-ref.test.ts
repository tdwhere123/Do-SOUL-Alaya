import { afterEach, describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { SqliteEngineBindingRepo } from "../../repos/control/engine-binding-repo.js";
import { StorageDatabase } from "../../sqlite/db.js";
import { openBaselineDatabase, seedWorkspaceRow } from "./apply-baseline.js";

const openDbs = new Set<BetterSqlite3.Database>();

afterEach(() => {
  for (const db of openDbs) {
    db.close();
  }
  openDbs.clear();
});

describe("engine_bindings.api_key_ref", () => {
  it("supports ref-only upsert round-trip", async () => {
    const db = openBaselineDatabase();
    openDbs.add(db);
    seedWorkspaceRow(db, "workspace-1");

    const columns = db
      .prepare(`PRAGMA table_info(engine_bindings)`)
      .all() as Array<{ readonly name: string }>;
    expect(columns.some((column) => column.name === "api_key_ref")).toBe(true);

    const database = new StorageDatabase(":memory:", db);
    const repo = new SqliteEngineBindingRepo(database);
    const saved = repo.upsert({
      binding_id: "binding-ref-103",
      workspace_id: "workspace-1",
      provider_type: "openai",
      base_url: null,
      api_key: "",
      api_key_ref: "OPENAI_API_KEY",
      model: "gpt-4o-mini",
      config: {},
      enable_tools: true
    });

    expect(saved.api_key_ref).toBe("OPENAI_API_KEY");
    expect(await repo.getById("binding-ref-103")).toEqual(saved);
  });
});
