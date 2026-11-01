// Publishes cached production session statements into a harness raw snapshot through the
// production statement owners (root reader, session planner, receiver, session emitter,
// source-observation publication) before SourceIndex preparation.
//   STATEMENT_MAP=<session-map.jsonl>  rows {question_id, session_index, cache_file}
// Cached model output is matched to each host message by role and normalized text.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const tree = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const load = rel => import(pathToFileURL(join(tree, rel)).href);
const { SOURCE_STATEMENTS_CONTRACT } = await load("packages/protocol/dist/index.js");
const { createSourceObservationPublication, fieldContractSha256, EvidenceService, MemoryService, DynamicsService } =
  await load("packages/core/dist/index.js");
const { initDatabase, SqliteEventLogRepo, SqliteMemoryEntryRepo, SqliteEvidenceCapsuleRepo, SqliteKarmaEventRepo } =
  await load("packages/storage/dist/index.js");
const { GardenStatementSessionSources } = await load("packages/storage/dist/repos/garden/garden-statement-session-sources.js");
const { planSourceStatementSession, receiveSourceStatements, emitSourceStatementSessionSignals } =
  await load("packages/soul/dist/index.js");
const { rootStatementMessages } = await load("apps/core-daemon/dist/garden/statement-session/statement-session-task.js");
const { createDaemonFieldComposition } = await load("apps/core-daemon/dist/runtime/field/field-composition.js");

const norm = text => text.replace(/\s+/gu, " ").trim();
let cached;
function statementMap() {
  if (cached !== undefined) return cached;
  cached = new Map();
  for (const line of readFileSync(process.env.STATEMENT_MAP, "utf8").split("\n").filter(Boolean)) {
    const row = JSON.parse(line);
    const file = JSON.parse(readFileSync(row.cache_file, "utf8"));
    const out = new Map(JSON.parse(file.raw_json).messages.map(m => [m.message_id, m.statements]));
    const byText = new Map();
    for (const m of file.source_statement.request.messages) {
      const statements = out.get(m.message_id);
      if (Array.isArray(statements)) byText.set(`${m.role}\0${norm(m.text)}`, statements);
    }
    cached.set(`${row.question_id}-s${row.session_index}`, byText);
  }
  return cached;
}

function environment(dbPath) {
  const database = initDatabase({ filename: dbPath });
  const eventLogRepo = new SqliteEventLogRepo(database);
  const field = createDaemonFieldComposition({ database, eventLogRepo });
  const notifier = { notifyEntry: async () => undefined, notify: async () => undefined };
  const now = () => new Date().toISOString();
  const evidenceService = new EvidenceService({ evidenceCapsuleRepo: new SqliteEvidenceCapsuleRepo(database), eventLogRepo,
    runtimeNotifier: notifier, fieldStores: field.stores, now });
  const memoryRepo = new SqliteMemoryEntryRepo(database);
  const memoryService = new MemoryService({ memoryEntryRepo: memoryRepo, eventLogRepo, evidenceService, runtimeNotifier: notifier, now,
    dynamicsService: new DynamicsService({ memoryRepo, karmaEventRepo: new SqliteKarmaEventRepo(database), eventLogRepo, runtimeNotifier: notifier }) });
  const publication = createSourceObservationPublication({ stores: field.stores, evidenceService, memoryService,
    sha256: fieldContractSha256, deriveTemporalProjection: () => ({}) });
  return { database, field, publication };
}

/** Session roots of one question in session and round order, from the snapshot's source ids. */
function questionSessions(sql, workspace, questionId) {
  const sessions = new Map();
  for (const { record_id, source_id } of sql.prepare("SELECT record_id, source_id FROM source_records WHERE workspace_id = ?").all(workspace)) {
    const match = /^longmemeval_s:(.+)-s(\d+)-r(\d+)$/u.exec(source_id);
    if (match === null || match[1] !== questionId) continue;
    const si = Number(match[2]);
    sessions.set(si, [...(sessions.get(si) ?? []), { round: Number(match[3]), record_id, source_id }]);
  }
  for (const roots of sessions.values()) roots.sort((a, b) => a.round - b.round);
  return [...sessions].sort((a, b) => a[0] - b[0]);
}

/** Publishes statements for every recorded session of the question; returns counts. */
export async function publishStatementKeys({ snapshot, workspace, question: { question_id } }) {
  const report = { sessions: 0, rounds: 0, messages: 0, matched_messages: 0, keyed_messages: 0, statements: 0,
    unmapped_sessions: 0, raw_gaps: [], rejections: [] };
  const map = statementMap();
  const env = environment(snapshot);
  const sql = env.database.connection ?? env.database.db ?? env.database;
  const sources = new GardenStatementSessionSources(sql);
  try {
    for (const [si, roots] of questionSessions(sql, workspace, question_id)) {
      const sessionId = `${question_id}-s${si}`;
      const byText = map.get(sessionId);
      if (byText === undefined) report.unmapped_sessions++;
      const located = [], observed = new Map();
      for (const root of roots) {
        const read = sources.root(workspace, root.record_id);
        // Same rule as session closure: an unavailable or role-less root is a raw-only gap.
        if (read.status === "unavailable") { report.raw_gaps.push({ sid: root.source_id, reason: read.reason }); continue; }
        try { located.push(...rootStatementMessages(read.root)); }
        catch (error) { report.raw_gaps.push({ sid: root.source_id, reason: String(error.message ?? error) }); continue; }
        observed.set(root.record_id, env.field.stores.getRecord(workspace, root.record_id).recorded_at);
        report.rounds++;
      }
      report.sessions++;
      report.messages += located.length;
      const requests = [], results = [], planRejections = [];
      for (const chunk of planSourceStatementSession(sessionId, located.map(row => row.message))) {
        if (!("request" in chunk)) { planRejections.push({ message_id: chunk.message.message_id, reason: chunk.reason }); continue; }
        requests.push(chunk.request);
        const payload = { messages: chunk.request.messages.map(m => {
          const statements = byText?.get(`${m.role}\0${norm(m.text)}`);
          if (statements !== undefined) report.matched_messages++;
          return { message_id: m.message_id, statements: (statements ?? []).map(s => ({ text: s.text, relation: s.relation })) };
        }) };
        const received = receiveSourceStatements(chunk.request, JSON.stringify(payload));
        results.push(...received.messages);
        for (const r of received.rejections) report.rejections.push({ sessionId, ...r });
      }
      report.rejections.push(...planRejections.map(r => ({ sessionId, ...r })));
      const receipt = { contract: SOURCE_STATEMENTS_CONTRACT, session_id: sessionId, status: "partial",
        messages: results, rejections: planRejections, chunks: [] };
      const signals = emitSourceStatementSessionSignals({ receipt, requests, located, workspaceId: workspace, runId: workspace,
        surfaceId: null, createdAt: new Date().toISOString(), sourceObservation: null, generateSignalId: randomUUID })
        .map(signal => ({ ...signal, source_observation: { authority: "trusted_host_event", source_event_id: "c29-statement-keys",
          observed_at: observed.get(signal.raw_payload.source_statement.source_root_id) } }));
      report.keyed_messages += new Set(signals.map(s => s.raw_payload.source_statement.message.message_id)).size;
      for (const signal of signals) {
        await env.publication.publish({ signal, sourceEventAnchor: null });
        report.statements++;
      }
    }
  } finally {
    try { sql.pragma?.("wal_checkpoint(TRUNCATE)"); } catch { /* closed below */ }
    env.database.close?.();
  }
  return { ...report, status: "published", db_sha256: createHash("sha256").update(readFileSync(snapshot)).digest("hex") };
}
