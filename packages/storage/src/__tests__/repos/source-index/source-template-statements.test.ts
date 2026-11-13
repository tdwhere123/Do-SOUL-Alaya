import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoundSourceStatement, HostOccurrence } from "@do-soul/alaya-protocol";
import { StorageDatabase } from "../../../sqlite/db.js";
import { SqliteFieldSourceRecordRepo } from "../../../repos/field/source-repo.js";
import { guardSourceIndexTarget } from "../../../repos/source-index/native-source.js";
import { readStatementIndexTarget } from "../../../repos/source-index/statement-artifact.js";
import { eraseSource, publishSource } from "./source-index-fixture.js";
import { QUERY_BUDGET, WORKSPACE, expectQueryResources, fixture, targetFor, type Fixture } from "./source-index-query-fixture.js";
import { contextOf, publishMessages, publishStatement } from "./source-template-fixture.js";

const environments: Fixture[] = [], directories: string[] = [], otherConnections: StorageDatabase[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const database of otherConnections.splice(0)) database.close({ optimize: false });
  for (const environment of environments.splice(0)) environment.database.close({ optimize: false });
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function setup(filename?: string) {
  const environment = fixture(filename); environments.push(environment); return environment;
}

describe("current source-template statement reads", () => {
  it("enumerates every own-message artifact in the exact root and workspace, including an auxiliary entry", () => {
    const environment = setup();
    const input = publishMessages(environment, [{ role: "user", text: "I ordered a café cocktail." },
      { role: "assistant", text: "You chose the terrace." }]);
    const first = publishStatement(environment, input, "artifact-a"), second = publishStatement(environment, input, "artifact-b", 1);
    const sibling = publishMessages(environment, [{ role: "user", text: "A different root." }], "sibling");
    publishStatement(environment, sibling, "artifact-sibling");
    const foreign = publishMessages(environment, [{ role: "user", text: "A foreign workspace." }], "source-statements", "workspace-2");
    publishStatement(environment, foreign, "artifact-foreign");
    const before = environment.database.connection.prepare("SELECT total_changes() AS n").get();
    const read = environment.index.readTemplateStatements(input.source, QUERY_BUDGET);
    expect(read).toMatchObject({ status: "complete", statements: expect.arrayContaining([first, second]) });
    if (read.status === "complete") expect(read.statements).toHaveLength(2);
    expectQueryResources(read.resources);
    expect(read.resources.work).toBeGreaterThan(0);
    expect(read.resources.memory_bytes).toBeGreaterThan(read.resources.native_bytes);
    expect(environment.index.readTemplateStatements(first.source, QUERY_BUDGET))
      .toMatchObject({ status: "complete", statements: expect.arrayContaining([first, second]) });
    expect(environment.database.connection.prepare("SELECT total_changes() AS n").get()).toEqual(before);
  });

  it("reports known empty only after checking the current raw source", () => {
    const environment = setup(), record = publishSource(environment, "No extracted statements.");
    expect(environment.index.readTemplateStatements(targetFor(record), QUERY_BUDGET)).toMatchObject({ status: "complete", statements: [] });
    const changed = { ...targetFor(record), target: { ...targetFor(record).target, source_version: "wrong" } };
    expect(environment.index.readTemplateStatements(changed, QUERY_BUDGET)).toMatchObject({ status: "unknown" });
  });

  it.each(["replaced", "erased"])("does not turn a %s source into known missing artifacts", state => {
    const environment = setup(), input = publishMessages(environment);
    publishStatement(environment, input, "artifact-current");
    if (state === "erased") eraseSource(environment, input.record.record_id);
    else publishSource(environment, "A newer source.", input.record.source_id,
      { source_version: "v2", recorded_at: "2026-08-17T00:00:00.000Z" });
    const read = environment.index.readTemplateStatements(input.source, QUERY_BUDGET);
    expect(read.status).toBe("unknown");
    expect("statements" in read).toBe(false);
    expectQueryResources(read.resources);
  });

  it("checks context dependencies for artifact currentness without returning context messages", () => {
    const environment = setup(), input = publishMessages(environment);
    const context = publishMessages(environment, [{ role: "user", text: "Prior context." }], "context");
    const expected = publishStatement(environment, input, "artifact-context", 0, {}, [contextOf(context.record)]);
    publishStatement(environment, context, "artifact-context-own");
    expect(environment.index.readTemplateStatements(input.source, QUERY_BUDGET)).toMatchObject({ status: "complete", statements: [expected] });
    publishSource(environment, "Changed prior context.", context.record.source_id,
      { source_version: "v2", recorded_at: "2026-08-17T00:00:00.000Z" });
    expect(environment.index.readTemplateStatements(input.source, QUERY_BUDGET))
      .toMatchObject({ status: "unknown", reason: "source_template_artifact_stale" });
  });

  it("treats an archived artifact as known absent while leaving the current source readable", () => {
    const environment = setup(), input = publishMessages(environment);
    const artifact = publishStatement(environment, input, "artifact-archived");
    environment.database.connection.prepare("UPDATE evidence_capsules SET lifecycle_state='archived' WHERE object_id=?")
      .run(artifact.source.auxiliary!.artifact_id);
    expect(environment.index.readTemplateStatements(input.source, QUERY_BUDGET)).toMatchObject({ status: "complete", statements: [] });
  });

  it.each(["role", "identity", "text", "span"])("refuses a statement with a mismatched host message %s", mismatch => {
    const environment = setup(), input = publishMessages(environment);
    const message = { message_id: "message-0", role: "user", text: input.messages[0]!.text, recorded_at: null };
    const changes: Partial<BoundSourceStatement> = mismatch === "span" ? { source_span: [7, 15] }
      : { message: { ...message, ...(mismatch === "role" ? { role: "assistant" }
        : mismatch === "identity" ? { message_id: "message-unrelated" } : { text: "I ordered a different drink." }) } };
    publishStatement(environment, input, "artifact-mismatch", 0, changes);
    const read = environment.index.readTemplateStatements(input.source, QUERY_BUDGET);
    expect(read.status).toBe("unknown");
    expect("statements" in read).toBe(false);
    expectQueryResources(read.resources);
  });

  it.each(["source_version", "content_digest"])("refuses an artifact bound to a different %s", field => {
    const environment = setup(), input = publishMessages(environment);
    publishStatement(environment, input, "artifact-rebound", 0, { source_target: {
      ...input.source.target, [field]: field === "source_version" ? "other-version" : `sha256:${"a".repeat(64)}`
    } });
    const read = environment.index.readTemplateStatements(input.source, QUERY_BUDGET);
    expect(read).toMatchObject({ status: "unknown", reason: "source_template_artifact_binding" });
    expect("statements" in read).toBe(false);
  });

  it.each<HostOccurrence["completeness"]>(["excerpt", "unknown"])("refuses a host message with %s completeness", completeness => {
    const environment = setup(), input = publishMessages(environment,
      [{ role: "user", text: "I ordered a café cocktail.", completeness }]);
    publishStatement(environment, input, "artifact-incomplete-capture");
    const read = environment.index.readTemplateStatements(input.source, QUERY_BUDGET);
    expect(read).toMatchObject({ status: "unknown", reason: "source_template_message_binding" });
    expect("statements" in read).toBe(false);
    expectQueryResources(read.resources);
  });

  it.each<HostOccurrence["fidelity"]>(["normalized", "unknown"])("checks complete retained bytes without inventing %s upstream fidelity", fidelity => {
    const environment = setup(), input = publishMessages(environment,
      [{ role: "user", text: "I ordered a café cocktail.", fidelity }]);
    const expected = publishStatement(environment, input, "artifact-retained-capture");
    const read = environment.index.readTemplateStatements(input.source, QUERY_BUDGET);
    expect(read).toMatchObject({ status: "complete", statements: [expected] });
    expectQueryResources(read.resources);
  });

  it("refuses missing host inventory and retains its incurred read costs", () => {
    const environment = setup(), input = publishMessages(environment);
    publishStatement(environment, input, "artifact-host");
    environment.database.connection.prepare("DELETE FROM source_host_inventories WHERE workspace_id=? AND record_id=?")
      .run(WORKSPACE, input.record.record_id);
    const read = environment.index.readTemplateStatements(input.source, QUERY_BUDGET);
    expect(read).toMatchObject({ status: "unknown", reason: "source_template_host_unavailable" });
    expect(read.resources.work).toBeGreaterThan(0);
    expectQueryResources(read.resources);
  });

  it("refuses malformed retained artifact bytes instead of exposing the other valid statements", () => {
    const environment = setup(), input = publishMessages(environment);
    publishStatement(environment, input, "artifact-valid");
    const corrupt = publishStatement(environment, input, "artifact-malformed");
    // Simulate persisted corruption beneath the publication owner, which normally withdraws a changed key.
    environment.database.connection.exec("DROP TRIGGER source_statement_evidence_change");
    environment.database.connection.prepare("UPDATE evidence_capsules SET gist='{' WHERE object_id=?")
      .run(corrupt.source.auxiliary!.artifact_id);
    const read = environment.index.readTemplateStatements(input.source, QUERY_BUDGET);
    expect(read).toMatchObject({ status: "unknown", reason: "source_template_artifact_invalid" });
    expect("statements" in read).toBe(false);
    expectQueryResources(read.resources);
  });

  it("refuses a large artifact before its payload query when only its bounded header can be funded", () => {
    const environment = setup(), input = publishMessages(environment, [{ role: "user", text: "a".repeat(32000) }]);
    publishStatement(environment, input, "artifact-large", 0,
      { statement: { text: "The message is large.", relation: "reported event" } });
    const statement = environment.database.connection.prepare("SELECT 1");
    const get = vi.spyOn(Object.getPrototypeOf(statement) as typeof statement, "get");
    const read = environment.index.readTemplateStatements(input.source, QUERY_BUDGET);
    expect(read.status).toBe("unknown");
    const queries = get.mock.contexts.map(value => (value as { source: string }).source);
    expect(queries.some(sql => sql.includes("AS gist_bytes"))).toBe(true);
    expect(queries.some(sql => sql.includes("END AS gist,"))).toBe(false);
    expectQueryResources(read.resources);
  });

  it("checks the whole own-message span across retained UTF-8 chunks", () => {
    const environment = setup(), text = `${"a".repeat(4084)} café ${"b".repeat(200)}`;
    const input = publishMessages(environment, [{ role: "user", text }]);
    const expected = publishStatement(environment, input, "artifact-chunks", 0,
      { statement: { text: "I described a café.", relation: "reported event" } });
    expect(environment.index.readTemplateStatements(input.source, QUERY_BUDGET)).toMatchObject({ status: "complete", statements: [expected] });
    environment.database.connection.prepare(`DELETE FROM retained_source_chunks
      WHERE workspace_id=? AND root_id=? AND start_offset>0`).run(WORKSPACE, input.record.record_id);
    const read = environment.index.readTemplateStatements(input.source, QUERY_BUDGET);
    expect(read).toMatchObject({ status: "unknown", reason: "source_template_source_incomplete" });
    expect("statements" in read).toBe(false);
  });

  it("withholds a funded prefix when the terminal completeness read cannot be funded", () => {
    const environment = setup(), input = publishMessages(environment);
    publishStatement(environment, input, "artifact-a"); publishStatement(environment, input, "artifact-b");
    const full = environment.index.readTemplateStatements(input.source, QUERY_BUDGET);
    expect(full.status).toBe("complete");
    const budget = { ...QUERY_BUDGET, work_units: full.resources.work - 1 };
    const refused = environment.index.readTemplateStatements(input.source, budget);
    expect(refused.status).toBe("unknown");
    expect("statements" in refused).toBe(false);
    expect(refused.resources.work).toBeGreaterThan(0);
    expectQueryResources(refused.resources, budget);
  });

  it("performs no native reads when the initial budget is refused", () => {
    const environment = setup(), input = publishMessages(environment);
    publishStatement(environment, input, "artifact-a");
    const statement = environment.database.connection.prepare("SELECT 1");
    const get = vi.spyOn(Object.getPrototypeOf(statement) as typeof statement, "get");
    const read = environment.index.readTemplateStatements(input.source, { work_units: 0, memory_bytes: 0 });
    expect(read.status).toBe("unknown");
    expect(read.resources).toEqual({ work: 0, memory_bytes: 0, native_bytes: 0, sql_internal_work: "unknown" });
    expect(get).not.toHaveBeenCalled();
  });

  it("keeps the caller's WAL snapshot while another connection withdraws an artifact", () => {
    const directory = mkdtempSync(join(tmpdir(), "source-template-snapshot-")); directories.push(directory);
    const filename = join(directory, "source.sqlite"), environment = setup(filename), input = publishMessages(environment);
    const expected = publishStatement(environment, input, "artifact-snapshot");
    const writer = new StorageDatabase(filename, new BetterSqlite3(filename)); otherConnections.push(writer);
    environment.database.connection.transaction(() => {
      expect(environment.index.readTemplateStatements(input.source, QUERY_BUDGET)).toMatchObject({ status: "complete", statements: [expected] });
      writer.connection.prepare("UPDATE evidence_capsules SET lifecycle_state='archived' WHERE object_id=?").run(expected.source.auxiliary!.artifact_id);
      expect(environment.index.readTemplateStatements(input.source, QUERY_BUDGET)).toMatchObject({ status: "complete", statements: [expected] });
    })();
    expect(environment.index.readTemplateStatements(input.source, QUERY_BUDGET)).toMatchObject({ status: "complete", statements: [] });
  });
});

describe("member listing reads", () => {
  it("lists current own statements, the first host message and its event time", () => {
    const environment = setup(), input = publishMessages(environment, [{ role: "user", text: "  I ordered a café cocktail. " },
      { role: "assistant", text: "You chose the terrace." }], "source-statements", WORKSPACE, "2026-08-16T09:00:00.000Z");
    const statement = publishStatement(environment, input, "artifact-listed", 1);
    const listing = environment.index.readMemberListing(input.source, null, QUERY_BUDGET);
    expect(listing).toMatchObject({ status: "ready", first_message: "I ordered a café cocktail.",
      event_time: "2026-08-16T09:00:00.000Z", statements: [{ source: statement.source, text: "You chose the terrace.",
        role: "assistant", message_id: "message-1", embedding: null }] });
    expectQueryResources(listing.resources);
  });

  it.each(["replaced", "erased"])("refuses a %s member instead of listing it empty", state => {
    const environment = setup(), input = publishMessages(environment);
    publishStatement(environment, input, "artifact-current");
    if (state === "erased") eraseSource(environment, input.record.record_id);
    else publishSource(environment, "A newer source.", input.record.source_id,
      { source_version: "v2", recorded_at: "2026-08-17T00:00:00.000Z" });
    const listing = environment.index.readMemberListing(input.source, null, QUERY_BUDGET);
    expect(listing.status).toBe("unknown");
    expect("statements" in listing).toBe(false);
    expectQueryResources(listing.resources);
  });

  it("refuses a member without a host inventory as unknown, as statement binding would", () => {
    const environment = setup(), record = publishSource(environment, "No host structure.");
    expect(environment.index.readMemberListing(targetFor(record), null, QUERY_BUDGET)).toMatchObject({ status: "unknown" });
  });

  it("reports a budget refusal as resource limited, not as an unknown member", () => {
    const environment = setup(), input = publishMessages(environment);
    publishStatement(environment, input, "artifact-unfunded");
    const listing = environment.index.readMemberListing(input.source, null, { work_units: 0, memory_bytes: 0 });
    expect(listing.status).toBe("resource_limited");
    expect("statements" in listing).toBe(false);
  });

  it("reports a clipped native message read as resource limited", () => {
    const environment = setup(), input = publishMessages(environment);
    const bounded = SqliteFieldSourceRecordRepo.prototype.findByIdBounded;
    vi.spyOn(SqliteFieldSourceRecordRepo.prototype, "findByIdBounded").mockImplementation(function (this: SqliteFieldSourceRecordRepo, ...args) {
      const read = bounded.apply(this, args);
      return read === null ? null : { ...read, resourceLimited: true };
    });
    expect(environment.index.readMemberListing(input.source, null, QUERY_BUDGET))
      .toMatchObject({ status: "resource_limited", reason: "source_template_source_read_budget" });
  });
});

describe("member listing budget refusals", () => {
  it("reports every underfunded work or byte budget as resource limited, never as an unknown member", () => {
    const environment = setup(), input = publishMessages(environment);
    publishStatement(environment, input, "artifact-swept");
    const listing = (budget: { work_units: number; memory_bytes: number }) =>
      environment.index.readMemberListing(input.source, null, budget);
    for (const [axis, step] of [["work_units", 1], ["memory_bytes", 64]] as const) {
      const at = (value: number) => listing({ ...QUERY_BUDGET, [axis]: value });
      let funded = 0;
      while (funded <= QUERY_BUDGET[axis] && at(funded).status !== "ready") funded += step;
      expect(funded).toBeGreaterThan(0);
      expect(funded).toBeLessThanOrEqual(QUERY_BUDGET[axis]);
      for (let value = 0; value < funded; value += step) expect(at(value).status, `${axis} ${value}`).toBe("resource_limited");
    }
  });
});

describe("statement artifact target reads", () => {
  it("separates a budget refusal from a malformed stored target", () => {
    const environment = setup(), input = publishMessages(environment);
    const statement = publishStatement(environment, input, "artifact-target");
    const id = statement.source.auxiliary!.artifact_id;
    const read = (budget: { work: number; native_bytes: number }) => readStatementIndexTarget(environment.database, WORKSPACE, id, budget);
    expect(read({ work: 1, native_bytes: 100 }).status).toBe("resource_limited");
    expect(read({ work: 1, native_bytes: 1 << 20 }).status).toBe("resource_limited");
    expect(read({ work: 1 << 10, native_bytes: 1 << 20 })).toMatchObject({ status: "ready", source: statement.source });
    expect(guardSourceIndexTarget(environment.database, environment.records, statement.source).status).toBe("ready");
    // Simulate persisted corruption beneath the publication owner, which never rewrites a key.
    environment.database.connection.exec("DROP TRIGGER source_statement_key_immutable");
    environment.database.connection.prepare("UPDATE source_statement_artifacts SET target_json='{' WHERE artifact_id=?").run(id);
    expect(read({ work: 1 << 10, native_bytes: 1 << 20 }).status).toBe("partial");
    expect(guardSourceIndexTarget(environment.database, environment.records, statement.source))
      .toMatchObject({ status: "partial", reason: "native_source_unavailable" });
  });
});
