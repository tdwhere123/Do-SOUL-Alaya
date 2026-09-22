import type BetterSqlite3 from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteSourceHintReader } from "../../../repos/field/source-hint-reader.js";
import { initDatabase } from "../../../sqlite/db.js";
import { openReadOnlyDatabase } from "../../../sqlite/open-readonly.js";
import { insertEvidenceCapsule, openBaselineDatabase } from "../../migrations/apply-baseline.js";

const databases = new Set<BetterSqlite3.Database>();
afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases) database.close();
  databases.clear();
});
const input = { workspaceId: "workspace-1", query: "orchid", limit: 16,
  nativeLimit: 34, nativeByteLimit: 100_000, afterCursor: null };

function setup() {
  const database = openBaselineDatabase();
  databases.add(database);
  return { database, reader: new SqliteSourceHintReader(database) };
}

function traceReads(database: BetterSqlite3.Database) {
  const statements: { sql: string; statement: BetterSqlite3.Statement }[] = [];
  const prepare = database.prepare.bind(database);
  vi.spyOn(database, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    vi.spyOn(statement, "get");
    statements.push({ sql, statement });
    return statement;
  });
  return statements;
}

describe("interpretation text hint native boundaries", () => {
  it("charges terminal empty seeks without inventing candidates", () => {
    const { reader } = setup();
    expect(reader.pageInterpretationTextHints(input)).toMatchObject({ rows: [], inspectedCandidates: 0,
      nativeVisits: 1, bytesRead: 24, truncated: false, resourceLimited: false, unavailable: false });
  });

  it("charges inactive and exact-workspace rejects and resumes after inspected candidates", () => {
    const { database, reader } = setup();
    insertEvidenceCapsule(database, "inactive", { gist: "orchid" });
    database.prepare("UPDATE evidence_capsules SET lifecycle_state='retired' WHERE object_id='inactive'").run();
    insertEvidenceCapsule(database, "other-workspace", { gist: "orchid", workspaceId: "workspace.1" });
    insertEvidenceCapsule(database, "eligible", { gist: "orchid" });
    const first = reader.pageInterpretationTextHints({ ...input, limit: 2 });
    expect(first).toMatchObject({ rows: [], inspectedCandidates: 2, nativeVisits: 4, truncated: true });
    const next = reader.pageInterpretationTextHints({ ...input, afterCursor: first.committedThrough });
    expect(next.rows.map((row) => row.object_id)).toEqual(["eligible"]);
    expect(next).toMatchObject({ inspectedCandidates: 1, nativeVisits: 3, truncated: false });
  });

  it("traverses the entire signed 64-bit rowid domain and charges the final empty seek", () => {
    const { database, reader } = setup();
    insertEvidenceCapsule(database, "template", { gist: "unrelated" });
    const insert = database.prepare(`INSERT INTO evidence_capsules
      (rowid,object_id,created_at,updated_at,created_by,evidence_kind,semantic_anchor,gist,run_id,workspace_id)
      SELECT ?,?,created_at,updated_at,created_by,evidence_kind,semantic_anchor,'orchid',run_id,workspace_id
      FROM evidence_capsules WHERE object_id='template'`);
    const rowids = [-9223372036854775808n, -9007199254740993n, -1n, 0n, 9007199254740992n,
      9007199254740993n, 9223372036854775806n, 9223372036854775807n];
    for (const rowid of rowids) insert.run(rowid, `row-${rowid}`);
    let cursor: string | null = null;
    for (const rowid of rowids) {
      const page = reader.pageInterpretationTextHints({ ...input, limit: 1, afterCursor: cursor });
      expect(page.rows.map((row) => row.object_id)).toEqual([`row-${rowid}`]);
      expect(page).toMatchObject({ inspectedCandidates: 1, nativeVisits: 2, truncated: true, unavailable: false });
      expect(page.committedThrough).toContain(`"${rowid}"`);
      cursor = page.committedThrough;
    }
    expect(reader.pageInterpretationTextHints({ ...input, afterCursor: cursor })).toMatchObject({
      rows: [], inspectedCandidates: 0, nativeVisits: 1, bytesRead: 24, truncated: false, unavailable: false
    });
  });

  it("binds continuation to the original query, workspace and valid lane state before native reads", () => {
    const { database, reader } = setup();
    insertEvidenceCapsule(database, "first", { gist: "orchid" });
    const first = reader.pageInterpretationTextHints({ ...input, limit: 1 });
    const cursor = JSON.parse(first.committedThrough);
    const statements = traceReads(database);
    expect(() => reader.pageInterpretationTextHints({ ...input, workspaceId: "workspace-2", afterCursor: first.committedThrough }))
      .toThrow(/cursor/u);
    expect(() => reader.pageInterpretationTextHints({ ...input, query: "orchid 가나다", afterCursor: first.committedThrough }))
      .toThrow(/cursor/u);
    for (const patch of [{ rowids: ["1"] }, { done: [false, false] }, { turn: 2 }]) {
      expect(() => reader.pageInterpretationTextHints({ ...input, afterCursor: JSON.stringify({ ...cursor, ...patch }) }))
        .toThrow(/cursor/u);
    }
    for (const invalid of ["9223372036854775808", "-9223372036854775809", "01", "1.0", "-0", 9007199254740992]) {
      expect(() => reader.pageInterpretationTextHints({ ...input,
        afterCursor: JSON.stringify({ ...cursor, rowids: [invalid, null] }) })).toThrow(/rowid/u);
    }
    expect(statements).toEqual([]);
  });

  it("shares the inspected-candidate cap across porter and trigram lanes and resumes each lane", () => {
    const { database, reader } = setup();
    insertEvidenceCapsule(database, "porter-1", { gist: "orchid" });
    insertEvidenceCapsule(database, "porter-2", { gist: "orchid" });
    insertEvidenceCapsule(database, "trigram-1", { gist: "가나다" });
    insertEvidenceCapsule(database, "trigram-2", { gist: "가나다" });
    const query = "orchid 가나다";
    const first = reader.pageInterpretationTextHints({ ...input, query, limit: 2 });
    expect(new Set(first.rows.map((row) => row.object_id))).toEqual(new Set(["porter-1", "trigram-1"]));
    expect(first).toMatchObject({ inspectedCandidates: 2, nativeVisits: 4, truncated: true });
    const second = reader.pageInterpretationTextHints({ ...input, query, limit: 2, afterCursor: first.committedThrough });
    expect(new Set(second.rows.map((row) => row.object_id))).toEqual(new Set(["porter-2", "trigram-2"]));
    expect(second).toMatchObject({ inspectedCandidates: 2, nativeVisits: 4, truncated: true });
    expect(reader.pageInterpretationTextHints({ ...input, query, afterCursor: second.committedThrough })).toMatchObject({
      rows: [], inspectedCandidates: 0, nativeVisits: 2, bytesRead: 48, truncated: false
    });
  });

  it("does not execute another seek when logical operation or host byte reservation is exhausted", () => {
    const { database, reader } = setup();
    insertEvidenceCapsule(database, "first", { gist: "orchid" });
    insertEvidenceCapsule(database, "second", { gist: "orchid" });
    const statements = traceReads(database);
    const page = reader.pageInterpretationTextHints({ ...input, nativeLimit: 2, nativeByteLimit: 808 });
    expect(page.rows.map((row) => row.object_id)).toEqual(["first"]);
    expect(page).toMatchObject({ inspectedCandidates: 1, nativeVisits: 2, resourceLimited: true, truncated: true });
    expect(page.bytesRead).toBe(51); // rowid envelope + metadata envelope + "first" + "active"
    expect(statements.reduce((count, { statement }) => count + vi.mocked(statement.get).mock.calls.length, 0)).toBe(2);
    const before = statements.length;
    expect(reader.pageInterpretationTextHints({ ...input, nativeLimit: 1 })).toMatchObject({
      nativeVisits: 0, bytesRead: 0, inspectedCandidates: 0, resourceLimited: true, truncated: true
    });
    expect(reader.pageInterpretationTextHints({ ...input, nativeByteLimit: 807 })).toMatchObject({
      nativeVisits: 0, bytesRead: 0, inspectedCandidates: 0, resourceLimited: true, truncated: true
    });
    expect(statements.slice(before).every(({ statement }) => vi.mocked(statement.get).mock.calls.length === 0)).toBe(true);
  });

  it("advances past refused metadata without exposing it or skipping the next eligible capsule", () => {
    const { database, reader } = setup();
    insertEvidenceCapsule(database, "x".repeat(513), { gist: "orchid" });
    insertEvidenceCapsule(database, "eligible", { gist: "orchid" });
    const refused = reader.pageInterpretationTextHints({ ...input, limit: 1 });
    expect(refused).toMatchObject({ rows: [], nativeVisits: 2, inspectedCandidates: 1, unavailable: true, truncated: true });
    expect(refused.bytesRead).toBe(46);
    const next = reader.pageInterpretationTextHints({ ...input, limit: 1, afterCursor: refused.committedThrough });
    expect(next.rows.map((row) => row.object_id)).toEqual(["eligible"]);
    expect(next).toMatchObject({ nativeVisits: 2, inspectedCandidates: 1, unavailable: false, truncated: true });
  });

  it("executes rowid-only MATCH seeks and capsule point reads without selecting gist or sorting matches", () => {
    const { database, reader } = setup();
    insertEvidenceCapsule(database, "large-gist", { gist: `orchid ${"retained ".repeat(20_000)}` });
    const trace = traceReads(database);
    const page = reader.pageInterpretationTextHints(input);
    expect(page.rows.map((row) => row.object_id)).toEqual(["large-gist"]);
    expect(page.bytesRead).toBe(80);
    const executed = trace.filter(({ statement }) => vi.mocked(statement.get).mock.calls.length > 0)
      .map(({ sql, statement }) => ({ sql, bindings: vi.mocked(statement.get).mock.calls[0]! }));
    vi.restoreAllMocks();
    expect(executed).toHaveLength(3);
    for (const { sql, bindings } of executed) {
      expect(sql).not.toMatch(/\bgist\b|\bexcerpt\b|\bbm25\b|SELECT\s+\*/iu);
      const plan = database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings) as { detail: string }[];
      expect(plan.some(({ detail }) => /TEMP B-TREE/u.test(detail))).toBe(false);
      if (sql.includes(" MATCH ")) {
        expect(plan.some(({ detail }) => /VIRTUAL TABLE INDEX/u.test(detail))).toBe(true);
        const operations = database.prepare(`EXPLAIN ${sql}`).all(...bindings) as { opcode: string }[];
        expect(operations.some(({ opcode }) => ["VColumn", "Sort", "SorterOpen"].includes(opcode))).toBe(false);
      } else {
        expect(plan.some(({ detail }) => /USING INTEGER PRIMARY KEY \(rowid=\?\)/u.test(detail))).toBe(true);
      }
    }
  });

  it("does not relabel missing FTS storage as an exhausted empty page", () => {
    const { database, reader } = setup();
    database.exec("DROP TABLE evidence_capsule_fts");
    expect(reader.pageInterpretationTextHints(input)).toMatchObject({
      rows: [], unavailable: true, truncated: true, nativeVisits: 0, inspectedCandidates: 0
    });
  });

  it("retains attempted native work when SQLite fails while stepping a prepared FTS seek", () => {
    const { database, reader } = setup();
    insertEvidenceCapsule(database, "eligible", { gist: "orchid" });
    const prepare = database.prepare.bind(database);
    let interrupted = false;
    let nativeError: unknown;
    vi.spyOn(database, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (sql.includes("FROM evidence_capsule_fts WHERE")) {
        const get = statement.get.bind(statement);
        vi.spyOn(statement, "get").mockImplementationOnce((...bindings) => {
          if (!interrupted) {
            interrupted = true;
            database.exec("DROP TABLE evidence_capsule_fts");
          }
          try { return get(...bindings); }
          catch (error) { nativeError = error; throw error; }
        });
      }
      return statement;
    });
    expect(reader.pageInterpretationTextHints(input)).toMatchObject({
      rows: [], unavailable: true, truncated: true, nativeVisits: 1, bytesRead: 24, inspectedCandidates: 0
    });
    expect(interrupted).toBe(true);
    expect(nativeError).toMatchObject({ code: "SQLITE_ERROR", message: expect.stringMatching(/no such table/u) });
  });

  it("reads existing capsule indexes after a read-only reopen without materializing packet bodies", () => {
    const directory = mkdtempSync(join(tmpdir(), "alaya-capsule-hints-"));
    const filename = join(directory, "capsules.sqlite");
    const database = initDatabase({ filename });
    try {
      insertEvidenceCapsule(database.connection, "persisted", { gist: "orchid retained packet" });
      database.connection.prepare("UPDATE evidence_capsules SET source_hash=? WHERE object_id=?").run("hash-hint", "persisted");
      database.close({ optimize: false });
      const readonly = openReadOnlyDatabase(filename);
      try {
        const page = new SqliteSourceHintReader(readonly.connection).pageInterpretationTextHints(input);
        expect(page.rows).toEqual([expect.objectContaining({ object_id: "persisted", source_hash: "hash-hint", lifecycle_state: "active" })]);
        expect(page).toMatchObject({ nativeVisits: 3, inspectedCandidates: 1, unavailable: false, truncated: false });
        expect(page.rows[0]).not.toHaveProperty("gist");
        expect(readonly.connection.readonly).toBe(true);
      } finally { readonly.close({ optimize: false }); }
    } finally {
      database.close({ optimize: false });
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
