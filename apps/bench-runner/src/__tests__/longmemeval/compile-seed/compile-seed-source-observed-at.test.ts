import { afterAll, expect, it, vi } from "vitest";
const boundary = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary({ ownedTemporaryFixtures: true });
});
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase, SqliteSignalRepo } from "@do-soul/alaya-storage";
import type { SourceStatementRequest } from "@do-soul/alaya-protocol";
import { SOURCE_STATEMENTS_PROMPT } from "@do-soul/alaya-soul";
import { startBenchDaemon } from "../../../harness/daemon.js";
import { createCompileSeedRunner } from "../../../runs/compile-seed.js";
import { admitStatementSessionCache, CREDENTIALLED_CONFIG } from "./compile-seed-fixture.js";
import { writeExtractionCacheTestManifest } from "../extraction/extraction-cache-test-fixture.js";

afterAll(() => { boundary.restore(); expect(boundary.violations).toEqual([]); });

it("retains exact or unknown message clocks without inventing an inclusive event interval from relative statement text", async () => {
  const root = await mkdtemp(join(tmpdir(), "statement-recorded-time-"));
  let daemon: Awaited<ReturnType<typeof startBenchDaemon>> | undefined;
  let database: ReturnType<typeof initDatabase> | undefined;
  try {
    const cacheRoot = join(root, "cache"), config = { ...CREDENTIALLED_CONFIG, sourcePacking: "session-statements" as const };
    writeExtractionCacheTestManifest({ cacheRoot, model: config.model,
      providerUrl: config.providerUrl, systemPrompt: SOURCE_STATEMENTS_PROMPT });
    const source = "I completed the review today.";
    const times = ["2024-06-15T14:30:00.000Z", "2024-06-16T14:30:00.000Z", null];
    const messages = times.map((createdAt, index) => ({ message_id: `recorded-user-${index}`,
      role: "user" as const, content: source, ...(createdAt === null ? {} : { created_at: createdAt }) }));
    const rawJson = vi.fn((request: SourceStatementRequest) => {
      expect(request.messages.map((message: { recorded_at: string | null }) => message.recorded_at)).toEqual(times);
      return JSON.stringify({ messages: request.messages.map((message: { message_id: string }) => ({
        message_id: message.message_id, statements: [{ text: source, relation: "recorded event" }] })) });
    });
    await admitStatementSessionCache({ cacheRoot, config, messages, rawJson });
    const delegate = vi.fn(async () => { throw new Error("admitted session must not redispatch"); });
    const runner = createCompileSeedRunner({ config, cacheRoot, extractorFactory: () => ({ extract: delegate }) });
    daemon = await startBenchDaemon({ dataDirRoot: join(root, "consumer"), workspaceId: "recorded-source", runId: "recorded-source-run" });
    const rounds = messages.map((message, seedIndex) => ({ seedIndex, turnContent: source, turnMessages: [message] }));
    const seeds = [];
    for (const round of rounds) {
      const result = await runner.seedTurn({ daemon, ...round, sourceSession: messages, sourceSessionRounds: rounds,
        evidenceRefBase: `raw-round-${round.seedIndex}`, workspaceId: daemon.workspaceId, runId: daemon.runId });
      expect(result.seeds).toHaveLength(1);
      seeds.push(result.seeds[0]!);
    }
    expect(rawJson).toHaveBeenCalledOnce(); expect(delegate).not.toHaveBeenCalled();
    expect(runner.stats).toMatchObject({ cacheHits: 1, llmCalls: 0, factsProduced: 3 });
    database = initDatabase({ filename: join(daemon.dataDir, "alaya.db") });
    const signals = new SqliteSignalRepo(database);
    for (const [index, seed] of seeds.entries()) {
      expect(seed.kind).toBe("memory_entry");
      expect(await signals.getById(seed.signalId)).toMatchObject({ raw_payload: { source_statement: {
        message: { recorded_at: times[index], text: source }, statement: { text: source, relation: "recorded event" } } } });
      expect(database.connection.prepare("SELECT content, event_time_start, event_time_end, time_precision, time_source FROM memory_entries WHERE object_id = ?")
        .get(seed.memoryId)).toEqual({ content: source, event_time_start: null, event_time_end: null,
          time_precision: null, time_source: null });
    }
    expect(database.connection.prepare("SELECT count(*) AS count FROM source_records").get()).toEqual({ count: 3 });
  } finally {
    try { await daemon?.shutdown(); }
    finally { database?.close(); await rm(root, { recursive: true, force: true }); }
  }
}, 60_000);
