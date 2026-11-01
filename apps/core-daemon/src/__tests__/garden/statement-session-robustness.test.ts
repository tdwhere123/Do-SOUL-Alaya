import { afterEach, describe, expect, it } from "vitest";
import { GardenEventType, GardenRole, GardenTaskKind } from "@do-soul/alaya-protocol";
import { createHostWorkerTaskExpirer } from "../../garden/host-worker/host-worker-task-maintenance.js";
import { STATEMENT_SESSION_IDLE_MS } from "../../garden/statement-session/statement-session-closure.js";
import { createGardenTaskHandlers } from "../../mcp-memory/garden-task/garden-task-handlers.js";
import { RUN, START, WORKSPACE, createStatementSessionEnvironment } from "./statement-session-fixture.js";

type Environment = Awaited<ReturnType<typeof createStatementSessionEnvironment>>;
const environments: Environment[] = [];
afterEach(async () => { for (const environment of environments.splice(0)) await environment.close(); });
const HOST_WORKER = { provider_kind: "host_worker", model_id: null, provider_url: null, secret_ref: null, enabled: true } as const;
const DAY_MS = 24 * 60 * 60 * 1000;

async function environment(): Promise<Environment> {
  const created = await createStatementSessionEnvironment();
  environments.push(created);
  return created;
}
function turn(index: number) {
  return [{ role: index % 2 === 0 ? "user" : "assistant", content_excerpt: `Entry ${index} recorded the garden plan. `.padEnd(560, "x") }];
}
function rootOf(env: Environment, turnIndex: number, runId = RUN): string {
  return (env.database.connection.prepare(`SELECT json_extract(payload_json, '$.admitted_source_root_id') AS root FROM garden_tasks
    WHERE kind = 'post_turn_extract' AND json_extract(payload_json, '$.run_id') = ?
      AND json_extract(payload_json, '$.turn_index') = ?`).get(runId, turnIndex) as { root: string }).root;
}
/** A root whose captured host message lost its role cannot be shown to the model. */
function dropRoles(env: Environment, rootId: string): void {
  env.database.connection.prepare(`UPDATE source_host_inventories SET canonical_inventory =
    json_set(canonical_inventory, '$.occurrences[0].role', json('null')) WHERE record_id = ?`).run(rootId);
}
function plannedTexts(env: Environment): readonly string[] {
  return env.requests.flatMap(request => request.messages.map(message => message.text));
}

describe("statement session closure robustness", { timeout: 30_000 }, () => {
  it("plans a late turn with a smaller caller turn index after its run's closed chunks", async () => {
    const env = await environment();
    for (let index = 10; index < 80; index++) await env.report(index, turn(index));
    expect(env.sessionTasks().length).toBeGreaterThan(0);
    await env.report(3, turn(3));
    env.advance(STATEMENT_SESSION_IDLE_MS);
    const provider = env.provider(() => []);
    for (let pass = 0; pass < env.sessionTasks().length + 2; pass++) await env.processSession(provider);

    const texts = plannedTexts(env);
    expect(texts).toHaveLength(71);
    expect(texts.at(-1)).toBe(turn(3)[0]!.content_excerpt);
    expect(env.sessionTasks().every(row => row.status === "completed")).toBe(true);
  });

  it("treats a role-less root as a raw-only gap and keeps planning the run", async () => {
    const env = await environment();
    for (let index = 0; index < 3; index++) await env.report(index, turn(index));
    dropRoles(env, rootOf(env, 1));
    await env.report(3, turn(3));
    env.advance(STATEMENT_SESSION_IDLE_MS);
    await env.processSession(env.provider(() => []));

    expect(env.sessionTasks().map(row => row.status)).toEqual(["completed"]);
    expect(plannedTexts(env)).toEqual([0, 2, 3].map(index => turn(index)[0]!.content_excerpt));
    expect(env.warnings).toEqual([]);
  });

  it("never fails a report when closure throws, and leaves the run to the idle sweep", async () => {
    const env = await environment();
    for (let index = 10; index < 80; index++) await env.report(index, turn(index));
    const [first] = env.sessionTasks();
    env.database.connection.prepare(`UPDATE garden_tasks SET payload_json = json_set(payload_json, '$.targets', json('[]'))
      WHERE id = ?`).run(first!.id);
    const tasks = env.sessionTasks().length;

    await expect(env.report(80, turn(80))).resolves.toBeUndefined();
    await expect(env.report(80, turn(80))).resolves.toBeUndefined();
    expect(env.warnings.filter(row => row.message === "statement session chunk closure failed")).toHaveLength(2);
    expect(env.database.connection.prepare(`SELECT COUNT(*) AS n FROM garden_tasks WHERE kind = 'post_turn_extract'`)
      .get()).toEqual({ n: 71 });
    env.advance(STATEMENT_SESSION_IDLE_MS);
    await env.processSession(env.provider(() => []));
    expect(env.warnings.at(-1)?.message).toBe("statement session tail closure failed");
    expect(env.sessionTasks()).toHaveLength(tasks);
  });

  it("does not let dead idle runs starve a fresh idle run", async () => {
    const env = await environment();
    for (let index = 0; index < 33; index++) {
      env.gardenTaskRepo.enqueue({ id: `dead-${index}`, workspace_id: WORKSPACE, role: GardenRole.LIBRARIAN,
        kind: GardenTaskKind.POST_TURN_EXTRACT, created_at: new Date(Date.parse(START) - DAY_MS).toISOString(),
        payload: { task_kind: GardenTaskKind.POST_TURN_EXTRACT, workspace_id: WORKSPACE, run_id: `dead-run-${index}`,
          turn_index: 0, turn_digest: { last_messages: [{ role: "user", content_excerpt: "unbound" }],
            context_manifest: { delivered_object_ids: [] } } } });
    }
    await env.report(0, turn(0));
    env.advance(STATEMENT_SESSION_IDLE_MS);
    await env.processSession(env.provider(() => []));
    expect(env.sessionTasks().map(row => row.status)).toEqual(["completed"]);

    await env.processSession(env.provider(() => []));
    const idle = () => env.gardenTaskRepo.statementSessions.idleOpenRuns(env.now(), new Date(Date.parse(env.now()) - 7 * DAY_MS)
      .toISOString(), 64);
    expect(idle()).toEqual([]);
    await env.report(1, turn(1));
    env.advance(STATEMENT_SESSION_IDLE_MS);
    expect(idle().map(run => run.run_id)).toEqual([RUN]);
  });

  it("fails an unclaimed chunk past the host-worker TTL instead of deleting it, without re-enqueueing it", async () => {
    const env = await environment();
    await env.report(0, turn(0));
    env.advance(STATEMENT_SESSION_IDLE_MS);
    await env.processSession(env.provider(() => []), HOST_WORKER);
    const expire = createHostWorkerTaskExpirer({ now: env.now, gardenTaskRepo: env.gardenTaskRepo, warn: () => undefined });
    env.advance(STATEMENT_SESSION_IDLE_MS);
    await env.processSession(env.provider(() => []), HOST_WORKER);
    await expire();
    const [chunk] = env.sessionTasks();
    expect(chunk).toMatchObject({ status: "pending" });

    env.advance(7 * DAY_MS);
    await expire();
    expect(env.sessionTasks()).toEqual([expect.objectContaining({ id: chunk!.id, status: "failed",
      last_error_text: expect.stringContaining("expired unclaimed") })]);
    const events = (type: string) => (env.database.connection.prepare(`SELECT COUNT(*) AS n FROM event_log
      WHERE event_type = ? AND entity_id = ?`).get(type, chunk!.id) as { n: number }).n;
    expect(events(GardenEventType.SOUL_GARDEN_TASK_EXPIRED)).toBe(1);
    expect(events(GardenEventType.SOUL_GARDEN_TASK_COMPLETED)).toBe(1);

    await env.report(0, turn(0));
    await env.report(1, turn(1));
    env.advance(STATEMENT_SESSION_IDLE_MS);
    await env.processSession(env.provider(() => []), HOST_WORKER);
    const chunks = env.sessionTasks();
    expect(chunks.map(row => JSON.parse(row.payload_json).chunk_index)).toEqual([0, 1]);
    expect(chunks[1]).toMatchObject({ status: "pending" });
  });

  it("lists the other pending chunks when one chunk's member root cannot be read", async () => {
    const env = await environment();
    await env.report(0, turn(0));
    await env.report(0, turn(1), "run-2");
    env.advance(STATEMENT_SESSION_IDLE_MS);
    await env.processSession(env.provider(() => []), HOST_WORKER);
    expect(env.sessionTasks()).toHaveLength(2);
    dropRoles(env, rootOf(env, 0));
    const warnings: string[] = [];
    const handlers = createGardenTaskHandlers({ now: env.now, warn: message => { warnings.push(message); },
      generateId: () => "attempt-1", deps: { gardenTaskRepo: env.gardenTaskRepo, signalService: env.signalService,
        postTurnSignalReceiver: env.signalReceiver } });
    const listed = await handlers.listPendingGardenTasks({ role: "host_worker", limit: 10 },
      { workspaceId: WORKSPACE, runId: null, agentTarget: "codex", sessionId: "session-1" });
    expect(listed.tasks.filter(task => task.kind === GardenTaskKind.SOURCE_STATEMENT_SESSION)
      .map(task => (task.payload as { run_id: string }).run_id)).toEqual(["run-2"]);
    expect(warnings).toEqual(["omitted statement session chunk with an unavailable member source"]);
  });
});
