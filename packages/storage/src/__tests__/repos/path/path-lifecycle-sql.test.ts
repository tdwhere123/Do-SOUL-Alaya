import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";

const lifecycleRows = [
  ["legacy", '{"retirement_rule":"manual"}'],
  ["active", '{"retirement_rule":"manual","status":"active"}'],
  ["dormant", '{"retirement_rule":"manual","status":"dormant"}'],
  ["retired", '{"retirement_rule":"manual","status":"retired"}'],
  ["unknown", '{"retirement_rule":"manual","status":"unknown"}'],
  ["null", '{"retirement_rule":"manual","status":null}'],
  ["extra", '{"retirement_rule":"manual","status":"active","extra":true}'],
  ["missing_rule", '{"status":"active"}'],
  ["malformed", "{"]
] as const;

function selectLifecycleIds(predicate: string): string[] {
  const database = new Database(":memory:");
  try {
    database.exec("CREATE TABLE paths (ordinal INTEGER, id TEXT, lifecycle_json TEXT)");
    const insert = database.prepare("INSERT INTO paths VALUES (?, ?, ?)");
    lifecycleRows.forEach(([id, json], ordinal) => insert.run(ordinal, id, json));
    const rows = database.prepare(`SELECT id FROM paths WHERE ${predicate} ORDER BY ordinal`).all() as { id: string }[];
    return rows.map(row => row.id);
  } finally {
    database.close();
  }
}

afterEach(() => {
  vi.doUnmock("@do-soul/alaya-protocol");
  vi.resetModules();
});

it("keeps legacy and active rows while excluding inactive and malformed lifecycles", async () => {
  const { ACTIVE_PATH_LIFECYCLE_SQL } = await import("../../../repos/path/statements/path-relation-sql.js");
  expect(selectLifecycleIds(ACTIVE_PATH_LIFECYCLE_SQL)).toEqual(["legacy", "active"]);
});

it("derives SQL membership from the protocol instead of retaining an independent active default", async () => {
  vi.resetModules();
  vi.doMock("@do-soul/alaya-protocol", async () => {
    const protocol = await vi.importActual<typeof import("@do-soul/alaya-protocol")>("@do-soul/alaya-protocol");
    return { ...protocol, isPathActiveForRecall: (status: string | undefined) => status === "dormant" };
  });
  const { ACTIVE_PATH_LIFECYCLE_SQL } = await import("../../../repos/path/statements/path-relation-sql.js");
  expect(selectLifecycleIds(ACTIVE_PATH_LIFECYCLE_SQL)).toEqual(["dormant"]);
});
