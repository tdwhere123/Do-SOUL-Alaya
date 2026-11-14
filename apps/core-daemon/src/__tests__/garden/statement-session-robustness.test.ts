import { afterEach, describe, expect, it } from "vitest";
import { GardenEventType, GardenTaskKind, hostSessionContainerKey } from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import { createGardenClaimReclaimer, createHostWorkerTaskExpirer } from "../../garden/host-worker/host-worker-task-maintenance.js";
import { IN_PROCESS_CLAIMANT } from "../../garden/host-worker/host-worker-task-processors.js";
import { STATEMENT_SESSION_IDLE_MS } from "../../garden/statement-session/statement-session-closure.js";
import { createGardenTaskHandlers } from "../../mcp-memory/garden-task/garden-task-handlers.js";
import { CONTAINER, CONTAINER_KEY, WORKSPACE, createStatementSessionEnvironment, hostMessages } from "./statement-session-fixture.js";

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
  return [{ role: index % 2 === 0 ? "user" as const : "assistant" as const,
    content: `Entry ${index} recorded the garden plan. `.padEnd(560, "x") }];
}
async function capture(env: Environment, index: number, container = CONTAINER, runId?: string) {
  return await env.capture({ container, messages: hostMessages([turn(index)], index) }, runId);
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
  it("refuses a message positioned before captured ones and keeps the closed plan unchanged", async () => {
    const env = await environment();
    for (let index = 10; index < 80; index++) await capture(env, index);
    const closed = env.sessionTasks().map(row => row.id);
    expect(closed.length).toBeGreaterThan(0);
    await expect(capture(env, 3)).rejects.toMatchObject({ code: "CONFLICT" });
    env.advance(STATEMENT_SESSION_IDLE_MS);
    const provider = env.provider(() => []);
    for (let pass = 0; pass < env.sessionTasks().length + 2; pass++) await env.processSession(provider);

    expect(plannedTexts(env)).toEqual(Array.from({ length: 70 }, (_, offset) => turn(10 + offset)[0]!.content));
    expect(env.sessionTasks().map(row => row.id).slice(0, closed.length)).toEqual(closed);
    expect(env.sessionTasks().every(row => row.status === "completed")).toBe(true);
  });

  it("treats a role-less round root as a raw-only gap and keeps planning the container", async () => {
    const env = await environment();
    for (let index = 0; index < 6; index++) await capture(env, index);
    dropRoles(env, env.roots()[1]!);
    env.advance(STATEMENT_SESSION_IDLE_MS);
    await env.processSession(env.provider(() => []));

    expect(env.sessionTasks().map(row => row.status)).toEqual(["completed"]);
    expect(plannedTexts(env)).toEqual([0, 1, 4, 5].map(index => turn(index)[0]!.content));
    expect(env.warnings).toEqual([]);
  });

  it("never fails a capture when closure throws, and leaves the container to the idle sweep", async () => {
    const env = await environment();
    for (let index = 10; index < 80; index++) await capture(env, index);
    const [first] = env.sessionTasks();
    env.database.connection.prepare(`UPDATE garden_tasks SET payload_json = json_set(payload_json, '$.targets', json('[]'))
      WHERE id = ?`).run(first!.id);
    const tasks = env.sessionTasks().length;

    await expect(capture(env, 80)).resolves.toMatchObject({ admitted_message_count: 1 });
    await expect(capture(env, 80)).resolves.toMatchObject({ admitted_message_count: 0, replayed_message_count: 1 });
    expect(env.warnings.filter(row => row.message === "statement session chunk closure failed")).toHaveLength(2);
    expect(env.database.connection.prepare("SELECT COUNT(*) AS n FROM host_session_messages").get()).toEqual({ n: 71 });
    env.advance(STATEMENT_SESSION_IDLE_MS);
    await env.processSession(env.provider(() => []));
    expect(env.warnings.at(-1)?.message).toBe("host session tail closure failed");
    expect(env.sessionTasks()).toHaveLength(tasks);
  });

  it("does not let dead idle containers starve a fresh idle container", async () => {
    const env = await environment();
    for (let index = 0; index < 33; index++) {
      env.gardenTaskRepo.hostSessions.insert({ workspace_id: WORKSPACE, container_key: `dead-${index}`,
        message_id: "pending", position: 0, container_scope: "dead", container_id: `${index}`, role: "user",
        completeness: "complete", fidelity: "original_bytes", host_reported_at: null, content_digest: "sha256:dead",
        run_id: "dead-run", producer: "another-producer", admitted_at: env.now(), pending_body: "unbound" });
    }
    env.advance(DAY_MS);
    await capture(env, 0);
    env.advance(STATEMENT_SESSION_IDLE_MS);
    await env.processSession(env.provider(() => []));
    expect(env.sessionTasks().map(row => row.status)).toEqual(["completed"]);

    await env.processSession(env.provider(() => []));
    const idle = () => env.gardenTaskRepo.hostSessions.idleContainers(env.now(), env.now(), "mcp-host-session", 64);
    expect(idle()).toEqual([]);
    // Another producer's pending message needs its own issuer; the sweep leaves it pending.
    expect(env.gardenTaskRepo.hostSessions.openTail(WORKSPACE, "dead-0")).toHaveLength(1);
    await capture(env, 1);
    env.advance(STATEMENT_SESSION_IDLE_MS);
    expect(idle().map(container => container.container_key)).toEqual([CONTAINER_KEY]);
  });

  it("reclaims an in-process statement-session claim that never published dispatch", async () => {
    const env = await environment();
    await capture(env, 0);
    env.advance(STATEMENT_SESSION_IDLE_MS);
    await env.processSession(env.provider(() => []), HOST_WORKER);
    const [chunk] = env.sessionTasks();
    expect(chunk).toMatchObject({ status: "pending" });
    const claimedAt = env.now();
    expect(await env.gardenTaskRepo.claimAtomic(chunk!.id, IN_PROCESS_CLAIMANT, claimedAt, WORKSPACE)).toBe("claimed");
    const eventCount = (type: string) => (env.database.connection.prepare(
      `SELECT COUNT(*) AS n FROM event_log WHERE event_type = ? AND entity_id = ?`).get(type, chunk!.id) as { n: number }).n;
    expect(eventCount(GardenEventType.SOUL_GARDEN_TASK_DISPATCHED)).toBe(0);

    env.advance(11 * 60 * 1000);
    await createGardenClaimReclaimer({ now: env.now, gardenTaskRepo: env.gardenTaskRepo })();
    expect(env.sessionTasks()).toEqual([expect.objectContaining({ id: chunk!.id, status: "pending" })]);
    expect(eventCount(GardenEventType.SOUL_GARDEN_TASK_DISPATCHED)).toBe(0);
    expect(eventCount(GardenEventType.SOUL_GARDEN_TASK_CLAIM_RECLAIMED)).toBe(1);

    await env.processSession(env.provider(() => []));
    expect(env.sessionTasks()).toEqual([expect.objectContaining({ id: chunk!.id, status: "completed" })]);
    expect(eventCount(GardenEventType.SOUL_GARDEN_TASK_DISPATCHED)).toBe(1);
  });

  it("fails an unclaimed chunk past the host-worker TTL instead of deleting it, without re-enqueueing it", async () => {
    const env = await environment();
    await capture(env, 0);
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

    await capture(env, 0);
    await capture(env, 1);
    env.advance(STATEMENT_SESSION_IDLE_MS);
    await env.processSession(env.provider(() => []), HOST_WORKER);
    const chunks = env.sessionTasks();
    expect(chunks.map(row => JSON.parse(row.payload_json).chunk_index)).toEqual([0, 1]);
    expect(chunks[1]).toMatchObject({ status: "pending" });
  });

  it("lists the other pending chunks when one chunk's member root cannot be read", async () => {
    const env = await environment();
    const other = { scope: CONTAINER.scope, id: "conversation-2" };
    await capture(env, 0);
    await env.capture({ container: other, messages: hostMessages([turn(1)], 0) }, "run-2");
    env.advance(STATEMENT_SESSION_IDLE_MS);
    await env.processSession(env.provider(() => []), HOST_WORKER);
    expect(env.sessionTasks()).toHaveLength(2);
    dropRoles(env, env.roots()[0]!);
    const warnings: string[] = [];
    const handlers = createGardenTaskHandlers({ now: env.now, warn: message => { warnings.push(message); },
      generateId: () => "attempt-1", deps: { gardenTaskRepo: env.gardenTaskRepo, signalService: env.signalService,
        postTurnSignalReceiver: env.signalReceiver } });
    const listed = await handlers.listPendingGardenTasks({ role: "host_worker", limit: 10 },
      { workspaceId: WORKSPACE, runId: null, agentTarget: "codex", sessionId: "session-1" });
    expect(listed.tasks.filter(task => task.kind === GardenTaskKind.SOURCE_STATEMENT_SESSION)
      .map(task => (task.payload as { run_id: string }).run_id)).toEqual(["run-2"]);
    expect(env.roots(hostSessionContainerKey(other, fieldContractSha256))).toHaveLength(1);
    expect(warnings).toEqual(["omitted statement session chunk with an unavailable member source"]);
  });
});
