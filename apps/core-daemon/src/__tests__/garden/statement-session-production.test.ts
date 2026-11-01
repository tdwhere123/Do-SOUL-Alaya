import { afterEach, describe, expect, it } from "vitest";
import {
  BoundSourceStatementSchema, SOURCE_STATEMENT_LIMITS, SourceStatementRequestSchema, hashLabeledIdentity, type SourceStatementRequest
} from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import { STATEMENT_SESSION_IDLE_MS } from "../../garden/statement-session/statement-session-closure.js";
import { createGardenTaskHandlers } from "../../mcp-memory/garden-task/garden-task-handlers.js";
import { prepareRecordedStatementIndex } from "../../../../bench-runner/src/__tests__/support/recorded-statement-index.js";
import { sourceStatementRequests } from "../../../../bench-runner/src/runs/extraction/source-statement-request.js";
import { RUN, START, WORKSPACE, createStatementSessionEnvironment } from "./statement-session-fixture.js";

type Environment = Awaited<ReturnType<typeof createStatementSessionEnvironment>>;
const environments: Environment[] = [];
afterEach(async () => { for (const environment of environments.splice(0)) await environment.close(); });
const QUERY_BUDGET = { work_units: 1000000, memory_bytes: 16 * 1024 * 1024 };
const THREE_TURNS = [
  [{ role: "user", content_excerpt: "I adopted a greyhound named Comet." }, { role: "assistant", content_excerpt: "Congratulations on Comet." }],
  [{ role: "user", content_excerpt: "He sleeps on the\nblue sofa." }, { role: "assistant", content_excerpt: "That sounds cosy." }],
  [{ role: "user", content_excerpt: "Comet finished his first marathon walk." }, { role: "assistant", content_excerpt: "Great progress." }]
];
const userStatement = (text: string) => text.startsWith("I ") || text.startsWith("He ") || text.startsWith("Comet ")
  ? [{ text: `The user said: ${text}`, relation: "pet life" }] : [];

async function environment(): Promise<Environment> {
  const created = await createStatementSessionEnvironment();
  environments.push(created);
  return created;
}
async function reportTurns(env: Environment, turns: readonly (readonly { role: string; content_excerpt: string }[])[],
  retainEvidence = true) {
  for (const [index, turn] of turns.entries()) { await env.report(index, turn); if (retainEvidence) await env.processPostTurn(); }
}
function projectionRoots(env: Environment): readonly string[] {
  return (env.database.connection.prepare(`SELECT json_extract(payload_json, '$.admitted_source_root_id') AS root
    FROM garden_tasks WHERE kind = 'post_turn_extract' ORDER BY json_extract(payload_json, '$.turn_index')`).all() as
    { root: string }[]).map(row => row.root);
}
function boundStatements(env: Environment) {
  return (env.database.connection.prepare("SELECT gist FROM evidence_capsules WHERE gist LIKE '{%'").all() as { gist: string }[])
    .map(row => BoundSourceStatementSchema.parse(JSON.parse(row.gist)));
}
function orderedRequests(env: Environment): readonly SourceStatementRequest[] {
  return [...env.requests].sort((left, right) => left.chunk_index - right.chunk_index);
}
function longRun(count: number) {
  return Array.from({ length: count }, (_, index) => [{ role: index % 2 === 0 ? "user" : "assistant",
    content_excerpt: `Entry ${index} recorded the garden plan. `.padEnd(560, "x") }]);
}

describe("production statement sessions over post-turn roots", { timeout: 30_000 }, () => {
  it("closes an idle three-turn run into one request bound per root and nominated through statement keys", async () => {
    const env = await environment();
    await reportTurns(env, THREE_TURNS);
    expect(env.sessionTasks()).toEqual([]);
    env.advance(STATEMENT_SESSION_IDLE_MS - 1);
    await env.processSession(env.provider(userStatement));
    expect(env.sessionTasks()).toEqual([]);
    env.advance(1);
    await env.processSession(env.provider(userStatement));
    expect(env.sessionTasks().map(row => row.status)).toEqual(["completed"]);
    expect(env.requests).toHaveLength(1);
    const request = env.requests[0]!;
    expect(request).toMatchObject({ session_id: RUN, chunk_index: 0, context: [] });
    expect(request.messages.map(message => [message.role, message.text, message.recorded_at])).toEqual(
      THREE_TURNS.flat().map(message => [message.role, message.content_excerpt.replace("\n", " "), null]));

    const roots = projectionRoots(env), bound = boundStatements(env);
    expect(bound).toHaveLength(3);
    bound.forEach((statement, turn) => {
      expect(statement.source_root_id).toBe(roots[turn]);
      expect(statement.artifact_key).toBe(`post-turn:${statement.message.message_id.split(":")[1]}`);
      expect(statement.source_context.map(source => source.root_id).sort()).toEqual(roots.filter((_, index) => index !== turn).sort());
    });
    const { index, targets } = prepareRecordedStatementIndex(env.database, WORKSPACE);
    const marathon = targets.find(target => target.auxiliary !== undefined && target.target.root_id === roots[2]);
    expect(marathon).toBeDefined();
    const lexical = index.readLexicalCandidates(WORKSPACE, "marathon", 10, QUERY_BUDGET);
    expect(lexical.candidates.some(row => row.source.auxiliary !== undefined && row.source.target.root_id === roots[2])).toBe(true);
  });

  it("closes full chunks before idle and gives a later chunk the longest recent context, as the bench plans it", async () => {
    const env = await environment(), turns = longRun(70);
    await reportTurns(env, turns, false);
    const provider = env.provider(() => []);
    await env.processSession(provider);
    const closed = env.sessionTasks();
    expect(closed.length).toBeGreaterThan(0);
    expect(closed.every(row => JSON.parse(row.payload_json).closes_tail === false)).toBe(true);
    for (let pass = 0; pass < closed.length; pass++) await env.processSession(provider);
    env.advance(STATEMENT_SESSION_IDLE_MS);
    for (let pass = 0; pass < 2; pass++) await env.processSession(provider);
    const tasks = env.sessionTasks();
    expect(tasks.length).toBe(closed.length + 1);
    expect(tasks.every(row => row.status === "completed")).toBe(true);
    expect(JSON.parse(tasks.at(-1)!.payload_json).closes_tail).toBe(true);

    const requests = orderedRequests(env), messages = requests.flatMap(request => request.messages);
    expect(messages).toHaveLength(70);
    const late = requests.at(-1)!, first = messages.findIndex(row => row.message_id === late.messages[0]!.message_id);
    expect(late.context).toEqual(messages.slice(first - late.context.length, first));
    expect(Buffer.byteLength(JSON.stringify(late.context))).toBeLessThanOrEqual(SOURCE_STATEMENT_LIMITS.contextBytes);
    expect(Buffer.byteLength(JSON.stringify(messages.slice(first - late.context.length - 1, first))))
      .toBeGreaterThan(SOURCE_STATEMENT_LIMITS.contextBytes);

    const bench = sourceStatementRequests(messages.map(row => ({ message_id: row.message_id,
      role: row.role as "user" | "assistant", content: row.text }))).map(row => row.source);
    const anonymous = (rows: readonly SourceStatementRequest[]) => rows.map(({ session_id: _session, ...row }) => row);
    expect(anonymous(requests)).toEqual(anonymous(bench));
  });

  it("lets a host worker claim, answer and publish one session request against current roots", async () => {
    const env = await environment();
    await reportTurns(env, THREE_TURNS);
    env.advance(STATEMENT_SESSION_IDLE_MS);
    await env.processSession(env.provider(userStatement), { provider_kind: "host_worker", model_id: null,
      provider_url: null, secret_ref: null, enabled: true });
    const [task] = env.sessionTasks();
    expect(task).toMatchObject({ status: "pending" });
    const handlers = createGardenTaskHandlers({ now: env.now, warn: () => undefined, generateId: () => "attempt-1",
      deps: { gardenTaskRepo: env.gardenTaskRepo, signalService: env.signalService, postTurnSignalReceiver: env.signalReceiver } });
    const context = { workspaceId: WORKSPACE, runId: null, agentTarget: "codex", sessionId: "session-1" };
    const listed = await handlers.listPendingGardenTasks({ role: "host_worker", limit: 10 }, context);
    const snapshot = listed.tasks.find(row => row.task_id === task!.id)!;
    expect(snapshot).toMatchObject({ role: "host_worker", kind: "source_statement_session" });
    const claimed = await handlers.claimGardenTask({ task_id: task!.id }, context);
    const request = SourceStatementRequestSchema.parse(
      (claimed.payload as { source_statements: { requests: readonly unknown[] } }).source_statements.requests[0]);
    expect(request.messages).toHaveLength(6);
    await expect(handlers.completeGardenTask({ task_id: task!.id, status: "completed", result_envelope: {
      source_statement_responses: [{ chunk_index: request.chunk_index, raw_json: JSON.stringify({ messages: request.messages.map(
        message => ({ message_id: message.message_id, statements: userStatement(message.text) })) }) }]
    } }, context)).resolves.toMatchObject({ status: "completed" });
    expect(env.sessionTasks()[0]!.status).toBe("completed");
    expect(boundStatements(env).map(row => row.source_root_id)).toEqual(projectionRoots(env));
  });

  it("fails a queued request whose member root is erased and withdraws completed statements on erasure", async () => {
    const env = await environment();
    await reportTurns(env, THREE_TURNS);
    env.advance(STATEMENT_SESSION_IDLE_MS);
    const erase = (rootId: string) => env.field.fieldRepos.erase.apply({
      identity: hashLabeledIdentity("erase_barrier", [WORKSPACE, "source_record", rootId, ""], fieldContractSha256),
      barrier_id: `erase-${rootId.slice(-12)}`, workspace_id: WORKSPACE, generation_id: null,
      subject_kind: "source_record", subject_id: rootId, erased_at: env.now() });
    const roots = projectionRoots(env), provider = env.provider(userStatement);
    await env.processSession(provider, { provider_kind: "host_worker", model_id: null, provider_url: null, secret_ref: null, enabled: true });
    expect(env.sessionTasks()[0]!.status).toBe("pending");
    erase(roots[1]!);
    expect(env.sessionTasks()[0]).toMatchObject({ status: "failed", last_error_text: "Source erased" });
    let rejected: unknown;
    try {
      env.gardenTaskRepo.enqueue({ id: "session-replay", workspace_id: WORKSPACE, role: "librarian",
        kind: "source_statement_session", payload: JSON.parse(env.sessionTasks()[0]!.payload_json), created_at: START });
    } catch (error) { rejected = error; }
    expect(String((rejected as Error | undefined)?.cause)).toContain("garden task source erased");
    await env.processSession(provider);
    expect(env.requests).toEqual([]);

    const completed = await environment();
    await reportTurns(completed, THREE_TURNS);
    completed.advance(STATEMENT_SESSION_IDLE_MS);
    await completed.processSession(completed.provider(userStatement));
    expect(completed.database.connection.prepare("SELECT COUNT(*) AS n FROM source_statement_artifacts").get()).toEqual({ n: 3 });
    const completedRoots = projectionRoots(completed);
    completed.field.fieldRepos.erase.apply({
      identity: hashLabeledIdentity("erase_barrier", [WORKSPACE, "source_record", completedRoots[0]!, ""], fieldContractSha256),
      barrier_id: "erase-first-turn", workspace_id: WORKSPACE, generation_id: null,
      subject_kind: "source_record", subject_id: completedRoots[0]!, erased_at: completed.now() });
    // Every statement saw the first turn as its own root or as model-visible context.
    expect(completed.database.connection.prepare("SELECT COUNT(*) AS n FROM source_statement_artifacts").get()).toEqual({ n: 0 });
    expect(completed.database.connection.prepare(`SELECT COUNT(*) AS n FROM signals
      WHERE json_type(raw_payload_json, '$.source_statement_unavailable') IS NOT NULL`).get()).toEqual({ n: 3 });
  });

  it("enqueues each chunk once across replayed reports and repeated idle sweeps", async () => {
    const env = await environment(), turns = longRun(70);
    await reportTurns(env, turns, false);
    for (const [index, turn] of turns.entries()) await env.report(index, turn);
    const before = env.sessionTasks().map(row => row.id);
    expect(before.length).toBeGreaterThan(0);
    env.advance(STATEMENT_SESSION_IDLE_MS);
    const provider = env.provider(() => []);
    for (let pass = 0; pass < 4; pass++) await env.processSession(provider);
    await env.report(0, turns[0]!);
    const after = env.sessionTasks();
    expect(after.map(row => row.id).slice(0, before.length)).toEqual(before);
    expect(new Set(after.map(row => row.id)).size).toBe(after.length);
    expect(after.every(row => row.status === "completed")).toBe(true);
    expect(env.requests.flatMap(request => request.messages)).toHaveLength(70);
  });
});
