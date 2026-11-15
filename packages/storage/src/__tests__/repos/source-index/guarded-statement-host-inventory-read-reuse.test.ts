import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteFieldEraseBarrierRepo } from "../../../repos/field/erase-repo.js";
import type { HostInventoryReadInput } from "../../../repos/field/host-inventory-read.js";
import { SqliteFieldSourceRecordRepo } from "../../../repos/field/source-repo.js";
import { guardSourceIndexTarget } from "../../../repos/source-index/native-source.js";
import { SqliteSourceIndexRepository } from "../../../repos/source-index/source-index-repo.js";
import { readStatementIndexChunk, readStatementIndexTarget } from "../../../repos/source-index/statement-artifact.js";
import { readStatementDependencies } from "../../../repos/source-index/statement-dependencies.js";
import type { StorageDatabase } from "../../../sqlite/db.js";
import {
  eraseSource, fieldSha256, publishSource, WORKSPACE, type Fixture
} from "./source-index-fixture.js";
import { QUERY_BUDGET, fixture } from "./source-index-query-fixture.js";
import { contextOf, publishMessages, publishStatement } from "./source-template-fixture.js";

const environments: Fixture[] = [], directories: string[] = [];
const READ_BUDGET = { work: 1 << 10, native_bytes: 1 << 20 };
const HOST_ALLOWANCE = {
  workLimit: 8_000_000, nativeByteLimit: 16 * 1024 * 1024, memoryLimit: 16 * 1024 * 1024
} as const;

afterEach(() => {
  vi.restoreAllMocks();
  for (const environment of environments.splice(0)) environment.database.close({ optimize: false });
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup(filename?: string) {
  const environment = fixture(filename);
  environments.push(environment);
  return environment;
}

function hostInput(input: ReturnType<typeof publishMessages>, changes: Partial<HostInventoryReadInput> = {}): HostInventoryReadInput {
  return {
    workspaceId: input.record.workspace_id, recordId: input.record.record_id,
    sourceVersion: input.record.source_version, contentDigest: input.record.content_digest,
    authorizedScopes: null, ...HOST_ALLOWANCE, ...changes
  };
}

function trackPrepare(database: StorageDatabase) {
  const counts = new Map<string, number>();
  const connection = database.connection;
  const original = connection.prepare.bind(connection);
  connection.prepare = ((sql: string) => {
    counts.set(sql, (counts.get(sql) ?? 0) + 1);
    return original(sql);
  }) as typeof connection.prepare;
  return { total: () => [...counts.values()].reduce((sum, n) => sum + n, 0) };
}

function trackGet(database: StorageDatabase) {
  const statement = database.connection.prepare("SELECT 1");
  return vi.spyOn(Object.getPrototypeOf(statement) as typeof statement, "get");
}

function reopen(environment: Fixture): Fixture {
  environment.database.reopenIfClosed();
  return {
    database: environment.database,
    records: new SqliteFieldSourceRecordRepo(environment.database, fieldSha256),
    index: new SqliteSourceIndexRepository(environment.database, fieldSha256),
    erase: new SqliteFieldEraseBarrierRepo(environment.database, fieldSha256)
  };
}

describe("guarded statement and host-inventory compiled reads", () => {
  it("reuses compiled SELECTs while still executing and charging each reader", () => {
    const environment = setup(), input = publishMessages(environment);
    const statement = publishStatement(environment, input, "artifact-reuse");
    const id = statement.source.auxiliary!.artifact_id, database = environment.database;
    const target = () => readStatementIndexTarget(database, WORKSPACE, id, READ_BUDGET);
    const dependencies = () => readStatementDependencies(database, WORKSPACE, id, READ_BUDGET);
    const chunk = () => readStatementIndexChunk(database, statement.source, statement.source.body_bytes, 0);
    const host = () => environment.records.readHostInventory(hostInput(input));
    const get = trackGet(database), prepares = trackPrepare(database);
    const first = { target: target(), dependencies: dependencies(), chunk: chunk(), host: host() };
    expect(first.target).toMatchObject({ status: "ready", source: statement.source });
    expect(first.dependencies.status).toBe("ready");
    expect(first.chunk.row?.content).toContain("café");
    expect(first.host).toMatchObject({ status: "captured", inventory: input.inventory });
    expect(first.target.resources.work).toBeGreaterThan(0);
    expect(first.dependencies.resources.native_bytes).toBeGreaterThan(0);
    expect(first.host.work).toBeGreaterThan(0);
    const compiled = prepares.total(), executed = get.mock.calls.length;
    expect(compiled).toBeGreaterThan(0);
    expect(executed).toBeGreaterThan(0);
    const second = { target: target(), dependencies: dependencies(), chunk: chunk(), host: host() };
    expect(second).toEqual(first);
    expect(prepares.total()).toBe(compiled);
    expect(get.mock.calls.length).toBeGreaterThan(executed);
    const keyBytes = Buffer.from(`${input.messages[0]!.text}\nreported event`);
    const mid = keyBytes.findIndex(byte => (byte & 0xc0) === 0x80);
    expect(mid).toBeGreaterThan(0);
    const split = readStatementIndexChunk(database, statement.source, 8, mid);
    expect(split.row).toBeNull();
    expect(split.resources).toEqual({ work: 1, native_bytes: keyBytes.length });
    expect(prepares.total()).toBe(compiled);
  });

  it("keeps erase, replacement, context, workspace and listing refusals fresh after a warmed cache", () => {
    const environment = setup();
    const owned = publishMessages(environment);
    const ownedStatement = publishStatement(environment, owned, "owned");
    const context = publishMessages(environment, [{ role: "user", text: "Prior context." }], "context");
    const dependent = publishMessages(environment, [{ role: "user", text: "Dependent statement." }], "dependent");
    const dependentStatement = publishStatement(environment, dependent, "dependent", 0, {}, [contextOf(context.record)]);
    const ownedId = ownedStatement.source.auxiliary!.artifact_id;
    const dependentId = dependentStatement.source.auxiliary!.artifact_id;
    const get = trackGet(environment.database), prepares = trackPrepare(environment.database);
    expect(readStatementIndexTarget(environment.database, WORKSPACE, ownedId, READ_BUDGET).status).toBe("ready");
    expect(readStatementIndexTarget(environment.database, WORKSPACE, dependentId, READ_BUDGET).status).toBe("ready");
    expect(environment.records.readHostInventory(hostInput(owned)).status).toBe("captured");
    expect(guardSourceIndexTarget(environment.database, environment.records, ownedStatement.source).status).toBe("ready");
    expect(environment.index.readMemberListing(owned.source, null, QUERY_BUDGET).status).toBe("ready");
    const compiled = prepares.total();
    expect(readStatementIndexTarget(environment.database, "workspace-2", ownedId, READ_BUDGET).status).toBe("absent");
    expect(environment.records.readHostInventory(hostInput(owned, { workspaceId: "workspace-2" })).status).toBe("unavailable");
    expect(prepares.total()).toBe(compiled);
    publishSource(environment, "Changed prior context.", context.record.source_id,
      { source_version: "v2", recorded_at: "2026-08-17T00:00:00.000Z" });
    expect(readStatementDependencies(environment.database, WORKSPACE, dependentId, READ_BUDGET).status).toBe("stale");
    expect(readStatementIndexTarget(environment.database, WORKSPACE, dependentId, READ_BUDGET).status).toBe("stale");
    expect(guardSourceIndexTarget(environment.database, environment.records, dependentStatement.source))
      .toMatchObject({ status: "stale", reason: "statement_changed" });
    publishSource(environment, "A newer source.", owned.record.source_id,
      { source_version: "v2", recorded_at: "2026-08-17T00:00:00.000Z" });
    expect(readStatementIndexTarget(environment.database, WORKSPACE, ownedId, READ_BUDGET).status).toBe("stale");
    expect(environment.records.readHostInventory(hostInput(owned)).status).toBe("unavailable");
    expect(environment.index.readMemberListing(owned.source, null, QUERY_BUDGET).status).toBe("unknown");
    eraseSource(environment, owned.record.record_id);
    expect(readStatementDependencies(environment.database, WORKSPACE, ownedId, READ_BUDGET).status).toBe("stale");
    expect(guardSourceIndexTarget(environment.database, environment.records, ownedStatement.source).status).toBe("stale");
    expect(get.mock.calls.length).toBeGreaterThan(0);
  });

  it("recompiles after close/reopen and still observes a replaced source", () => {
    const directory = mkdtempSync(join(tmpdir(), "guarded-read-reuse-"));
    directories.push(directory);
    const opened = setup(join(directory, "source.sqlite"));
    const input = publishMessages(opened);
    const statement = publishStatement(opened, input, "artifact-reopen");
    const id = statement.source.auxiliary!.artifact_id;
    const first = readStatementIndexTarget(opened.database, WORKSPACE, id, READ_BUDGET);
    const firstHost = opened.records.readHostInventory(hostInput(input));
    expect(first.status).toBe("ready");
    expect(firstHost.status).toBe("captured");
    opened.database.close({ optimize: false });
    const environment = reopen(opened);
    const prepares = trackPrepare(environment.database);
    const recovered = readStatementIndexTarget(environment.database, WORKSPACE, id, READ_BUDGET);
    const recoveredHost = environment.records.readHostInventory(hostInput(input));
    expect(recovered).toEqual(first);
    expect(recoveredHost).toEqual(firstHost);
    const compiled = prepares.total();
    expect(compiled).toBeGreaterThan(0);
    expect(readStatementIndexTarget(environment.database, WORKSPACE, id, READ_BUDGET)).toEqual(first);
    expect(environment.records.readHostInventory(hostInput(input))).toEqual(firstHost);
    expect(prepares.total()).toBe(compiled);
    publishSource(environment, "A newer source.", input.record.source_id,
      { source_version: "v2", recorded_at: "2026-08-17T00:00:00.000Z" });
    expect(readStatementIndexTarget(environment.database, WORKSPACE, id, READ_BUDGET).status).toBe("stale");
    expect(environment.records.readHostInventory(hostInput(input)).status).toBe("unavailable");
  });

  it("keeps budget-limited, malformed and absent statement reads distinct after warming", () => {
    const environment = setup(), input = publishMessages(environment);
    const statement = publishStatement(environment, input, "artifact-status");
    const id = statement.source.auxiliary!.artifact_id;
    const read = (budget: { work: number; native_bytes: number }) =>
      readStatementIndexTarget(environment.database, WORKSPACE, id, budget);
    const prepares = trackPrepare(environment.database);
    expect(read(READ_BUDGET)).toMatchObject({ status: "ready", source: statement.source });
    const compiled = prepares.total();
    expect(read({ work: 0, native_bytes: READ_BUDGET.native_bytes }))
      .toEqual({ status: "resource_limited", resources: { work: 0, native_bytes: 0 } });
    expect(read({ work: 1, native_bytes: 100 }).status).toBe("resource_limited");
    expect(readStatementDependencies(environment.database, WORKSPACE, id, { work: 0, native_bytes: 16 }))
      .toEqual({ status: "resource_limited", resources: { work: 0, native_bytes: 0 } });
    expect(readStatementDependencies(environment.database, WORKSPACE, id, { work: 4, native_bytes: 16 }))
      .toEqual({ status: "resource_limited", resources: { work: 1, native_bytes: 8 } });
    expect(readStatementIndexTarget(environment.database, WORKSPACE, "missing-artifact", READ_BUDGET))
      .toMatchObject({ status: "absent", resources: { work: 1 } });
    expect(prepares.total()).toBe(compiled);
    environment.database.connection.exec("DROP TRIGGER source_statement_key_immutable");
    environment.database.connection.prepare("UPDATE source_statement_artifacts SET target_json='{' WHERE artifact_id=?").run(id);
    expect(read(READ_BUDGET).status).toBe("partial");
  });

  it("keeps host inventory budget, missing payload and unauthorized reads distinct after warming", () => {
    const environment = setup(), input = publishMessages(environment);
    const host = (changes: Partial<HostInventoryReadInput> = {}) =>
      environment.records.readHostInventory(hostInput(input, changes));
    const prepares = trackPrepare(environment.database);
    expect(host()).toMatchObject({ status: "captured", inventory: input.inventory });
    const compiled = prepares.total(), captured = host();
    expect(host()).toEqual(captured);
    expect(prepares.total()).toBe(compiled);
    expect(host({ nativeByteLimit: 100, workLimit: 100, memoryLimit: 100 }))
      .toEqual({ status: "resource_limited", nativeBytes: 0, work: 0, memory: 0 });
    expect(host({ authorizedScopes: [] }).status).toBe("unavailable");
    expect(prepares.total()).toBe(compiled);
    environment.database.connection.prepare("DELETE FROM source_host_inventories WHERE workspace_id=? AND record_id=?")
      .run(WORKSPACE, input.record.record_id);
    expect(host().status).toBe("unavailable");
  });
});
