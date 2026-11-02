import { afterEach, describe, expect, it } from "vitest";
import {
  GardenTaskKind, hashLabeledIdentity, hostSessionContainerKey, hostSessionStatementSessionId, type HostSessionMessage
} from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import { SqliteFieldSourceRecordRepo } from "@do-soul/alaya-storage";
import { createHostSessionCapture, MCP_HOST_SESSION_ISSUER } from "../../garden/host-session/host-session-capture.js";
import { STATEMENT_SESSION_IDLE_MS } from "../../garden/statement-session/statement-session-closure.js";
import { createGardenTaskHandlers } from "../../mcp-memory/garden-task/garden-task-handlers.js";
import { CONTAINER, CONTAINER_KEY, RUN, WORKSPACE, createStatementSessionEnvironment, hostMessages } from "./statement-session-fixture.js";

type Environment = Awaited<ReturnType<typeof createStatementSessionEnvironment>>;
const environments: Environment[] = [];
afterEach(async () => { for (const environment of environments.splice(0)) await environment.close(); });
async function environment(): Promise<Environment> {
  const created = await createStatementSessionEnvironment();
  environments.push(created);
  return created;
}
const turn = (user: string, assistant = "Noted.") =>
  [{ role: "user" as const, content: user }, { role: "assistant" as const, content: assistant }];
const SIX = hostMessages([turn("I moved to Lisbon."), turn("My sister is Ana."), turn("I run on Sundays.")]);
const count = (env: Environment, table: string) =>
  (env.database.connection.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const records = (env: Environment) => new SqliteFieldSourceRecordRepo(env.database, fieldContractSha256);

describe("host session capture contract", { timeout: 30_000 }, () => {
  it("admits each message once across sliding and repeated windows, with the roots of a single capture", async () => {
    const sliding = await environment(), whole = await environment();
    for (const window of [SIX.slice(0, 3), SIX.slice(1, 5), SIX.slice(0, 6), SIX.slice(2, 6)]) {
      await sliding.capture({ container: CONTAINER, messages: window });
    }
    await whole.capture({ container: CONTAINER, messages: SIX });

    expect(count(sliding, "host_session_messages")).toBe(6);
    expect(sliding.roots()).toEqual(whole.roots());
    expect(sliding.roots()).toHaveLength(3);
    expect(records(sliding).listByWorkspace(WORKSPACE).map(row => row.record_id).sort())
      .toEqual([...sliding.roots()].sort());
    expect(await sliding.capture({ container: CONTAINER, messages: SIX })).toEqual({ container_key: CONTAINER_KEY,
      admitted_message_count: 0, replayed_message_count: 6, pending_message_count: 0, admitted_round_count: 0 });
  });

  it("refuses a whole request on any conflict and admits none of its messages", async () => {
    const env = await environment();
    await env.capture({ container: CONTAINER, messages: SIX.slice(0, 2) });
    const changed = { ...SIX[1]!, content: "Changed after capture." };
    const relocated = { ...SIX[2]!, message_id: "other-id", position: 1 };
    for (const messages of [[changed, SIX[2]!], [relocated], [{ ...SIX[1]!, completeness: "excerpt" as const }]]) {
      await expect(env.capture({ container: CONTAINER, messages })).rejects.toMatchObject({ code: "CONFLICT" });
    }
    expect(count(env, "host_session_messages")).toBe(2);

    // Another producer cannot write into a container this issuer owns.
    const other = createHostSessionCapture({ admission: env.sourceAdmission, ledger: env.gardenTaskRepo.hostSessions,
      statementSessions: env.gardenTaskRepo, now: env.now, warn: () => undefined });
    await expect(other.capture({ workspaceId: WORKSPACE, runId: RUN, request: { container: CONTAINER, messages: SIX.slice(2, 4) },
      issuer: { producer: "another-host", binding: MCP_HOST_SESSION_ISSUER.binding } })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(count(env, "host_session_messages")).toBe(2);
  });

  it("recovers a round whose receipt committed before its audit failed, keeping the first receipt", async () => {
    const env = await environment();
    let failAudit = true;
    const capture = createHostSessionCapture({ ledger: env.gardenTaskRepo.hostSessions, statementSessions: env.gardenTaskRepo,
      now: env.now, warn: () => undefined, admission: { ...env.sourceAdmission, audit: async record => {
        if (failAudit) throw new Error("source audit unavailable");
        await env.sourceAdmission.audit!(record);
      } } });
    const request = { container: CONTAINER, messages: SIX.slice(0, 2) };
    const call = () => capture.capture({ workspaceId: WORKSPACE, runId: RUN, request, issuer: MCP_HOST_SESSION_ISSUER });

    await expect(call()).rejects.toThrow("source audit unavailable");
    const [committed] = records(env).listByWorkspace(WORKSPACE);
    expect(committed).toBeDefined();
    expect(env.roots()).toEqual([]);
    failAudit = false;
    env.advance(60_000);
    expect(await call()).toMatchObject({ admitted_message_count: 0, replayed_message_count: 2, admitted_round_count: 1 });
    expect(records(env).listByWorkspace(WORKSPACE)).toEqual([committed]);
    expect(env.roots()).toEqual([committed!.record_id]);
    expect(env.database.connection.prepare(`SELECT COUNT(*) AS n FROM event_log WHERE entity_id = ?`)
      .get(committed!.record_id)).toEqual({ n: 1 });
  });

  it("retains original bytes with honest fidelity, container, position and host time across a reopen", async () => {
    const env = await environment();
    const messages: HostSessionMessage[] = [
      { message_id: "u-1", position: 4, role: "user", content: "  café\n雪 ", completeness: "complete",
        fidelity: "original_bytes", host_reported_at: "2026-09-01T08:00:00.000Z" },
      { message_id: "a-1", position: 5, role: "assistant", content: "Bem-vindo.", completeness: "excerpt",
        fidelity: "original_bytes" }];
    await env.capture({ container: CONTAINER, messages });
    const [rootId] = env.roots();
    const database = env.reopen();
    const reader = new SqliteFieldSourceRecordRepo(database, fieldContractSha256);
    const root = reader.findById(WORKSPACE, rootId!)!;
    expect(root).toMatchObject({ source_id: `host-session:${CONTAINER_KEY}:r0`, source_version: "host-session-v1",
      source_body: "User: café 雪\nAssistant: Bem-vindo.", event_time: "2026-09-01T08:00:00.000Z" });
    const read = reader.readHostInventory({ workspaceId: WORKSPACE, recordId: root.record_id, sourceVersion: root.source_version,
      contentDigest: root.content_digest, authorizedScopes: ["project"], nativeByteLimit: 65536, workLimit: 262144,
      memoryLimit: 262144 });
    expect(read.inventory?.issuer).toMatchObject({ producer: "mcp-host-session", basis: "host_session" });
    expect(read.inventory?.occurrences.map(row => [row.occurrence_id, row.role, row.completeness, row.fidelity,
      row.container_ref, row.upstream_position, row.host_reported_at ?? null])).toEqual([
      ["u-1", "user", "complete", "normalized", CONTAINER, 4, "2026-09-01T08:00:00.000Z"],
      ["a-1", "assistant", "excerpt", "original_bytes", CONTAINER, 5, null]]);
  });

  it("keeps two containers of one process in two statement sessions attributed to their capturing runs", async () => {
    const env = await environment();
    const second = { scope: CONTAINER.scope, id: "conversation-2" };
    await env.capture({ container: CONTAINER, messages: SIX.slice(0, 2) });
    await env.capture({ container: second, messages: SIX.slice(0, 2) }, "run-2");
    env.advance(STATEMENT_SESSION_IDLE_MS);
    for (let pass = 0; pass < 2; pass++) await env.processSession(env.provider(() => []));

    expect(env.requests.map(request => request.session_id).sort()).toEqual([
      hostSessionStatementSessionId(CONTAINER_KEY), hostSessionStatementSessionId(hostSessionContainerKey(second, fieldContractSha256))].sort());
    expect(env.sessionTasks().map(row => JSON.parse(row.payload_json).run_id).sort()).toEqual([RUN, "run-2"]);
    // Same text in two containers is two sources.
    expect(env.roots()).not.toEqual(env.roots(hostSessionContainerKey(second, fieldContractSha256)));
  });

  it("keeps erased text out after erasure: a replayed window admits nothing and a changed body still conflicts", async () => {
    const env = await environment();
    await env.capture({ container: CONTAINER, messages: SIX.slice(0, 2) });
    const [rootId] = env.roots();
    env.field.fieldRepos.erase.apply({
      identity: hashLabeledIdentity("erase_barrier", [WORKSPACE, "source_record", rootId!, ""], fieldContractSha256),
      barrier_id: "erase-round", workspace_id: WORKSPACE, generation_id: null, subject_kind: "source_record",
      subject_id: rootId!, erased_at: env.now() });

    expect(await env.capture({ container: CONTAINER, messages: SIX.slice(0, 2) }))
      .toMatchObject({ admitted_message_count: 0, replayed_message_count: 2, admitted_round_count: 0 });
    await expect(env.capture({ container: CONTAINER, messages: [{ ...SIX[0]!, content: "Rewritten." }] }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(env.database.connection.prepare("SELECT pending_body FROM host_session_messages").all())
      .toEqual([{ pending_body: null }, { pending_body: null }]);
    expect(count(env, "source_records")).toBe(1);
  });

  it("fails historical post-turn work with an audited, private completion", async () => {
    const env = await environment();
    const secret = "unavailable-private-turn-7c91";
    const payload = { workspace_id: WORKSPACE, run_id: RUN, turn_index: 3,
      turn_digest: { last_messages: [{ role: "user", content_excerpt: secret }] } };
    env.gardenTaskRepo.enqueue({ id: "legacy-post-turn", workspace_id: WORKSPACE, role: "librarian",
      kind: GardenTaskKind.POST_TURN_EXTRACT, payload, created_at: env.now() });
    const handlers = createGardenTaskHandlers({ now: env.now, warn: () => undefined, generateId: () => "attempt-1",
      deps: { gardenTaskRepo: env.gardenTaskRepo, signalService: env.signalService, postTurnSignalReceiver: env.signalReceiver } });
    const context = { workspaceId: WORKSPACE, runId: null, agentTarget: "codex", sessionId: "session-1" };

    const listed = await handlers.listPendingGardenTasks({ role: "host_worker", limit: 10 }, context);
    expect(listed.tasks).toEqual([]);
    expect(JSON.stringify(listed)).not.toContain(secret);
    expect(env.gardenTaskRepo.findById("legacy-post-turn")).toMatchObject({ status: "failed", payload,
      last_error_text: "Post-turn source provenance unavailable: post-turn capture retired" });
    expect(env.database.connection.prepare(`SELECT json_extract(payload_json, '$.success') AS success FROM event_log
      WHERE entity_id = 'legacy-post-turn' AND caused_by = 'garden-source-provenance'`).all()).toEqual([{ success: 0 }]);
  });

  it("lists and claims a session request over messages larger than the generic JSON payload limit", async () => {
    const env = await environment();
    await env.capture({ container: CONTAINER, closes_tail: true,
      messages: hostMessages([turn("a".repeat(9000), "b".repeat(9000))]) });
    const handlers = createGardenTaskHandlers({ now: env.now, warn: () => undefined, generateId: () => "attempt-1",
      deps: { gardenTaskRepo: env.gardenTaskRepo, signalService: env.signalService, postTurnSignalReceiver: env.signalReceiver } });
    const context = { workspaceId: WORKSPACE, runId: null, agentTarget: "codex", sessionId: "session-1" };
    const [task] = (await handlers.listPendingGardenTasks({ role: "host_worker", limit: 10 }, context)).tasks;
    expect(task).toMatchObject({ kind: GardenTaskKind.SOURCE_STATEMENT_SESSION });
    const claimed = await handlers.claimGardenTask({ task_id: task!.task_id }, context);
    expect(claimed).toMatchObject({ status: "claimed", payload: { source_statements: { requests: [{ chunk_index: 0,
      session_id: hostSessionStatementSessionId(CONTAINER_KEY), context: [], messages: [
        { message_id: "message-0", role: "user", text: "a".repeat(9000), recorded_at: null },
        { message_id: "message-1", role: "assistant", text: "b".repeat(9000), recorded_at: null }] }] } } });
  });
});
