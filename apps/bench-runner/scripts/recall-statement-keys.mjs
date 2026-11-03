// Publishes cached production session statements into a harness raw snapshot through the
// production statement owners (container rounds, root reader, session planner, receiver, session emitter,
// source-observation publication) before SourceIndex preparation.
//   STATEMENT_MAP=<session-map.jsonl>  rows {question_id, session_index, cache_file}
// Cached model output is matched to each host message by role and normalized text, so caches keyed by
// dataset session stay valid whatever the round root ids are.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const tree = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const load = rel => import(pathToFileURL(join(tree, rel)).href);
// Loaded only to publish: digesting the map must not pull in the built packages.
let owners;
const production = () => owners ??= Promise.all([
  "packages/protocol/dist/index.js", "packages/core/dist/index.js", "packages/storage/dist/index.js",
  "packages/storage/dist/repos/garden/garden-statement-session-sources.js", "packages/soul/dist/index.js",
  "apps/core-daemon/dist/garden/statement-session/statement-session-task.js",
  "apps/core-daemon/dist/runtime/field/field-composition.js",
  "apps/bench-runner/dist/datasets/longmemeval/ingestion/host-session-import.js"
].map(load)).then(modules => Object.assign({}, ...modules));

const norm = text => text.replace(/\s+/gu, " ").trim();
let cached;
function statementMap() {
  if (cached !== undefined) return cached;
  // Published only once complete: a partial map would publish later questions as silently unmapped.
  const map = new Map();
  for (const line of readFileSync(process.env.STATEMENT_MAP, "utf8").split("\n").filter(Boolean)) {
    const row = JSON.parse(line);
    const file = JSON.parse(readFileSync(row.cache_file, "utf8"));
    const out = new Map(JSON.parse(file.raw_json).messages.map(m => [m.message_id, m.statements]));
    const byText = new Map();
    for (const m of file.source_statement.request.messages) {
      const statements = out.get(m.message_id);
      if (Array.isArray(statements)) byText.set(`${m.role}\0${norm(m.text)}`, statements);
    }
    map.set(`${row.question_id}-s${row.session_index}`, byText);
  }
  cached = map;
  return cached;
}

/** The map and every cache file it names, in map order: either can change the published statements. */
export function statementMapDigest() {
  const hash = createHash("sha256"), index = readFileSync(process.env.STATEMENT_MAP);
  hash.update(index);
  for (const line of index.toString("utf8").split("\n").filter(Boolean)) {
    const bytes = readFileSync(JSON.parse(line).cache_file);
    hash.update(`\0${bytes.length}\0`).update(bytes);
  }
  return hash.digest("hex");
}

function environment(dbPath, { initDatabase, SqliteEventLogRepo, SqliteMemoryEntryRepo, SqliteEvidenceCapsuleRepo,
  SqliteKarmaEventRepo, createDaemonFieldComposition, EvidenceService, MemoryService, DynamicsService,
  createSourceObservationPublication, fieldContractSha256 }) {
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

/** Each published session's round roots in round order, read from its host container's capture ledger. */
function questionSessions(sources, workspace, questionId, publication,
  { AlayaError, hostSessionContainerKey, longMemEvalSessionContainer, fieldContractSha256 }) {
  const sessions = [...new Set(publication.sources.map(source => source.session_index))].sort((a, b) => a - b);
  return sessions.map(si => {
    const key = hostSessionContainerKey(longMemEvalSessionContainer(questionId, si), fieldContractSha256);
    const roots = sources.rounds(workspace, key).map(round => round.root_id);
    const published = publication.sources.filter(source => source.session_index === si)
      .sort((a, b) => a.round_index - b.round_index).map(source => source.record_id);
    if (JSON.stringify(roots) !== JSON.stringify(published)) throw new AlayaError("CONFLICT", `session ${si} rounds differ from its publication`);
    return [si, key, roots];
  });
}

/** Publishes statements for every recorded session of the question; returns counts. */
export async function publishStatementKeys({ snapshot, workspace, question: { question_id }, publication }) {
  const report = { sessions: 0, rounds: 0, messages: 0, matched_messages: 0, keyed_messages: 0, statements: 0,
    unmapped_sessions: 0, raw_gaps: [], rejections: [] };
  const map = statementMap(), owners = await production();
  const { SOURCE_STATEMENTS_CONTRACT, hostSessionStatementSessionId, GardenStatementSessionSources, rootStatementMessages,
    planSourceStatementSession, receiveSourceStatements, emitSourceStatementSessionSignals } = owners;
  const env = environment(snapshot, owners);
  const sql = env.database.connection ?? env.database.db ?? env.database;
  const sources = new GardenStatementSessionSources(sql);
  try {
    for (const [si, key, roots] of questionSessions(sources, workspace, question_id, publication, owners)) {
      const sessionId = hostSessionStatementSessionId(key);
      const byText = map.get(`${question_id}-s${si}`);
      if (byText === undefined) report.unmapped_sessions++;
      const located = [], observed = new Map();
      for (const rootId of roots) {
        const read = sources.root(workspace, rootId);
        // Same rule as session closure: an unavailable or role-less root is a raw-only gap.
        if (read.status === "unavailable") { report.raw_gaps.push({ root_id: rootId, reason: read.reason }); continue; }
        try { located.push(...rootStatementMessages(read.root)); }
        catch (error) { report.raw_gaps.push({ root_id: rootId, reason: String(error.message ?? error) }); continue; }
        observed.set(rootId, env.field.stores.getRecord(workspace, rootId).recorded_at);
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
