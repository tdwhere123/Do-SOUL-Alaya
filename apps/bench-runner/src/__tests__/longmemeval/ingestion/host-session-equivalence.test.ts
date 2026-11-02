import { afterEach, expect, it } from "vitest";
import { BoundSourceStatementSchema, type HostSessionMessage } from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import { SqliteFieldSourceRecordRepo } from "@do-soul/alaya-storage";
import {
  STATEMENT_SESSION_IDLE_MS
} from "../../../../../core-daemon/src/garden/statement-session/statement-session-closure.js";
import {
  RUN, WORKSPACE, createStatementSessionEnvironment
} from "../../../../../core-daemon/src/__tests__/garden/statement-session-fixture.js";
import { buildOfficialApiSourceCorpus } from "@do-soul/alaya-soul";
import {
  buildLongMemEvalRoundMessages, pairSessionIntoRounds, type LongMemEvalQuestion
} from "../../../datasets/longmemeval/ingestion/dataset.js";
import {
  createLongMemEvalHostSessionIssuer, importLongMemEvalQuestion, longMemEvalHostSessionRequests
} from "../../../datasets/longmemeval/ingestion/host-session-import.js";
import { prepareRecordedStatementIndex } from "../../support/recorded-statement-index.js";
import { createTestLongMemEvalDatasetAuthority } from "./test-dataset-authority.js";

type Environment = Awaited<ReturnType<typeof createStatementSessionEnvironment>>;
const environments: Environment[] = [];
afterEach(async () => { for (const environment of environments.splice(0)) await environment.close(); });
const QUERY_BUDGET = { work_units: 1000000, memory_bytes: 16 * 1024 * 1024 };

const question = {
  question_id: "equivalence-q", question_type: "multi-session", question: "Where does the user's greyhound sleep?",
  answer: "on the blue sofa", question_date: "2023/09/13 (Wed) 09:00", answer_session_ids: ["s-a"],
  haystack_session_ids: ["s-a", "s-b"], haystack_dates: ["2023/09/11 (Mon) 08:30", "2023/09/12 (Tue) 19:05"],
  haystack_sessions: [
    [{ role: "user", content: "I adopted a greyhound named Comet." }, { role: " Assistant ", content: "Congratulations on Comet." },
      { role: "user", content: "He sleeps on the\n blue  sofa." }, { role: "assistant", content: "That sounds cosy." },
      { role: "user", content: "Comet finished his first marathon walk 雪." }],
    [{ role: "assistant", content: "Welcome back." }, { role: "user", content: "My sister Ana visits Lisbon in May." },
      { role: "assistant", content: "Enjoy the visit." }]
  ]
} satisfies LongMemEvalQuestion;
const sha256 = "b".repeat(64);
const dataset = { questions: [question], sha256, checksumSource: "authored-fixture", sourcePath: "authored-fixture",
  promotionAuthority: createTestLongMemEvalDatasetAuthority({ datasetSha256: sha256, questionInputs: [question],
    assignments: [{ question_id: question.question_id, dataset_cohort: "answerable" }] }) };
const userStatements = (text: string) => /^(I |He |Comet |My )/u.test(text) ? [{ text: `The user said: ${text}`, relation: "life" }] : [];

async function environment(): Promise<Environment> {
  const created = await createStatementSessionEnvironment();
  environments.push(created);
  return created;
}

/** An attached host reports each completed exchange, re-sending the previous message as overlap, and
 * closes the conversation when it ends; an unclosed tail would wait for the idle sweep and only its
 * round's receipt time would differ. */
async function captureThroughMcp(env: Environment): Promise<void> {
  for (const session of longMemEvalHostSessionRequests(question)) {
    const messages: readonly HostSessionMessage[] = session.requests.flatMap(request => request.messages);
    const container = session.requests[0]!.container;
    for (let end = 2; end <= messages.length + 1; end += 2) {
      const last = end >= messages.length;
      await env.capture({ container, messages: messages.slice(Math.max(0, end - 3), Math.min(end, messages.length)),
        ...(last ? { closes_tail: true } : {}) });
    }
  }
}

async function settle(env: Environment): Promise<void> {
  env.advance(STATEMENT_SESSION_IDLE_MS);
  for (let pass = 0; pass < 4; pass++) await env.processSession(env.provider(userStatements));
}

/** Every durable product of capture and statement publication that a reader can observe. */
function observe(env: Environment) {
  const db = env.database.connection;
  const records = new SqliteFieldSourceRecordRepo(env.database, fieldContractSha256);
  const roots = db.prepare(`SELECT record_id, source_id, source_version, content_digest, source_body, event_time, recorded_at,
    speaker, scope_class FROM source_records ORDER BY source_id`).all() as { record_id: string; source_version: string; event_time: string; source_body: string;
    content_digest: string }[];
  const inventories = roots.map(root => records.readHostInventory({ workspaceId: WORKSPACE, recordId: root.record_id,
    sourceVersion: root.source_version, contentDigest: root.content_digest, authorizedScopes: ["project"],
    nativeByteLimit: 65536, workLimit: 262144, memoryLimit: 262144 }).inventory);
  const { index, targets } = prepareRecordedStatementIndex(env.database, WORKSPACE);
  return {
    roots,
    occurrences: inventories.map(inventory => inventory?.occurrences),
    issuers: inventories.map(inventory => inventory?.issuer),
    requests: [...env.requests].sort((left, right) => left.session_id.localeCompare(right.session_id)
      || left.chunk_index - right.chunk_index),
    statements: (db.prepare("SELECT gist FROM evidence_capsules WHERE gist LIKE '{%' ORDER BY gist").all() as { gist: string }[])
      .map(row => BoundSourceStatementSchema.parse(JSON.parse(row.gist))),
    memories: db.prepare("SELECT content, dimension, run_id FROM memory_entries ORDER BY content").all(),
    sessions: db.prepare(`SELECT status, json_extract(payload_json, '$.container_key') AS container_key,
      json_extract(payload_json, '$.chunk_index') AS chunk_index, json_extract(payload_json, '$.run_id') AS run_id
      FROM garden_tasks WHERE kind = 'source_statement_session' ORDER BY container_key, chunk_index`).all(),
    sourceIndex: targets,
    lexical: index.readLexicalCandidates(WORKSPACE, "sofa", 10, QUERY_BUDGET).candidates
      .map(row => [row.source.target, row.source.auxiliary ?? null])
  };
}

it("produces identical roots, occurrences, times, requests, statements and SourceIndex rows from the MCP entry and the bench import",
  { timeout: 60_000 }, async () => {
    const mcp = await environment(), bench = await environment();
    await captureThroughMcp(mcp);
    const issuer = createLongMemEvalHostSessionIssuer(dataset);
    await importLongMemEvalQuestion((request, named) => bench.hostSessionCapture.capture({ workspaceId: WORKSPACE, runId: RUN,
      request, issuer: named }), question, issuer);
    await settle(mcp);
    await settle(bench);

    const viaMcp = observe(mcp), viaBench = observe(bench);
    expect(viaMcp.roots).toHaveLength(5);
    expect(viaMcp.roots.map(root => root.event_time).sort()).toEqual([
      "2023-09-11T08:30:00.000Z", "2023-09-11T08:30:00.000Z", "2023-09-11T08:30:00.000Z",
      "2023-09-12T19:05:00.000Z", "2023-09-12T19:05:00.000Z"]);
    expect(viaMcp.statements.length).toBeGreaterThan(0);
    expect(viaMcp.lexical.length).toBeGreaterThan(0);
    const { issuers: mcpIssuers, ...mcpProducts } = viaMcp, { issuers: benchIssuers, ...benchProducts } = viaBench;
    expect(mcpProducts).toEqual(benchProducts);
    // Round bodies are byte-identical to the census rendering; only source ids and versions change.
    const census = question.haystack_sessions.flatMap((session, sessionIndex) => pairSessionIntoRounds(session).map(round =>
      buildOfficialApiSourceCorpus(round.content.trim(), buildLongMemEvalRoundMessages(session, round, `s${sessionIndex}`))));
    expect(viaBench.roots.map(root => root.source_body).sort()).toEqual(census.sort());
    // Only who asserts the host facts differs.
    expect(new Set(mcpIssuers.map(row => `${row?.producer}/${row?.basis}`))).toEqual(new Set(["mcp-host-session/host_session"]));
    expect(new Set(benchIssuers.map(row => `${row?.producer}/${row?.basis}`)))
      .toEqual(new Set(["longmemeval-structured-source/pinned_dataset"]));
  });

it("imports a session larger than one request window and an over-limit message as an honest excerpt", () => {
  const long = { ...question, haystack_sessions: [Array.from({ length: 70 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant", content: index === 3 ? "x".repeat(20_000) : `Message ${index}.` }))] };
  const [session] = longMemEvalHostSessionRequests({ ...long, haystack_dates: [question.haystack_dates[0]!] });
  expect(session!.requests.map(request => [request.messages.length, request.closes_tail ?? false])).toEqual([[64, false], [6, true]]);
  const excerpt = session!.requests[0]!.messages[3]!;
  expect(excerpt).toMatchObject({ completeness: "excerpt", fidelity: "original_bytes" });
  expect(Buffer.byteLength(excerpt.content, "utf8")).toBe(16_384);
});
