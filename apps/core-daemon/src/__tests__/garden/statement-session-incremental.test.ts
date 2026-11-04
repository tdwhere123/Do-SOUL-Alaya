import { afterEach, expect, it } from "vitest";
import { GardenTaskKind, hostSessionStatementSessionId } from "@do-soul/alaya-protocol";
import { SqliteGardenTaskRepo } from "@do-soul/alaya-storage";
import { closeStatementSessionChunks, type StatementSessionClosurePort } from "../../garden/statement-session/statement-session-closure.js";
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
  const addMessage = db.prepare(`INSERT INTO host_session_messages
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
    env.gardenTaskRepo.statementSessions.savePlanningCursor(WORKSPACE, CONTAINER_KEY, cursor, 1);
  })();
  return env;
}

it("preserves hand-expected cross-page targets and context after reopening", async () => {
  const env = await history(129);
  env.database.connection.prepare("DELETE FROM garden_tasks WHERE kind = 'source_statement_session'").run();
  env.database.connection.prepare("DELETE FROM host_session_planning").run();
  expect(closeStatementSessionChunks(env.gardenTaskRepo, { workspaceId: WORKSPACE, containerKey: CONTAINER_KEY,
    closeTail: true, now: env.now })).toBe(3);
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
    closeTail: true, now: env.now })).toBe(0);
  expect(env.sessionTasks().map(row => row.id)).toEqual(ids);
});

it("rolls back queued chunks and logical progress together if a later enqueue fails", async () => {
  const env = await history(129);
  env.database.connection.prepare("DELETE FROM garden_tasks WHERE kind = 'source_statement_session'").run();
  env.database.connection.prepare("DELETE FROM host_session_planning").run();
  let writes = 0;
  expect(() => closeStatementSessionChunks({ statementSessions: env.gardenTaskRepo.statementSessions, enqueue: input => {
    if (++writes === 2) throw new Error("queue unavailable");
    return env.gardenTaskRepo.enqueue(input);
  } }, { workspaceId: WORKSPACE, containerKey: CONTAINER_KEY, closeTail: true, now: env.now })).toThrow("queue unavailable");
  expect(env.sessionTasks()).toEqual([]);
  expect(env.gardenTaskRepo.statementSessions.planningCursor(WORKSPACE, CONTAINER_KEY)).toBeNull();
  expect(closeStatementSessionChunks(env.gardenTaskRepo, { workspaceId: WORKSPACE, containerKey: CONTAINER_KEY,
    closeTail: true, now: env.now })).toBe(3);
});

it("advances across raw-only gaps and does not rescan them on an unchanged replay", async () => {
  const env = await history(129), db = env.database.connection;
  db.prepare("DELETE FROM garden_tasks WHERE kind = 'source_statement_session'").run();
  db.prepare("DELETE FROM host_session_planning").run();
  db.prepare(`UPDATE source_records SET source_body = NULL WHERE source_id LIKE 'synthetic-source-%'
    AND CAST(substr(source_id, length('synthetic-source-') + 1) AS INTEGER) BETWEEN 1 AND 120`).run();
  expect(closeStatementSessionChunks(env.gardenTaskRepo, { workspaceId: WORKSPACE, containerKey: CONTAINER_KEY,
    closeTail: true, now: env.now })).toBe(1);
  const payload = parseStatementSessionTaskPayload(JSON.parse(env.sessionTasks()[0]!.payload_json));
  expect(readStatementSessionRequest(env.gardenTaskRepo.statementSessions, payload).request.messages.map(row => row.message_id))
    .toEqual(["message-0", ...Array.from({ length: 9 }, (_, index) => `message-${index + 121}`)]);
  expect(env.gardenTaskRepo.statementSessions.planningCursor(WORKSPACE, CONTAINER_KEY))
    .toEqual({ round_index: 129, occurrence_end: Number.MAX_SAFE_INTEGER });
  expect(closeStatementSessionChunks(env.gardenTaskRepo, { workspaceId: WORKSPACE, containerKey: CONTAINER_KEY,
    closeTail: true, now: env.now })).toBe(0);
  expect(env.sessionTasks()).toHaveLength(1);
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
      roundForRoot: (...args) => original.roundForRoot(...args), roundAt: (...args) => original.roundAt(...args),
      planningCursor: (...args) => original.planningCursor(...args), savePlanningCursor: (...args) => original.savePlanningCursor(...args),
      lastChunkPayload: (...args) => original.lastChunkPayload(...args),
      root: (...args) => { bodies++; return original.root(...args); }
    };
    const result = closeStatementSessionChunks({ statementSessions: sources, enqueue: input => env.gardenTaskRepo.enqueue(input) },
      { workspaceId: WORKSPACE, containerKey: CONTAINER_KEY, closeTail: true, now: env.now });
    expect(result).toBe(1);
    const payload = JSON.parse(env.sessionTasks().at(-1)!.payload_json);
    expect(payload).toMatchObject({ chunk_index: 1, run_id: RUN, targets: [
      { root_id: `synthetic-root-${size}`, source_id: `synthetic-source-${size}`, from: 0, to: 1 }] });
    expect(payload.context.at(-1)).toEqual({ root_id: `synthetic-root-${size - 1}`,
      source_id: `synthetic-source-${size - 1}`, from: 0, to: 1 });
    measurements.push({ returned, bodies });
  }
  expect(measurements).toEqual([measurements[0], measurements[0], measurements[0]]);
  expect(measurements[0]!.returned).toBeLessThanOrEqual(66);
  expect(measurements[0]!.bodies).toBeLessThanOrEqual(66);
});
