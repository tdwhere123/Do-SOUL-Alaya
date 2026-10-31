import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const boundary = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { SOURCE_STATEMENTS_CONTRACT, sourceIndexProfileId, sourceIndexNavigationLocation, type SourceIndexTarget } from "@do-soul/alaya-protocol";
import { SOURCE_STATEMENTS_PROMPT } from "@do-soul/alaya-soul";
import { SourceIndexAcquisition, fieldContractSha256, deriveAddressableSpanViews } from "@do-soul/alaya-core";
import { initDatabase, SqliteMemoryEntryRepo, SqliteSignalRepo } from "@do-soul/alaya-storage";
import { startBenchDaemon, type BenchDaemonHandle } from "../../../harness/daemon.js";
import { removeTempDirectory } from "../../support/temp-cleanup.js";
import { prepareRecordedStatementIndex, RECORDED_STATEMENT_CONFIGURATION as configuration } from "../../support/recorded-statement-index.js";
import { createCompileSeedRunner, createCachingSignalExtractor, type BenchSignalExtractor } from "../../../runs/compile-seed.js";
import { buildLongMemEvalSessionMessages, pairSessionIntoRounds } from "../../../datasets/longmemeval/ingestion/dataset.js";
import { sourceStatementRequests } from "../../../runs/extraction/source-statement-request.js";
import { runExtractionPool } from "../../../runs/extraction/fill/fill-pool.js";
import { newFillStats } from "../../../runs/extraction/fill/fill-stats.js";
import { buildRoundExtractionLedger } from "../../../datasets/longmemeval/runner/question/seed-round-extraction-ledger.js";
import { assertStatementRound, type VerifiedStatementSession } from "../../../runs/snapshot/seed-ledger/statement-session-proof.js";
import type { CompleteExtraction } from "../../../runs/snapshot/seed-ledger/seed-ledger-shared.js";
import type { LongMemEvalSnapshotSeedRound } from "../../../runs/snapshot/materialize.js";
import { readSourceObservationProof } from "../../../runs/snapshot/seed-ledger/source-observation-proof.js";
import { inspectCachedExtraction, readCachedEntry, writeCachedExtraction } from "../../../runs/compile-seed/cache/cache-shard.js";
import { computeCacheKey } from "../../../runs/compile-seed/cache/cache-key.js";
import { fixtureAttemptAuthority, providerBackedResponseResult, TEST_EXTRACTION_PROVIDER_URL,
  writeExtractionCacheTestManifest } from "../extraction/extraction-cache-test-fixture.js";

const MODEL = "cache-only-model", REQUEST_PROFILE = "provider-default-v1", CLOCK = "2026-09-14T12:00:00.000Z";
const WORKSPACE = "ws-cache-hit", RUN = "run-cache-hit";
const session = [
  { role: "user", content: "I booked the Berlin museum tour." },
  { role: "assistant", content: "" },
  { role: "user", content: "I cancelled it." },
  { role: "assistant", content: "Understood." }
];
const SOURCE_DATE = "2026/09/14 12:00";
const messages = buildLongMemEvalSessionMessages(session, SOURCE_DATE), rounds = pairSessionIntoRounds(session);
const extractionTurn = { turnContent: rounds.map(round => round.content).join("\n"), turnMessages: messages };
const sourceSessionRounds = rounds.map((round, seedIndex) => ({ seedIndex, turnContent: round.content,
  turnMessages: round.messageIndices.map(position => messages[position]!) }));
const statements = [
  { text: "The user booked the Berlin museum tour.", relation: "tour booking" },
  { text: "The user cancelled the Berlin museum tour.", relation: "tour cancellation" }
];
const rawJson = JSON.stringify({ unused_metadata: "not an admission field", messages: messages.map((message, index) => ({
  message_id: message.message_id, unused_message_field: false,
  statements: index === 0 ? [statements[0], { text: "", relation: "invalid sibling" }]
    : index === 1 ? [{ text: "Unsupported event for an empty message.", relation: "unsupported event" }]
    : index === 2 ? [statements[1]] : []
})) });
const config = { apiKey: null, model: MODEL, modelFamily: MODEL, providerUrl: TEST_EXTRACTION_PROVIDER_URL,
  requestProfile: REQUEST_PROFILE, sourcePacking: "session-statements" } as const;

describe("whole-session cache fill and round-bound publication", () => {
  let cacheRoot: string, dataDirRoot: string, daemon: BenchDaemonHandle;
  beforeEach(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "compile-seed-session-cache-"));
    dataDirRoot = await mkdtemp(join(tmpdir(), "compile-seed-session-daemon-"));
    daemon = await startBenchDaemon({ dataDirRoot, workspaceId: WORKSPACE, runId: RUN, embeddingMode: "disabled",
      reviewerIdentity: "recorded-reviewer", reviewerToken: "fixture-review-token" });
  });
  afterEach(async () => {
    await daemon?.shutdown(); vi.unstubAllEnvs();
    await Promise.all([removeTempDirectory(cacheRoot, []), removeTempDirectory(dataDirRoot)]);
  });
  afterAll(() => { boundary.restore(); expect(boundary.violations).toEqual([]); });

  it("preserves empty host input and valid siblings through session fill, round publication, and lexical/vector keys", async () => {
    writeExtractionCacheTestManifest({ cacheRoot, model: MODEL, systemPrompt: SOURCE_STATEMENTS_PROMPT, requestProfile: REQUEST_PROFILE });
    const requests: string[] = [], logs: string[] = [];
    const authority = fixtureAttemptAuthority({ cacheRoot, model: MODEL, requestProfile: REQUEST_PROFILE });
    const stats = newFillStats();
    const extractor = createCachingSignalExtractor({ cacheRoot, config, ...authority,
      delegate: { extract: input => { requests.push(input.userPrompt); return providerBackedResponseResult(input, rawJson); } } });
    await runExtractionPool({ extractor, turns: [extractionTurn], sourcePacking: "session-statements",
      concurrency: 1, requestedTurns: 1, stats, log: message => logs.push(message) });
    expect(requests).toEqual(sourceStatementRequests(messages).map(request => request.userPrompt));
    expect(JSON.parse(requests[0]!).messages).toHaveLength(4);
    expect(JSON.parse(requests[0]!).messages[0]).toMatchObject({ recorded_at: CLOCK,
      recorded_time: { raw: SOURCE_DATE, level: "session", precision: "minute", timezone: "unspecified" } });
    expect(messages[0]).not.toHaveProperty("created_at");
    expect(JSON.parse(requests[0]!).messages[1]).toMatchObject({ message_id: messages[1]!.message_id, text: "" });
    expect(logs.some(log => log.includes("status=partial"))).toBe(true);
    const delegate = vi.fn<BenchSignalExtractor["extract"]>();
    const runner = createCompileSeedRunner({ cacheRoot, config, requiredTurnContents: [extractionTurn.turnContent],
      requiredExtractionTurns: [extractionTurn], extractorFactory: () => ({ extract: delegate }), diagnosticDir: null });
    const seeded: string[] = [], ledgers: LongMemEvalSnapshotSeedRound[] = [];
    for (const [index, round] of rounds.entries()) {
      const before = runner.stats.parseDropped;
      const result = await runner.seedTurn({ daemon, turnContent: round.content,
        turnMessages: round.messageIndices.map(position => messages[position]!), sourceSession: messages, sourceSessionRounds,
        evidenceRefBase: `q1-s0-r${index}`, seedIndex: index, workspaceId: WORKSPACE, runId: RUN, sourceObservedAt: CLOCK });
      expect(result.seeds).toHaveLength(1);
      const seed = result.seeds[0]!;
      if (seed.memoryId === undefined) throw new Error("expected an observation memory");
      seeded.push(seed.memoryId);
      ledgers.push({ ...buildRoundExtractionLedger(runner.stats), sessionIndex: 0, roundIndex: index,
        sessionId: "recorded-session", hasAnswer: false,
        contentSha256: createHash("sha256").update(round.content.trim()).digest("hex"),
        factsProduced: 1, parseDropped: runner.stats.parseDropped - before, compileOverflowDropped: 0,
        candidateAbsent: 0, materializationDrop: 0, memoryObjectIds: [seed.memoryId] });
    }
    expect(delegate).not.toHaveBeenCalled();
    expect(runner.stats).toMatchObject({ cacheHits: 1, llmCalls: 0, factsProduced: 2, parseDropped: 2 });
    expect(ledgers.map(row => [row.rawSignalCount, row.draftCount, row.statementSession?.firstUse]))
      .toEqual([[3, 1, true], [1, 1, false]]);
    expect(ledgers[0]!.statementSession!.receipt.messages[1]).toMatchObject({ message: { text: "" },
      status: "partial", statements: [], rejections: [{ reason: "empty_source", statement_index: 0 }] });
    const seen = new Map<string, VerifiedStatementSession>();
    const extraction = { extraction_model: MODEL, request_profile: REQUEST_PROFILE } as CompleteExtraction;
    ledgers.forEach((round, index) => assertStatementRound({ round, sessionMessages: messages,
      roundMessages: rounds[index]!.messageIndices.map(position => messages[position]!), extraction, seen }));
    const forged = structuredClone(ledgers[0]!);
    (forged.statementSession!.responses![0] as { rawJson: string }).rawJson = '{"messages":[]}';
    expect(() => assertStatementRound({ round: forged, sessionMessages: messages, roundMessages: messages.slice(0, 2),
      extraction, seen: new Map() })).toThrow("receipt");
    const miscounted = { ...ledgers[0]!, draftCount: ledgers[0]!.draftCount! + 1 };
    expect(() => assertStatementRound({ round: miscounted, sessionMessages: messages,
      roundMessages: messages.slice(0, 2), extraction, seen: new Map() })).toThrow(expect.objectContaining({
        code: "CONFLICT", message: "statement round projection or request accounting differs"
      }));

    const sourceQuestion = { question_id: "q1", question_type: "lookup", question: "not extraction input", answer: "not extraction input",
      question_date: "2099-01-01", haystack_sessions: [session], haystack_dates: [SOURCE_DATE],
      haystack_session_ids: ["recorded-session"], answer_session_ids: [] };
    const snapshotQuestion = { workspaceId: WORKSPACE, runId: RUN, seedRounds: ledgers };
    const dbPath = join(daemon.dataDir, "alaya.db");
    let database = initDatabase({ filename: dbPath });
    try {
      expect(database.connection.prepare("SELECT COUNT(*) AS n FROM source_records").get()).toEqual({ n: 2 });
      const memories = database.connection.prepare("SELECT dimension,confidence,content FROM memory_entries ORDER BY content").all();
      expect(memories).toEqual(statements.map(statement => ({ dimension: "observation", confidence: null, content: statement.text })));
      expect(database.connection.prepare("SELECT interpretation_contract FROM signals").all())
        .toEqual([{ interpretation_contract: SOURCE_STATEMENTS_CONTRACT }, { interpretation_contract: SOURCE_STATEMENTS_CONTRACT }]);
      const evidenceIds = (database.connection.prepare("SELECT object_id FROM evidence_capsules ORDER BY object_id").all() as { object_id: string }[])
        .map(row => row.object_id);
      const proofDatabase = new DatabaseSync(dbPath, { readOnly: true });
      try {
        expect(new Set(evidenceIds.map(id => readSourceObservationProof(proofDatabase, id, snapshotQuestion, sourceQuestion)!.identity.memoryObjectId)))
          .toEqual(new Set(seeded));
      } finally { proofDatabase.close(); }
      const { index, targets } = prepareRecordedStatementIndex(database, WORKSPACE);
      expect(targets.filter(target => target.auxiliary !== undefined)).toHaveLength(2);
      expect(targets.filter(target => target.auxiliary === undefined)).toHaveLength(2);
      const rawRoots = database.connection.prepare("SELECT record_id,source_body FROM source_records ORDER BY source_id").all() as
        { record_id: string; source_body: string }[];
      expect(rawRoots.map(row => row.source_body)).toEqual([
        "User: I booked the Berlin museum tour.\nAssistant: ", "User: I cancelled it.\nAssistant: Understood."
      ]);
      for (const [position, root] of rawRoots.entries()) {
        const key = targets.find(target => target.auxiliary !== undefined && target.target.root_id === root.record_id)!;
        expect(sourceIndexNavigationLocation(key, { start_byte: 0, end_byte: key.body_bytes }))
          .toEqual({ start_byte: 6, end_byte: Buffer.byteLength(`User: ${session[position * 2]!.content}`) });
      }
      expect(database.connection.prepare("SELECT COUNT(*) AS n FROM source_statement_dependencies").get()).toEqual({ n: 4 });
      const budget = { work_units: 1000000, memory_bytes: 16 * 1024 * 1024 };
      expect(index.readLexicalCandidates(WORKSPACE, "tour cancellation", 10, budget).candidates
        .some(candidate => candidate.source.auxiliary !== undefined)).toBe(true);
      const acquisition = new SourceIndexAcquisition(index, fieldContractSha256).nominate({ workspace_id: WORKSPACE,
        navigation_text: "cancellation", vector: { status: "available", profile: configuration.profile,
          profile_id: sourceIndexProfileId(configuration.profile, fieldContractSha256),
          input_digest: `sha256:${fieldContractSha256("cancellation")}`, embedding: new Float32Array([1, 0, 0]) },
        allowance: { max_roots: 10, max_attempts: 20, max_vector_windows: 64 }, budget }, () => "admitted");
      expect(acquisition.nominations).toHaveLength(2);
      expect(acquisition.nominations.every(nomination => nomination.source.target.root_kind === "source_record")).toBe(true);
      expect(new Set(acquisition.nominations.map(nomination => nomination.source.target.root_id)))
        .toEqual(new Set(rawRoots.map(root => root.record_id)));
      database.close(); database = initDatabase({ filename: dbPath });
      expect((await new SqliteMemoryEntryRepo(database).findById(seeded[1]!))?.content).toBe(statements[1]!.text);
      database.connection.prepare("UPDATE evidence_capsules SET gist=json_remove(gist,'$.source_context') WHERE object_id=?").run(evidenceIds[0]);
      const forgedProof = new DatabaseSync(dbPath, { readOnly: true });
      try {
        expect(() => readSourceObservationProof(forgedProof, evidenceIds[0]!, snapshotQuestion, sourceQuestion))
          .toThrow(expect.objectContaining({ code: "CONFLICT", message: "snapshot statement request dependency mismatch" }));
      }
      finally { forgedProof.close(); }
    } finally { if (!database.isClosed()) database.close(); }

    const request = sourceStatementRequests(messages)[0]!;
    const key = computeCacheKey(MODEL, REQUEST_PROFILE, SOURCE_STATEMENTS_PROMPT, request.userPrompt);
    const cached = readCachedEntry(cacheRoot, key, MODEL, REQUEST_PROFILE);
    if (cached.status !== "hit") throw new Error("missing recorded cache fixture");
    const altered = structuredClone(cached.entry);
    (altered.source_statement!.receipt.messages[0]!.statements as unknown as unknown[]).push({ text: "forged", relation: "forged" });
    writeCachedExtraction(cacheRoot, key, altered);
    expect(inspectCachedExtraction(cacheRoot, key, MODEL, REQUEST_PROFILE)).toMatchObject({ status: "invalid" });
  });

  async function seedSession() {
    writeExtractionCacheTestManifest({ cacheRoot, model: MODEL, systemPrompt: SOURCE_STATEMENTS_PROMPT, requestProfile: REQUEST_PROFILE });
    const extractor = createCachingSignalExtractor({ cacheRoot, config,
      ...fixtureAttemptAuthority({ cacheRoot, model: MODEL, requestProfile: REQUEST_PROFILE }),
      delegate: { extract: input => providerBackedResponseResult(input, rawJson) } });
    await runExtractionPool({ extractor, turns: [extractionTurn], sourcePacking: "session-statements",
      concurrency: 1, requestedTurns: 1, stats: newFillStats(), log: () => undefined });
    const runner = createCompileSeedRunner({ cacheRoot, config, requiredExtractionTurns: [extractionTurn],
      requiredTurnContents: [extractionTurn.turnContent], diagnosticDir: null });
    const ids: string[] = [];
    for (const round of sourceSessionRounds) {
      const result = await runner.seedTurn({ ...round, daemon, sourceSession: messages, sourceSessionRounds,
        evidenceRefBase: `recorded-${round.seedIndex}`, workspaceId: WORKSPACE, runId: RUN, sourceObservedAt: CLOCK });
      expect(result.seeds).toHaveLength(1); ids.push(result.seeds[0]!.memoryId!);
    }
    return ids;
  }

  async function httpReader() {
    const server = await daemon.runtime.startHttpServer({ hostname: "127.0.0.1", port: 0, allowEphemeralRequestToken: true });
    server.bindProcessWorkspaceIds([WORKSPACE]);
    expect(server.port).toBeGreaterThan(0);
    return { close: () => server.close(), read: (path: string) => fetch(`http://127.0.0.1:${server.port}${path}`, {
      headers: { "x-request-token": daemon.runtime.requestProtection.requestToken,
        origin: daemon.runtime.requestProtection.allowedOrigin, "x-alaya-desktop": "1" }
    }) };
  }

  async function readWorker(filename: string, rootId: string, memoryIds: readonly string[]) {
    const worker = new Worker(new URL("../../support/source-statement-reader-worker.mjs", import.meta.url), {
      workerData: { filename, workspace: WORKSPACE, query: "tour", rootId, memoryIds, signalRunId: RUN }
    });
    const exited = once(worker, "exit"), [result] = await once(worker, "message");
    expect(await exited).toEqual([0]);
    return result as { targets: SourceIndexTarget[]; signals: unknown[]; statementCandidateStates: string[];
      memories: { object_id: string; status: string; content?: string; code?: string }[] };
  }

  it.each(["source_record", "evidence_capsule"] as const)("preserves dependency ownership when removing a referenced %s is attempted", async kind => {
    const ids = await seedSession();
    const independent = await daemon.proposeMemory(statements[0]!.text, "independent-recorded-memory");
    const filename = join(daemon.dataDir, "alaya.db");
    let database = initDatabase({ filename });
    try {
      const binding = database.connection.prepare("SELECT artifact_id FROM source_statement_memory_bindings WHERE memory_id=?").get(ids[0]) as { artifact_id: string };
      const source = database.connection.prepare("SELECT record_id FROM source_statement_artifacts WHERE artifact_id=?").get(binding.artifact_id) as { record_id: string };
      if (kind === "source_record") database.connection.prepare("DELETE FROM source_records WHERE record_id=?").run(source.record_id);
      else expect(() => database.connection.prepare("DELETE FROM evidence_capsules WHERE object_id=?").run(binding.artifact_id))
        .toThrow("FOREIGN KEY constraint failed");
      expect(database.connection.prepare("SELECT COUNT(*) AS n FROM source_statement_memory_bindings").get()).toEqual({ n: 2 });
      expect(database.connection.prepare("SELECT COUNT(*) AS n FROM source_statement_dependencies").get()).toEqual({ n: 4 });
      const unavailable = kind === "source_record" ? ids : [];
      for (const id of unavailable) await expect(new SqliteMemoryEntryRepo(database).findById(id)).rejects.toThrow("no longer current");
      expect((await new SqliteMemoryEntryRepo(database).findById(independent.memoryId!))?.content).toBe(statements[0]!.text);
      database.close(); database = initDatabase({ filename });
      for (const id of unavailable) await expect(new SqliteMemoryEntryRepo(database).findById(id)).rejects.toThrow("no longer current");
      const worker = await readWorker(filename, source.record_id, ids);
      expect(worker.memories.map(row => row.status)).toEqual(kind === "source_record" ? ["unavailable", "unavailable"] : ["available", "available"]);
      if (kind === "source_record") expect(worker.targets.every(target => target.auxiliary === undefined)).toBe(true);
      expect(database.connection.pragma("foreign_key_check")).toEqual([]);
    } finally { database.close(); }
  });

  it.each([0, 1])("withdraws derived memory and native keys when model-visible raw round %s is replaced", async (changed) => {
    const ids = await seedSession();
    const independent = await daemon.proposeMemory(statements[0]!.text, "independent-recorded-memory");
    const http = await httpReader(), filename = join(daemon.dataDir, "alaya.db");
    let database = initDatabase({ filename });
    try {
      const source = database.connection.prepare("SELECT record_id,source_id,source_version,content_digest,source_body FROM source_records WHERE source_id=?")
        .get(`compile-seed:${WORKSPACE}:${RUN}:${changed}`) as
        { record_id: string; source_id: string; source_version: string; content_digest: string; source_body: string };
      const { index, targets } = prepareRecordedStatementIndex(database, WORKSPACE);
      const oldKeys = targets.filter(target => target.auxiliary !== undefined);
      expect(oldKeys).toHaveLength(2);
      const replacementBody = source.source_body.replace(changed === 0 ? "Berlin" : "cancelled", changed === 0 ? "Paris" : "rescheduled");
      const replaced = await daemon.runtime.services.sourceRecordReplacement.replaceCurrent({ expected_current: {
        workspace_id: WORKSPACE, source_id: source.source_id, identity: source.record_id,
        source_version: source.source_version, content_digest: source.content_digest
      }, replacement: { workspace_id: WORKSPACE, source_id: source.source_id, source_version: "2", content_bytes: replacementBody,
        evidence_object_id: null, recorded_at: "2026-09-15T12:00:00.000Z", event_time: CLOCK,
        valid_from: null, valid_to: null, scope_class: "project", spans: deriveAddressableSpanViews(replacementBody) }
      }, { workspaceId: WORKSPACE });
      expect(["ready", "committed_projection_deferred"]).toContain(replaced.status);
      const memories = new SqliteMemoryEntryRepo(database);
      for (const id of ids) await expect(memories.findById(id)).rejects.toThrow("no longer current");
      expect((await memories.findByWorkspaceIdAll(WORKSPACE)).map(row => row.object_id)).toEqual([independent.memoryId]);
      expect(await memories.countByWorkspaceId(WORKSPACE)).toBe(1);
      for (const key of oldKeys) expect(index.admitQueryCandidate(key, null,
        { work_units: 1000000, memory_bytes: 16 * 1024 * 1024 }).status).toBe("stale");
      const response = await http.read(`/workspaces/${WORKSPACE}/memories`);
      expect(response.status).toBe(200);
      expect((await response.json() as { data: { object_id: string }[] }).data.map(row => row.object_id)).toEqual([independent.memoryId]);
      expect(database.connection.prepare("SELECT lifecycle_state,content FROM memory_entries WHERE object_id IN (?,?) ORDER BY content").all(...ids))
        .toEqual(statements.map(statement => ({ lifecycle_state: "active", content: statement.text })));
      database.close(); database = initDatabase({ filename });
      for (const id of ids) await expect(new SqliteMemoryEntryRepo(database).findById(id)).rejects.toThrow("no longer current");
      const worker = await readWorker(filename, source.record_id, ids);
      expect(worker.memories.map(row => row.status)).toEqual(["unavailable", "unavailable"]);
      // The replaced target root is omitted by nomination; its still-current sibling fails dependency admission.
      expect(worker.statementCandidateStates).toEqual(["stale"]);
      expect(worker.targets.every(target => target.auxiliary === undefined)).toBe(true);
    } finally { database.close(); await http.close(); }
  });

  it.each([0, 1])("scrubs both directions of model-visible signal content after governed erase of raw round %s", async (erased) => {
    const ids = await seedSession(), filename = join(daemon.dataDir, "alaya.db"), http = await httpReader();
    let database = initDatabase({ filename });
    try {
      const original = await new SqliteSignalRepo(database).listByRun(RUN);
      const { record_id: rootId } = database.connection.prepare("SELECT record_id FROM source_records WHERE source_id=?")
        .get(`compile-seed:${WORKSPACE}:${RUN}:${erased}`) as { record_id: string };
      prepareRecordedStatementIndex(database, WORKSPACE);
      const handler = daemon.runtime.services.mcpMemoryToolHandler;
      const context = { workspaceId: WORKSPACE, runId: RUN, sessionId: "recorded-review", agentTarget: "codex" as const };
      const proposal = await handler.call({ toolName: "soul.propose_memory_update", context,
        arguments: { operation: "privacy_erase", target_object_id: rootId, reason: "user_requested_deletion" } });
      expect(proposal, JSON.stringify(proposal)).toMatchObject({ ok: true });
      const proposalId = (proposal as { output: { proposal_id: string } }).output.proposal_id;
      const review = await handler.call({ toolName: "soul.review_memory_proposal", context: { ...context, agentTarget: "inspector" },
        arguments: { proposal_id: proposalId, verdict: "accept", reason: "authorized fixture erasure",
          reviewer_identity: "recorded-reviewer", reviewer_token: "fixture-review-token" } });
      expect(review, JSON.stringify(review)).toMatchObject({ ok: true, output: { resolution_state: "accepted" } });
      const response = await http.read(`/runs/${RUN}/signals`);
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).not.toContain("Berlin"); expect(body).not.toContain("cancelled");
      const retained = (JSON.parse(body) as { data: typeof original }).data;
      expect(retained.map(signal => signal.signal_id)).toEqual(original.map(signal => signal.signal_id));
      for (const signal of retained) expect(signal.raw_payload).toMatchObject({ source_statement_unavailable: {
        reason: "source_erased", erased_dependency_id: rootId } });
      await expect(daemon.runtime.services.signalService.receiveSignal(original[0]!)).rejects.toThrow("replay does not match");
      await expect(daemon.runtime.services.signalService.receiveSignal(retained[0]!)).rejects.toThrow("read-only");
      await expect(new SqliteSignalRepo(database).create({ ...original[0]!, signal_id: "erased-reinsertion" })).rejects.toThrow();
      expect(() => new SqliteSignalRepo(database).compareAndSwapState({ signalId: retained[0]!.signal_id,
        workspaceId: WORKSPACE, expectedState: retained[0]!.signal_state, nextState: retained[0]!.signal_state,
        rawPayload: original[0]!.raw_payload })).toThrow();
      expect(database.connection.prepare("SELECT COUNT(*) AS n FROM source_statement_artifacts").get()).toEqual({ n: 0 });
      database.close(); database = initDatabase({ filename });
      expect(await new SqliteSignalRepo(database).listByRun(RUN)).toEqual(retained);
      const worker = await readWorker(filename, rootId, ids);
      expect(JSON.stringify(worker.signals)).not.toContain("Berlin");
      expect(worker.memories.map(row => row.content)).toEqual(["erased", "erased"]);
      expect(worker.targets.every(target => target.auxiliary === undefined)).toBe(true);
    } finally { database.close(); await http.close(); }
  });

  it("retains raw source without fabricating fallback memory or a duplicate capsule when extraction is unavailable", async () => {
    const runner = createCompileSeedRunner({ cacheRoot, config, skipPreflight: true, diagnosticDir: null });
    const result = await runner.seedTurn({ daemon, turnContent: rounds[0]!.content, turnMessages: messages.slice(0, 2),
      sourceSession: messages, sourceSessionRounds, evidenceRefBase: "q1-s0-r0", seedIndex: 0, workspaceId: WORKSPACE, runId: RUN });
    expect(result.seeds).toEqual([]);
    const database = initDatabase({ filename: join(daemon.dataDir, "alaya.db") });
    try {
      expect(database.connection.prepare("SELECT COUNT(*) AS n FROM source_records").get()).toEqual({ n: 2 });
      expect(database.connection.prepare("SELECT COUNT(*) AS n FROM memory_entries").get()).toEqual({ n: 0 });
      expect(database.connection.prepare("SELECT COUNT(*) AS n FROM evidence_capsules").get()).toEqual({ n: 0 });
    } finally { database.close(); }
  });
});
