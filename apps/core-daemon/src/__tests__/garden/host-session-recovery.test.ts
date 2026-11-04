import { afterEach, expect, it } from "vitest";
import { hashLabeledIdentity, hostSessionContainerKey, type SourceAdmissionPort } from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import { initDatabase, SqliteEventLogRepo, SqliteGardenTaskRepo } from "@do-soul/alaya-storage";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createDaemonFieldComposition } from "../../runtime/field/field-composition.js";
import { createDaemonHostSessionCapture, createHostSessionCapture, MCP_HOST_SESSION_ISSUER } from "../../garden/host-session/host-session-capture.js";
import { STATEMENT_SESSION_IDLE_MS } from "../../garden/statement-session/statement-session-closure.js";
import { CONTAINER, CONTAINER_KEY, RUN, WORKSPACE, createStatementSessionEnvironment, hostMessages } from "./statement-session-fixture.js";

type Environment = Awaited<ReturnType<typeof createStatementSessionEnvironment>>;
const environments: Environment[] = [];
afterEach(async () => { for (const environment of environments.splice(0)) await environment.close(); });
async function environment(): Promise<Environment> {
  const result = await createStatementSessionEnvironment(); environments.push(result); return result;
}
const messages = hostMessages([[{ role: "user", content: "secret first" }, { role: "assistant", content: "later reply" }]]);
const context = { workspaceId: WORKSPACE, runId: RUN, issuer: MCP_HOST_SESSION_ISSUER };
const request = (index: number) => ({ container: CONTAINER, messages: [messages[index]!], closes_tail: true });
const injectedCapture = (env: Environment, admission: SourceAdmissionPort) => createHostSessionCapture({ admission,
  ledger: env.gardenTaskRepo.hostSessions, statementSessions: env.gardenTaskRepo, now: env.now, warn: () => undefined });
function restartedCapture(env: Environment, notifyEntry: () => void = () => undefined) {
  const database = env.reopen(), eventLogRepo = new SqliteEventLogRepo(database);
  const field = createDaemonFieldComposition({ database, eventLogRepo });
  const gardenTaskRepo = new SqliteGardenTaskRepo(database.connection, env.eventPublisher);
  return createDaemonHostSessionCapture({ stores: field.stores, eventLogRepo, gardenTaskRepo, now: env.now,
    runtimeNotifier: { notifyEntry }, warn: () => undefined });
}
function persisted(env: Environment) {
  return env.database.connection.prepare(`SELECT m.message_id, m.round_index, m.round_root_id, m.pending_body, m.erased,
    r.source_id, r.source_body FROM host_session_messages m LEFT JOIN source_records r
    ON r.workspace_id = m.workspace_id AND r.record_id = m.round_root_id ORDER BY m.position`).all();
}
function auditCount(env: Environment) {
  return env.database.connection.prepare(`SELECT entity_id, COUNT(*) AS n FROM event_log
    WHERE event_type = 'soul.field.source_record.admitted' GROUP BY entity_id ORDER BY entity_id`).all();
}
function erase(env: Environment, rootId: string) {
  env.field.fieldRepos.erase.apply({ identity: hashLabeledIdentity("erase_barrier", [WORKSPACE, "source_record", rootId, ""], fieldContractSha256),
    barrier_id: `erase-${rootId}`, workspace_id: WORKSPACE, generation_id: null,
    subject_kind: "source_record", subject_id: rootId, erased_at: env.now() });
}

for (const failure of ["before audit", "after audit"] as const) {
  it(`keeps the closed member fixed across ${failure}, restart, and an adjacent append`, async () => {
    const env = await environment();
    const capture = injectedCapture(env, { ...env.sourceAdmission, audit: async record => {
      if (failure === "after audit") await env.sourceAdmission.audit!(record);
      throw new Error("injected interruption");
    } });
    await expect(capture.capture({ ...context, request: request(0) })).rejects.toThrow("injected interruption");
    expect(persisted(env)).toEqual([expect.objectContaining({ message_id: "message-0", round_index: 0,
      pending_body: "secret first", source_id: `host-session:${CONTAINER_KEY}:r0`, source_body: "User: secret first" })]);
    const resumed = restartedCapture(env);
    await resumed.capture({ ...context, request: request(1) });
    const rows = persisted(env) as { message_id: string; round_index: number; round_root_id: string; pending_body: string | null;
      source_id: string; source_body: string }[];
    expect(rows.map(row => [row.message_id, row.round_index, row.source_id, row.source_body, row.pending_body])).toEqual([
      ["message-0", 0, `host-session:${CONTAINER_KEY}:r0`, "User: secret first", null],
      ["message-1", 1, `host-session:${CONTAINER_KEY}:r1`, "Assistant: later reply", null]
    ]);
    expect(auditCount(env)).toEqual(rows.map(row => ({ entity_id: row.round_root_id, n: 1 }))
      .sort((a, b) => a.entity_id.localeCompare(b.entity_id)));
    await resumed.capture({ ...context, request: request(0) });
    expect(auditCount(env)).toHaveLength(2);
  });
}

it("migrates a stranded legacy receipt using its host inventory before accepting a later message", async () => {
  const env = await environment();
  await expect(injectedCapture(env, { ...env.sourceAdmission, audit: async () => { throw new Error("interrupted"); } })
    .capture({ ...context, request: request(0) })).rejects.toThrow("interrupted");
  const originalRoot = (env.database.connection.prepare("SELECT record_id FROM source_records").get() as { record_id: string }).record_id;
  const sql039 = readFileSync("packages/storage/src/migrations/039-host-session-capture.sql", "utf8");
  const oldTable = sql039.slice(0, sql039.indexOf("CREATE INDEX idx_host_session_messages_admitted"));
  env.database.connection.exec(`DROP TABLE host_session_rounds; DROP TABLE host_session_planning; DROP TABLE host_session_sweeps;
    DROP TRIGGER host_session_message_container_insert; DROP TABLE host_session_containers;
    ALTER TABLE host_session_messages RENAME TO upgraded_messages; ${oldTable}
    INSERT INTO host_session_messages SELECT workspace_id, container_key, message_id, position, container_scope, container_id,
      role, completeness, fidelity, host_reported_at, content_digest, run_id, producer, admitted_at, pending_body, NULL, NULL
      FROM upgraded_messages;
    DROP TABLE upgraded_messages;
    CREATE TABLE host_session_sweeps(workspace_id TEXT NOT NULL, container_key TEXT NOT NULL, swept_through INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, container_key)) WITHOUT ROWID;
    DELETE FROM schema_version WHERE version = 40;`);
  const resumed = restartedCapture(env);
  expect(persisted(env)).toEqual([expect.objectContaining({ round_index: 0, round_root_id: originalRoot, pending_body: "secret first" })]);
  await resumed.capture({ ...context, request: request(1) });
  expect(persisted(env)).toEqual([
    expect.objectContaining({ message_id: "message-0", round_index: 0, round_root_id: originalRoot, source_body: "User: secret first" }),
    expect.objectContaining({ message_id: "message-1", round_index: 1, source_body: "Assistant: later reply" })]);
});

it("serializes competing captures through immutable membership and one audit per source", async () => {
  const env = await environment();
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let calls = 0;
  const capture = injectedCapture(env, { ...env.sourceAdmission, audit: async record => {
    if (++calls === 1) { entered(); await blocked; }
    await env.sourceAdmission.audit!(record);
  } });
  const first = capture.capture({ ...context, request: request(0) });
  await started;
  const second = capture.capture({ ...context, request: request(1) });
  await second; release(); await first;
  const rows = persisted(env) as { round_index: number; source_body: string; pending_body: string | null }[];
  expect(rows.map(row => [row.round_index, row.source_body, row.pending_body])).toEqual([
    [0, "User: secret first", null], [1, "Assistant: later reply", null]]);
  expect(auditCount(env)).toEqual([expect.objectContaining({ n: 1 }), expect.objectContaining({ n: 1 })]);
});

it("lets erase win over an admission paused inside its asynchronous audit", async () => {
  const env = await environment();
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const capture = injectedCapture(env, { ...env.sourceAdmission, audit: async record => {
    entered(); await blocked; await env.sourceAdmission.audit!(record);
  } });
  const inFlight = capture.capture({ ...context, request: request(0) });
  await started;
  const rootId = (env.database.connection.prepare("SELECT root_id FROM host_session_rounds").get() as { root_id: string }).root_id;
  erase(env, rootId);
  release();
  await inFlight;
  expect(persisted(env)).toEqual([expect.objectContaining({ round_index: 0, erased: 1, pending_body: null, source_body: null })]);
  expect(env.database.connection.prepare("SELECT state FROM host_session_rounds").get()).toEqual({ state: "erased" });
  await capture.capture({ ...context, request: request(0) });
  expect(JSON.stringify(persisted(env))).not.toContain("secret first");
});

for (const stage of ["intent", "receipt", "audit"] as const) {
  it(`erases attributable pending plaintext after ${stage} and cannot restore it by replay`, async () => {
    const env = await environment();
    const admission: SourceAdmissionPort = stage === "intent" ? { ...env.sourceAdmission,
      admit: () => { throw new Error("interrupted"); } } : { ...env.sourceAdmission, audit: async record => {
      if (stage === "audit") await env.sourceAdmission.audit!(record);
      throw new Error("interrupted");
    } };
    await expect(injectedCapture(env, admission).capture({ ...context, request: request(0) })).rejects.toThrow("interrupted");
    const rootId = (env.database.connection.prepare("SELECT root_id FROM host_session_rounds").get() as { root_id: string }).root_id;
    erase(env, rootId);
    expect(persisted(env)).toEqual([expect.objectContaining({ message_id: "message-0", round_index: 0,
      pending_body: null, erased: 1, source_body: null })]);
    expect(env.database.connection.prepare("SELECT state FROM host_session_rounds").get())
      .toEqual({ state: stage === "intent" ? "erased" : "erased_pending" });
    let notifications = 0;
    const capture = restartedCapture(env, () => { notifications++; });
    await capture.capture({ ...context, request: request(0) });
    expect(notifications).toBe(0);
    expect(env.database.connection.prepare("SELECT state FROM host_session_rounds").get()).toEqual({ state: "erased" });
    expect(auditCount(env)).toEqual(stage === "intent" ? [] : [{ entity_id: rootId, n: 1 }]);
    env.advance(8 * 24 * 60 * 60 * 1000);
    await capture.sweepIdle(MCP_HOST_SESSION_ISSUER);
    expect(JSON.stringify(persisted(env))).not.toContain("secret first");
    for (const sql of ["SELECT CAST(body AS TEXT) AS text FROM retained_source_chunks WHERE root_id = ?",
      "SELECT canonical_inventory AS text FROM source_host_inventories WHERE record_id = ?",
      "SELECT body AS text FROM source_index_text WHERE workspace_id = ?",
      "SELECT body AS text FROM source_index_windows WHERE workspace_id = ?"]) {
      const parameter = sql.includes("workspace_id = ?") ? WORKSPACE : rootId;
      expect(JSON.stringify(env.database.connection.prepare(sql).all(parameter))).not.toContain("secret first");
    }
    expect(env.database.connection.prepare("SELECT source_body FROM source_records WHERE record_id = ?").get(rootId))
      .toSatisfy((row: unknown) => row === undefined || (row as { source_body: string | null }).source_body === null);
  });
}

it("recovers an erased receipt's missing audit from idle sweep without restoring or notifying the source", async () => {
  const env = await environment();
  const failing = injectedCapture(env, { ...env.sourceAdmission, audit: async () => { throw new Error("audit unavailable"); } });
  await expect(failing.capture({ ...context, request: request(0) })).rejects.toThrow("audit unavailable");
  const rootId = (env.database.connection.prepare("SELECT root_id FROM host_session_rounds").get() as { root_id: string }).root_id;
  erase(env, rootId);
  env.advance(8 * 24 * 60 * 60 * 1000);
  let notifications = 0;
  const capture = restartedCapture(env, () => { notifications++; });
  await capture.sweepIdle(MCP_HOST_SESSION_ISSUER);
  expect(auditCount(env)).toEqual([{ entity_id: rootId, n: 1 }]);
  expect(env.database.connection.prepare("SELECT state FROM host_session_rounds").get()).toEqual({ state: "erased" });
  expect(notifications).toBe(0);
  expect(JSON.stringify(persisted(env))).not.toContain("secret first");
});

it("yields after 32 failing owned containers so an untried healthy one is not starved", async () => {
  const env = await environment();
  const containers = Array.from({ length: 35 }, (_, index) => ({ scope: "test-host", id: `fair-${index}` }))
    .sort((a, b) => hostSessionContainerKey(a, fieldContractSha256).localeCompare(hostSessionContainerKey(b, fieldContractSha256)));
  const healthy = containers.at(-1)!;
  const healthyKey = hostSessionContainerKey(healthy, fieldContractSha256);
  for (const container of containers) await env.capture({ container, messages: [messages[0]!] });
  env.advance(STATEMENT_SESSION_IDLE_MS);
  const capture = injectedCapture(env, { ...env.sourceAdmission, audit: async record => {
    if (record.source_id !== `host-session:${healthyKey}:r0`) throw new Error("bad container");
    await env.sourceAdmission.audit!(record);
  } });
  await capture.sweepIdle(MCP_HOST_SESSION_ISSUER);
  expect(env.sessionTasks()).toHaveLength(0);
  await capture.sweepIdle(MCP_HOST_SESSION_ISSUER);
  expect(env.sessionTasks()).toHaveLength(1);
  expect(JSON.parse(env.sessionTasks()[0]!.payload_json)).toMatchObject({ container_key: healthyKey });
});

it("keeps logical sweep progress after a workspace-only physical copy and restart", async () => {
  const env = await environment();
  for (let i = 0; i < 20; i++) env.gardenTaskRepo.hostSessions.insert({ workspace_id: "other", container_key: `other-${i}`,
    message_id: `other-${i}`, position: i, container_scope: "other", container_id: `${i}`, role: "user", completeness: "complete",
    fidelity: "original_bytes", host_reported_at: null, content_digest: "sha256:other", run_id: RUN, producer: "other",
    admitted_at: env.now(), pending_body: "other workspace" });
  await env.capture({ container: CONTAINER, messages: [messages[0]!] });
  env.advance(STATEMENT_SESSION_IDLE_MS);
  await env.sweep();
  const filename = join(env.directory, "workspace-copy.sqlite");
  env.database.connection.prepare("VACUUM INTO ?").run(filename);
  let copied = initDatabase({ filename });
  copied.connection.exec(`CREATE TEMP TABLE selected AS SELECT * FROM host_session_messages WHERE workspace_id = '${WORKSPACE}';
    DELETE FROM host_session_messages; INSERT INTO host_session_messages SELECT * FROM selected; DROP TABLE selected;`);
  expect(copied.connection.prepare("SELECT rowid FROM host_session_messages").get()).toEqual({ rowid: 1 });
  const warnings: unknown[] = [];
  const makeCapture = () => {
    const eventLogRepo = new SqliteEventLogRepo(copied), field = createDaemonFieldComposition({ database: copied, eventLogRepo });
    return createDaemonHostSessionCapture({ stores: field.stores, eventLogRepo,
      gardenTaskRepo: new SqliteGardenTaskRepo(copied.connection, env.eventPublisher), now: env.now,
      runtimeNotifier: { notifyEntry: () => undefined }, warn: (message, meta) => { warnings.push({ message, meta }); } });
  };
  await makeCapture().capture({ ...context, request: { container: CONTAINER, messages: [messages[1]!] } });
  copied.close(); copied = initDatabase({ filename });
  env.advance(STATEMENT_SESSION_IDLE_MS);
  const check = new SqliteGardenTaskRepo(copied.connection, env.eventPublisher);
  expect(check.hostSessions.idleContainers(new Date(Date.parse(env.now()) - STATEMENT_SESSION_IDLE_MS).toISOString(),
    env.now(), "mcp-host-session", 32)).toEqual([expect.objectContaining({ workspace_id: WORKSPACE, newest_message: 1 })]);
  await makeCapture().sweepIdle(MCP_HOST_SESSION_ISSUER);
  expect(copied.connection.prepare(`SELECT m.message_id, m.round_index, s.source_body FROM host_session_messages m
    JOIN source_records s ON s.workspace_id = m.workspace_id AND s.record_id = m.round_root_id ORDER BY m.position`).all())
    .toEqual([{ message_id: "message-0", round_index: 0, source_body: "User: secret first" },
      { message_id: "message-1", round_index: 1, source_body: "Assistant: later reply" }]);
  expect(warnings).toEqual([]);
  expect(copied.connection.prepare(`SELECT swept_through FROM host_session_sweeps
    WHERE sweeper = 'mcp-host-session' AND workspace_id = ? AND container_key = ?`).get(WORKSPACE, CONTAINER_KEY))
    .toEqual({ swept_through: 1 });
  copied.close();
});

it("retries an eight-day-old failed idle closure without another message", async () => {
  const env = await environment();
  await env.capture({ container: CONTAINER, messages: [messages[0]!] });
  env.advance(8 * 24 * 60 * 60 * 1000);
  let fail = true;
  const capture = injectedCapture(env, { ...env.sourceAdmission, audit: async record => {
    if (fail) throw new Error("temporarily unavailable");
    await env.sourceAdmission.audit!(record);
  } });
  await capture.sweepIdle(MCP_HOST_SESSION_ISSUER);
  expect(persisted(env)).toEqual([expect.objectContaining({ pending_body: "secret first", round_index: 0 })]);
  fail = false; env.advance(1001);
  await capture.sweepIdle(MCP_HOST_SESSION_ISSUER);
  expect(persisted(env)).toEqual([expect.objectContaining({ pending_body: null, round_index: 0, source_body: "User: secret first" })]);
  expect(env.sessionTasks()).toHaveLength(1);
  env.advance(STATEMENT_SESSION_IDLE_MS);
  await capture.sweepIdle(MCP_HOST_SESSION_ISSUER);
  expect(env.sessionTasks()).toHaveLength(1);
});
