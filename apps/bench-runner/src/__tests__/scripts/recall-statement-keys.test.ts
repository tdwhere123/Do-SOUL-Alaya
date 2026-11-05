import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { initDatabase, SqliteRunRepo } from "@do-soul/alaya-storage";
import { WORKSPACE, createStatementSessionEnvironment } from "../../../../core-daemon/src/__tests__/garden/statement-session-fixture.js";
import { captureLongMemEvalWindow, longMemEvalSessionContainer } from "../../datasets/longmemeval/ingestion/host-session-import.js";

const saved = process.env.STATEMENT_MAP;
afterEach(() => {
  if (saved === undefined) delete process.env.STATEMENT_MAP; else process.env.STATEMENT_MAP = saved;
});

it("changes the statement map digest when a named cache file changes behind an unchanged map", async () => {
  const root = mkdtempSync(join(tmpdir(), "recall-statement-digest-"));
  try {
    const cache = join(root, "q-s0.json"), map = join(root, "session-map.jsonl");
    writeFileSync(cache, "{\"raw_json\":\"first\"}");
    writeFileSync(map, JSON.stringify({ question_id: "q", session_index: 0, cache_file: cache }) + "\n");
    process.env.STATEMENT_MAP = map;
    const script = fileURLToPath(new URL("../../../scripts/recall-statement-keys.mjs", import.meta.url));
    const { statementMapDigest } = await import(pathToFileURL(script).href);
    const before = statementMapDigest();
    expect(statementMapDigest()).toBe(before);
    writeFileSync(cache, "{\"raw_json\":\"second\"}");
    expect(statementMapDigest()).not.toBe(before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("keeps failing after a statement map file is unreadable instead of serving the partial map", async () => {
  const root = mkdtempSync(join(tmpdir(), "recall-statement-keys-"));
  try {
    const present = join(root, "q-s0.json");
    writeFileSync(present, JSON.stringify({
      raw_json: JSON.stringify({ messages: [{ message_id: "q:s0:m0", statements: [{ text: "t", relation: "r" }] }] }),
      source_statement: { request: { messages: [{ message_id: "q:s0:m0", role: "user", text: "hello" }] } }
    }));
    const map = join(root, "session-map.jsonl");
    writeFileSync(map, [
      { question_id: "q", session_index: 0, cache_file: present },
      { question_id: "q", session_index: 1, cache_file: join(root, "missing.json") }
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    process.env.STATEMENT_MAP = map;
    const script = fileURLToPath(new URL("../../../scripts/recall-statement-keys.mjs", import.meta.url));
    const { publishStatementKeys } = await import(pathToFileURL(script).href);
    const input = { snapshot: join(root, "absent.sqlite"), workspace: "w", question: { question_id: "q" },
      publication: { sources: [] } };
    await expect(publishStatementKeys(input)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(publishStatementKeys(input)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("publishes a cached statement beyond the first round page and rejects incomplete membership", { timeout: 30_000 }, async () => {
  const env = await createStatementSessionEnvironment();
  try {
    const questionId = "round-page", container = longMemEvalSessionContainer(questionId, 0);
    const messages = Array.from({ length: 70 }, (_, position) => ({ message_id: `message-${position}`, position,
      role: "assistant" as const, content: `Message ${position}.`, completeness: "complete" as const, fidelity: "original_bytes" as const }));
    await new SqliteRunRepo(env.database).create({ run_id: WORKSPACE, workspace_id: WORKSPACE, title: "publication", goal: null,
      run_mode: "chat", engine_binding_id: null, engine_class: null, run_state: "idle", current_surface_id: null });
    await captureLongMemEvalWindow(() => env.capture({ container, messages: messages.slice(0, 64) }));
    const closed = await captureLongMemEvalWindow(() => env.capture({ container, messages: messages.slice(64), closes_tail: true }));
    expect(closed.pending_round_count).toBe(0);
    const rounds = env.database.connection.prepare(`SELECT round_index, root_id FROM host_session_rounds
      WHERE workspace_id = ? AND state = 'done' ORDER BY round_index`).all(WORKSPACE) as { round_index: number; root_id: string }[];
    expect(rounds.map(row => row.round_index)).toEqual(Array.from({ length: 70 }, (_, index) => index));
    const publication = { sources: rounds.map(row => ({ session_index: 0, round_index: row.round_index, record_id: row.root_id })) };
    const cache = join(env.directory, "recorded.json"), map = join(env.directory, "session-map.jsonl");
    writeFileSync(cache, JSON.stringify({ raw_json: JSON.stringify({ messages: [{ message_id: "cached-message",
      statements: [{ text: "Message 68.", relation: "recorded message" }] }] }), source_statement: { request: {
      messages: [{ message_id: "cached-message", role: "assistant", text: "Message 68." }] } } }));
    writeFileSync(map, JSON.stringify({ question_id: questionId, session_index: 0, cache_file: cache }) + "\n");
    process.env.STATEMENT_MAP = map;
    env.database.close();
    const script = fileURLToPath(new URL("../../../scripts/recall-statement-keys.mjs", import.meta.url));
    const { publishStatementKeys } = await import(pathToFileURL(script).href);
    const input = { snapshot: env.filename, workspace: WORKSPACE, question: { question_id: questionId }, publication };
    expect(await publishStatementKeys(input)).toMatchObject({ status: "published", sessions: 1, rounds: 70, messages: 70,
      matched_messages: 1, keyed_messages: 1, statements: 1, unmapped_sessions: 0, raw_gaps: [], rejections: [] });
    await expect(publishStatementKeys({ ...input, publication: { sources: publication.sources.slice(0, 69) } }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    const reopened = initDatabase({ filename: env.filename });
    try {
      expect(reopened.connection.prepare("SELECT content, run_id FROM memory_entries WHERE content = ?").all("Message 68."))
        .toEqual([{ content: "Message 68.", run_id: WORKSPACE }]);
    } finally { reopened.close(); }
  } finally {
    await env.close();
  }
});
