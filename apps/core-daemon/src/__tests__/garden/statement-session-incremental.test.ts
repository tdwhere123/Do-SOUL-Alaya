import { afterEach, expect, it } from "vitest";
import { GardenTaskKind, hashLabeledIdentity, hostSessionStatementSessionId } from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import { SqliteEventLogRepo, SqliteGardenTaskRepo } from "@do-soul/alaya-storage";
import { createDaemonFieldComposition } from "../../runtime/field/field-composition.js";
import { createDaemonHostSessionCapture, MCP_HOST_SESSION_ISSUER } from "../../garden/host-session/host-session-capture.js";
import { closeStatementSessionChunks, STATEMENT_SESSION_IDLE_MS, type StatementSessionClosurePort } from "../../garden/statement-session/statement-session-closure.js";
import { parseStatementSessionTaskPayload, readStatementSessionRequest } from "../../garden/statement-session/statement-session-task.js";
import { CONTAINER, CONTAINER_KEY, RUN, WORKSPACE, createStatementSessionEnvironment, hostMessages } from "./statement-session-fixture.js";

type Environment = Awaited<ReturnType<typeof createStatementSessionEnvironment>>;
const environments: Environment[] = [];
afterEach(async () => { for (const environment of environments.splice(0)) await environment.close(); });

/** Populate logical rounds using one retained SQLite root as a template; only their identities differ. */
async function history(size: number): Promise<Environment> {
  const env = await createStatementSessionEnvironment(); environments.push(env);
  await env.capture({ container: CONTAINER, closes_tail: true,
    messages: hostMessages([[{ role: "user", content: "short source" }]]) });
  const db = env.database.connection;
  const template = env.roots()[0]!;
  const columns = (db.prepare("PRAGMA table_info(source_records)").all() as { name: string }[]).map(row => row.name);
  const copySource = db.prepare(`INSERT INTO source_records (${columns.join(",")}) SELECT ${columns.map(name =>
    name === "record_id" || name === "source_id" ? "?" : name).join(",")} FROM source_records WHERE workspace_id = ? AND record_id = ?`);
  const copyInventory = db.prepare(`INSERT INTO source_host_inventories SELECT workspace_id, ?,
    json_set(canonical_inventory, '$.occurrences[0].occurrence_id', ?, '$.occurrences[0].upstream_position', ?)
    FROM source_host_inventories WHERE workspace_id = ? AND record_id = ?`);
  const addMessage = db.prepare(`INSERT INTO host_session_messages (
    workspace_id, container_key, message_id, position, container_scope, container_id, role, completeness, fidelity,
    host_reported_at, content_digest, run_id, producer, admitted_at, pending_body, round_index, round_root_id, erased)
    SELECT workspace_id, container_key, ?, ?, container_scope, container_id, role, completeness, fidelity, host_reported_at,
      content_digest, run_id, producer, admitted_at, NULL, ?, ?, 0 FROM host_session_messages
    WHERE workspace_id = ? AND container_key = ? AND message_id = 'message-0'`);
  const addRound = db.prepare("INSERT INTO host_session_rounds VALUES (?, ?, ?, ?, 'done')");
  db.transaction(() => {
    db.prepare("DELETE FROM garden_tasks WHERE kind = 'source_statement_session'").run();
    db.prepare("DELETE FROM host_session_planning").run();
    for (let index = 1; index <= size; index++) {
      const root = `synthetic-root-${index}`, source = `synthetic-source-${index}`, id = `message-${index}`;
      copySource.run(root, source, WORKSPACE, template);
      copyInventory.run(root, id, index, WORKSPACE, template);
      addMessage.run(id, index, index, root, WORKSPACE, CONTAINER_KEY);
      addRound.run(WORKSPACE, CONTAINER_KEY, index, root);
    }
    const cursor = size - 1;
    const payload = { task_kind: GardenTaskKind.SOURCE_STATEMENT_SESSION, workspace_id: WORKSPACE, container_key: CONTAINER_KEY,
      run_id: RUN, session_id: hostSessionStatementSessionId(CONTAINER_KEY), chunk_index: 0, context: [],
      targets: [{ root_id: `synthetic-root-${cursor}`, source_id: `synthetic-source-${cursor}`, from: 0, to: 1 }], closes_tail: true };
    env.gardenTaskRepo.enqueue({ id: "previous-chunk", workspace_id: WORKSPACE, role: "librarian",
      kind: GardenTaskKind.SOURCE_STATEMENT_SESSION, payload, created_at: env.now() });
    env.gardenTaskRepo.statementSessions.savePlanningState(WORKSPACE, CONTAINER_KEY,
      { round_index: cursor, occurrence_end: 1, scan_round: cursor, pending_json: "[]", context_before: null, context_json: "[]" });
  })();
  return env;
}

function drain(env: Environment): { enqueued: number; passes: number } {
  let enqueued = 0, passes = 0;
  for (;;) {
    if (++passes > 200) throw new Error("statement planning did not finish");
    const result = closeStatementSessionChunks(env.gardenTaskRepo, { workspaceId: WORKSPACE, containerKey: CONTAINER_KEY,
      closeTail: true, now: env.now });
    enqueued += result.enqueued;
    if (!result.more) return { enqueued, passes };
  }
}

it("preserves hand-expected cross-page targets and context after reopening", async () => {
  const env = await history(129);
  env.database.connection.prepare("DELETE FROM garden_tasks WHERE kind = 'source_statement_session'").run();
  env.database.connection.prepare("DELETE FROM host_session_planning").run();
  expect(drain(env)).toEqual({ enqueued: 3, passes: 3 });
  const ids = env.sessionTasks().map(row => row.id);
  const reopened = env.reopen(), repo = new SqliteGardenTaskRepo(reopened.connection, env.eventPublisher);
  const requests = env.sessionTasks().map(row => readStatementSessionRequest(repo.statementSessions,
    parseStatementSessionTaskPayload(JSON.parse(row.payload_json))).request);
  expect(requests.map(row => row.messages.map(message => message.message_id))).toEqual([
    Array.from({ length: 64 }, (_, i) => `message-${i}`),
    Array.from({ length: 64 }, (_, i) => `message-${i + 64}`), ["message-128", "message-129"]]);
  expect(requests[1]!.context.map(row => row.message_id)).toEqual(Array.from({ length: 64 }, (_, i) => `message-${i}`));
  expect(requests[2]!.context.map(row => row.message_id)).toEqual(Array.from({ length: 64 }, (_, i) => `message-${i + 64}`));
  expect(closeStatementSessionChunks(repo, { workspaceId: WORKSPACE, containerKey: CONTAINER_KEY,
    closeTail: true, now: env.now })).toEqual({ enqueued: 0, more: false });
  expect(env.sessionTasks().map(row => row.id)).toEqual(ids);
});

it("keeps unfinished pages eligible and resumes their pending references after SQLite reopen", async () => {
  const env = await history(129);
  env.database.connection.prepare("DELETE FROM garden_tasks WHERE kind = 'source_statement_session'").run();
  env.database.connection.prepare("DELETE FROM host_session_planning").run();
  env.advance(STATEMENT_SESSION_IDLE_MS);
  await env.sweep();
  expect(env.sessionTasks()).toEqual([]);
  const state = env.gardenTaskRepo.statementSessions.planningState(WORKSPACE, CONTAINER_KEY)!;
  expect(state).toMatchObject({ round_index: -1, scan_round: 63 });
  expect(JSON.parse(state.pending_json)).toHaveLength(64);
  expect(state.pending_json).not.toContain("short source");
  expect(env.database.connection.prepare(`SELECT swept_through FROM host_session_sweeps
    WHERE workspace_id = ? AND container_key = ? AND sweeper = 'mcp-host-session'`).get(WORKSPACE, CONTAINER_KEY))
    .toEqual({ swept_through: -1 });
  const database = env.reopen(), eventLogRepo = new SqliteEventLogRepo(database);
  const field = createDaemonFieldComposition({ database, eventLogRepo });
  const repo = new SqliteGardenTaskRepo(database.connection, env.eventPublisher);
  const capture = createDaemonHostSessionCapture({ stores: field.stores, eventLogRepo, gardenTaskRepo: repo,
    runtimeNotifier: { notifyEntry: () => undefined }, now: env.now, warn: () => undefined });
  await capture.sweepIdle(MCP_HOST_SESSION_ISSUER);
  expect(env.sessionTasks()).toHaveLength(1);
  await capture.sweepIdle(MCP_HOST_SESSION_ISSUER);
  expect(env.sessionTasks()).toHaveLength(3);
  expect(database.connection.prepare(`SELECT swept_through FROM host_session_sweeps
    WHERE workspace_id = ? AND container_key = ? AND sweeper = 'mcp-host-session'`).get(WORKSPACE, CONTAINER_KEY))
    .toEqual({ swept_through: 129 });
  const requests = env.sessionTasks().map(row => readStatementSessionRequest(repo.statementSessions,
    parseStatementSessionTaskPayload(JSON.parse(row.payload_json))).request);
  expect(requests.flatMap(row => row.messages.map(message => message.message_id)))
    .toEqual(Array.from({ length: 130 }, (_, index) => `message-${index}`));
});

it("drops an erased pending reference without replaying it or changing later target order", async () => {
  const env = await history(129);
  env.database.connection.prepare("DELETE FROM garden_tasks WHERE kind = 'source_statement_session'").run();
  env.database.connection.prepare("DELETE FROM host_session_planning").run();
  const input = { workspaceId: WORKSPACE, containerKey: CONTAINER_KEY, closeTail: true, now: env.now };
  expect(closeStatementSessionChunks(env.gardenTaskRepo, input)).toEqual({ enqueued: 0, more: true });
  const erased = env.roots()[0]!;
  env.field.fieldRepos.erase.apply({ identity: hashLabeledIdentity("erase_barrier", [WORKSPACE, "source_record", erased, ""], fieldContractSha256),
    barrier_id: "erase-pending-context", workspace_id: WORKSPACE, generation_id: null,
    subject_kind: "source_record", subject_id: erased, erased_at: env.now() });
  expect(drain(env)).toEqual({ enqueued: 3, passes: 2 });
  const requests = env.sessionTasks().map(row => readStatementSessionRequest(env.gardenTaskRepo.statementSessions,
    parseStatementSessionTaskPayload(JSON.parse(row.payload_json))).request);
  expect(requests.flatMap(row => row.messages.map(message => message.message_id)))
    .toEqual(Array.from({ length: 129 }, (_, index) => `message-${index + 1}`));
  expect(requests.flatMap(row => row.context.map(message => message.message_id))).not.toContain("message-0");
});

it("rolls back queued chunks and logical progress together if a later enqueue fails", async () => {
  const env = await history(129);
  env.database.connection.prepare("DELETE FROM garden_tasks WHERE kind = 'source_statement_session'").run();
  env.database.connection.prepare("DELETE FROM host_session_planning").run();
  const input = { workspaceId: WORKSPACE, containerKey: CONTAINER_KEY, closeTail: true, now: env.now };
  expect(closeStatementSessionChunks(env.gardenTaskRepo, input)).toEqual({ enqueued: 0, more: true });
  expect(closeStatementSessionChunks(env.gardenTaskRepo, input)).toEqual({ enqueued: 1, more: true });
  const before = env.gardenTaskRepo.statementSessions.planningState(WORKSPACE, CONTAINER_KEY);
  let writes = 0;
  expect(() => closeStatementSessionChunks({ statementSessions: env.gardenTaskRepo.statementSessions, enqueue: task => {
    if (++writes === 2) throw new Error("queue unavailable");
    return env.gardenTaskRepo.enqueue(task);
  } }, input)).toThrow("queue unavailable");
  expect(env.sessionTasks()).toHaveLength(1);
  expect(env.gardenTaskRepo.statementSessions.planningState(WORKSPACE, CONTAINER_KEY)).toEqual(before);
  expect(closeStatementSessionChunks(env.gardenTaskRepo, input)).toEqual({ enqueued: 2, more: false });
});

it("advances across raw-only gaps and does not rescan them on an unchanged replay", async () => {
  const env = await history(129), db = env.database.connection;
  db.prepare("DELETE FROM garden_tasks WHERE kind = 'source_statement_session'").run();
  db.prepare("DELETE FROM host_session_planning").run();
  db.prepare(`UPDATE source_records SET source_body = NULL WHERE source_id LIKE 'synthetic-source-%'
    AND CAST(substr(source_id, length('synthetic-source-') + 1) AS INTEGER) BETWEEN 1 AND 120`).run();
  expect(drain(env)).toEqual({ enqueued: 1, passes: 3 });
  const payload = parseStatementSessionTaskPayload(JSON.parse(env.sessionTasks()[0]!.payload_json));
  expect(readStatementSessionRequest(env.gardenTaskRepo.statementSessions, payload).request.messages.map(row => row.message_id))
    .toEqual(["message-0", ...Array.from({ length: 9 }, (_, index) => `message-${index + 121}`)]);
  expect(env.gardenTaskRepo.statementSessions.planningState(WORKSPACE, CONTAINER_KEY))
    .toEqual({ round_index: 129, occurrence_end: Number.MAX_SAFE_INTEGER, scan_round: 129,
      pending_json: "[]", context_before: null, context_json: "[]" });
  expect(closeStatementSessionChunks(env.gardenTaskRepo, { workspaceId: WORKSPACE, containerKey: CONTAINER_KEY,
    closeTail: true, now: env.now })).toEqual({ enqueued: 0, more: false });
  expect(env.sessionTasks()).toHaveLength(1);
});

it("retains the last chunk's tail status across pages of raw-only messages", async () => {
  const env = await history(193), db = env.database.connection;
  db.prepare("DELETE FROM garden_tasks WHERE kind = 'source_statement_session'").run();
  db.prepare("DELETE FROM host_session_planning").run();
  const raw = '"'.repeat(16384);
  db.prepare(`UPDATE source_records SET source_body = ? WHERE source_id LIKE 'synthetic-source-%'
    AND CAST(substr(source_id, length('synthetic-source-') + 1) AS INTEGER) >= 64`).run(`User: ${raw}`);
  db.prepare(`UPDATE source_host_inventories SET canonical_inventory = json_set(canonical_inventory,
    '$.occurrences[0].utf8_span[1]', 16390) WHERE record_id LIKE 'synthetic-root-%'
    AND CAST(substr(record_id, length('synthetic-root-') + 1) AS INTEGER) >= 64`).run();
  expect(drain(env)).toEqual({ enqueued: 1, passes: 4 });
  const [task] = env.sessionTasks();
  const payload = parseStatementSessionTaskPayload(JSON.parse(task!.payload_json));
  const request = readStatementSessionRequest(env.gardenTaskRepo.statementSessions, payload).request;
  expect(request.messages.map(row => row.message_id)).toEqual(Array.from({ length: 64 }, (_, index) => `message-${index}`));
  expect(payload.closes_tail).toBe(true);
});

it("continues past pages of structurally invalid context across restart without unbounded reads", async () => {
  const env = await history(1000);
  env.database.connection.prepare(`UPDATE source_host_inventories SET canonical_inventory =
    json_set(canonical_inventory, '$.occurrences[0].fidelity', 'invalid')
    WHERE record_id LIKE 'synthetic-root-%' AND CAST(substr(record_id, length('synthetic-root-') + 1) AS INTEGER) BETWEEN 871 AND 998`).run();
  const input = { workspaceId: WORKSPACE, containerKey: CONTAINER_KEY, closeTail: true, now: env.now };
  let contextPages = 0, contextRows = 0;
  const measured = (repo: SqliteGardenTaskRepo): StatementSessionClosurePort => {
    const original = repo.statementSessions;
    return { enqueue: task => repo.enqueue(task), statementSessions: {
      transaction: work => original.transaction(work), roundPage: (...args) => original.roundPage(...args),
      contextPage: (...args) => { const rows = original.contextPage(...args); contextPages++; contextRows += rows.length; return rows; },
      roundForRoot: (...args) => original.roundForRoot(...args), roundAt: (...args) => original.roundAt(...args),
      planningState: (...args) => original.planningState(...args), savePlanningState: (...args) => original.savePlanningState(...args),
      reserveTailBoundary: (...args) => original.reserveTailBoundary(...args), nextTailBoundary: (...args) => original.nextTailBoundary(...args),
      tailBoundaryReady: (...args) => original.tailBoundaryReady(...args), completeTailBoundary: (...args) => original.completeTailBoundary(...args),
      lastChunkPayload: (...args) => original.lastChunkPayload(...args), root: (...args) => original.root(...args)
    } };
  };
  expect(closeStatementSessionChunks(measured(env.gardenTaskRepo), input)).toEqual({ enqueued: 0, more: true });
  expect([contextPages, contextRows]).toEqual([1, 64]);
  expect(env.gardenTaskRepo.statementSessions.planningState(WORKSPACE, CONTAINER_KEY))
    .toMatchObject({ round_index: 999, scan_round: 999, context_before: 935 });
  const database = env.reopen(), repo = new SqliteGardenTaskRepo(database.connection, env.eventPublisher);
  contextPages = 0; contextRows = 0;
  expect(closeStatementSessionChunks(measured(repo), input)).toEqual({ enqueued: 0, more: true });
  expect([contextPages, contextRows]).toEqual([1, 64]);
  expect(repo.statementSessions.planningState(WORKSPACE, CONTAINER_KEY)).toMatchObject({ context_before: 871 });
  contextPages = 0; contextRows = 0;
  expect(closeStatementSessionChunks(measured(repo), input)).toEqual({ enqueued: 1, more: false });
  expect([contextPages, contextRows]).toEqual([1, 64]);
  const payload = parseStatementSessionTaskPayload(JSON.parse(env.sessionTasks().at(-1)!.payload_json));
  const request = readStatementSessionRequest(repo.statementSessions, payload).request;
  expect(request.messages.map(row => row.message_id)).toEqual(["message-1000"]);
  expect(request.context.map(row => row.message_id)).toEqual([
    ...Array.from({ length: 63 }, (_, index) => `message-${index + 808}`), "message-999"]);
});

it("reads a fixed context and one appended round after 100, 1000 and 10000 retained rounds", { timeout: 60_000 }, async () => {
  const measurements: { returned: number; bodies: number }[] = [];
  for (const size of [100, 1000, 10000]) {
    const env = await history(size), original = env.gardenTaskRepo.statementSessions;
    const queryPlan = env.database.connection.prepare(`EXPLAIN QUERY PLAN SELECT payload_json FROM garden_tasks
      WHERE kind = 'source_statement_session' AND workspace_id = ?
        AND (CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.container_key') END) = ?
      ORDER BY (CASE WHEN json_valid(payload_json) THEN CAST(json_extract(payload_json, '$.chunk_index') AS INTEGER) END) DESC,
        id DESC LIMIT 1`).all(WORKSPACE, CONTAINER_KEY) as { detail: string }[];
    expect(queryPlan.map(row => row.detail).join(" ")).toContain("idx_garden_tasks_statement_session_container");
    expect(queryPlan.map(row => row.detail).join(" ")).not.toContain("TEMP B-TREE");
    let returned = 0, bodies = 0;
    const sources: StatementSessionClosurePort["statementSessions"] = {
      transaction: work => original.transaction(work),
      roundPage: (...args) => { const rows = original.roundPage(...args); returned += rows.length; return rows; },
      contextPage: (...args) => { const rows = original.contextPage(...args); returned += rows.length; return rows; },
      roundForRoot: (...args) => { const row = original.roundForRoot(...args); returned += row === null ? 0 : 1; return row; },
      roundAt: (...args) => { const row = original.roundAt(...args); returned += row === null ? 0 : 1; return row; },
      planningState: (...args) => original.planningState(...args), savePlanningState: (...args) => original.savePlanningState(...args),
      reserveTailBoundary: (...args) => original.reserveTailBoundary(...args), nextTailBoundary: (...args) => original.nextTailBoundary(...args),
      tailBoundaryReady: (...args) => original.tailBoundaryReady(...args), completeTailBoundary: (...args) => original.completeTailBoundary(...args),
      lastChunkPayload: (...args) => original.lastChunkPayload(...args),
      root: (...args) => { bodies++; return original.root(...args); }
    };
    const result = closeStatementSessionChunks({ statementSessions: sources, enqueue: input => env.gardenTaskRepo.enqueue(input) },
      { workspaceId: WORKSPACE, containerKey: CONTAINER_KEY, closeTail: true, now: env.now });
    expect(result).toEqual({ enqueued: 1, more: false });
    const payload = JSON.parse(env.sessionTasks().at(-1)!.payload_json);
    expect(payload).toMatchObject({ chunk_index: 1, run_id: RUN, targets: [
      { root_id: `synthetic-root-${size}`, source_id: `synthetic-source-${size}`, from: 0, to: 1 }] });
    expect(payload.context.at(-1)).toEqual({ root_id: `synthetic-root-${size - 1}`,
      source_id: `synthetic-source-${size - 1}`, from: 0, to: 1 });
    measurements.push({ returned, bodies });
    if (size === 10000) {
      env.database.connection.prepare("DELETE FROM garden_tasks WHERE kind = 'source_statement_session'").run();
      env.database.connection.prepare("DELETE FROM host_session_planning").run();
      const bounded = { statementSessions: sources, enqueue: (input: Parameters<typeof env.gardenTaskRepo.enqueue>[0]) =>
        env.gardenTaskRepo.enqueue(input) };
      const input = { workspaceId: WORKSPACE, containerKey: CONTAINER_KEY, closeTail: true, now: env.now };
      returned = 0; bodies = 0;
      expect(closeStatementSessionChunks(bounded, input)).toEqual({ enqueued: 0, more: true });
      expect(returned).toBeLessThanOrEqual(65);
      expect(bodies).toBeLessThanOrEqual(64);
      returned = 0; bodies = 0;
      expect(closeStatementSessionChunks(bounded, input)).toEqual({ enqueued: 1, more: true });
      expect(returned).toBeLessThanOrEqual(129);
      expect(bodies).toBeLessThanOrEqual(128);
    }
  }
  expect(measurements).toEqual([measurements[0], measurements[0], measurements[0]]);
  expect(measurements[0]!.returned).toBeLessThanOrEqual(66);
  expect(measurements[0]!.bodies).toBeLessThanOrEqual(66);
});
