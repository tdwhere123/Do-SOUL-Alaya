import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const boundary = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SOURCE_STATEMENTS_PROMPT } from "@do-soul/alaya-soul";
import { computeCacheKey } from "../../../runs/compile-seed/compile-seed-cache.js";
import { createCachingSignalExtractor, createCompileSeedRunner, toSeedExtractionPathKpi } from "../../../runs/compile-seed.js";
import { sourceStatementRequests, sourceStatementSession } from "../../../runs/extraction/source-statement-request.js";
import type { BenchSignalSeedInput } from "../../../harness/daemon.js";
import { createUnscoredMaterializedSeedError } from "../../../harness/seeding/seed-errors.js";
import { admitStatementSessionCache, buildCompileSeedDaemon, CREDENTIALLED_CONFIG, makeSeed } from "./compile-seed-fixture.js";
import { writeExtractionCacheTestManifest } from "../extraction/extraction-cache-test-fixture.js";
import { cacheFilePath } from "../../../runs/compile-seed/cache/cache-shard.js";

const config = { ...CREDENTIALLED_CONFIG, sourcePacking: "session-statements" as const };
const messages = [{ message_id: "recorded-user", role: "user" as const, content: "Intro span. Middle span. Closing span." }];
const turn = { turnContent: messages[0]!.content, turnMessages: messages, evidenceRefBase: "raw-turn", seedIndex: 0,
  workspaceId: "workspace-1", runId: "run-1" };
const statement = (text: string) => ({ text, relation: "recorded statement" });
let cacheRoot: string;
beforeEach(async () => {
  cacheRoot = await mkdtemp(join(tmpdir(), "statement-drops-"));
  writeExtractionCacheTestManifest({ cacheRoot, model: config.model, providerUrl: config.providerUrl, systemPrompt: SOURCE_STATEMENTS_PROMPT });
});
afterEach(async () => { await rm(cacheRoot, { recursive: true, force: true }); });
afterAll(() => { boundary.restore(); expect(boundary.violations).toEqual([]); });
async function admit(statements: readonly unknown[]) {
  const rawJson = JSON.stringify({ messages: [{ message_id: messages[0]!.message_id, statements }] });
  await admitStatementSessionCache({ cacheRoot, config, messages, rawJson: () => rawJson });
  return rawJson;
}

describe("statement drop accounting", () => {
  it("preserves healthy siblings and reports rejected statements without fabricating fallback", async () => {
    await admit([statement("Intro span."), { text: null, relation: "invalid" }]);
    const publish = vi.fn((_input: BenchSignalSeedInput) => makeSeed("healthy")), daemon = buildCompileSeedDaemon(publish);
    const runner = createCompileSeedRunner({ config, cacheRoot });
    const result = await runner.seedTurn({ ...turn, daemon });
    expect(result.seeds).toHaveLength(1); expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0]![0]).toMatchObject({ distilledFact: "Intro span.", productionSignal: {
      interpretation_contract: "source-statements-v1" } });
    expect(runner.stats).toMatchObject({ factsProduced: 1, parseDropped: 1, signalsDropped: 1, compileOverflowDropped: 0 });
  });

  it("keeps independently reason-coded publication drops and healthy batch siblings in its KPI", async () => {
    await admit([statement("Intro span."), statement("Middle span."), statement("Closing span.")]);
    const daemon = buildCompileSeedDaemon(() => makeSeed("unused"));
    const publish = vi.spyOn(daemon, "proposeMemoriesFromCompileSignals").mockResolvedValue({ createdEvidence: true,
      seeds: [makeSeed("healthy")], dropped: [{ reason: "candidate_absent", detail: "no memory result" },
        { reason: "materialization_drop", detail: "publication unavailable" }] });
    const runner = createCompileSeedRunner({ config, cacheRoot });
    expect((await runner.seedTurn({ ...turn, daemon })).seeds).toHaveLength(1);
    expect(publish.mock.calls[0]![0]).toHaveLength(3);
    expect(runner.stats).toMatchObject({ parseDropped: 0, compileOverflowDropped: 0, signalsDropped: 2,
      signalsDroppedByReason: { candidate_absent: 1, materialization_drop: 1 } });
    expect(toSeedExtractionPathKpi(runner.stats)).toMatchObject({ signals_dropped: 2,
      signals_dropped_by_reason: { candidate_absent: 1, materialization_drop: 1 } });
  });

  it("propagates a materialized but unscored memory rather than disguising it as a dropped candidate", async () => {
    await admit([statement("Intro span.")]);
    const daemon = buildCompileSeedDaemon(() => makeSeed("unused"));
    vi.spyOn(daemon, "proposeMemoriesFromCompileSignals").mockRejectedValue(createUnscoredMaterializedSeedError({
      memoryId: "already-created", evidenceRef: turn.evidenceRefBase, cause: new Error("review tail failed") }));
    const runner = createCompileSeedRunner({ config, cacheRoot });
    await expect(runner.seedTurn({ ...turn, daemon })).rejects.toThrow(/recallable unscored seed memory/u);
    expect(runner.stats).toMatchObject({ signalsDropped: 0, signalsDroppedByReason: { candidate_absent: 0, materialization_drop: 0 } });
  });

  it("reuses the captured session after a pre-memory publication failure without another extraction or raw admission", async () => {
    await admit([statement("Intro span.")]);
    const daemon = buildCompileSeedDaemon(() => makeSeed("healthy"));
    const imported = vi.spyOn(daemon, "importSourceRecord");
    const publish = vi.spyOn(daemon, "proposeMemoriesFromCompileSignals");
    publish.mockRejectedValueOnce(new Error("publication unavailable before memory creation"));
    const runner = createCompileSeedRunner({ config, cacheRoot });
    expect((await runner.seedTurn({ ...turn, daemon })).seeds).toEqual([]);
    expect(runner.stats).toMatchObject({ signalsDropped: 1, signalsDroppedByReason: { candidate_absent: 0, materialization_drop: 1 } });
    expect((await runner.seedTurn({ ...turn, daemon })).seeds).toHaveLength(1);
    expect(imported).toHaveBeenCalledOnce(); expect(publish).toHaveBeenCalledTimes(2);
    expect(runner.stats).toMatchObject({ cacheHits: 1, llmCalls: 0, lastStatementSession: { firstUse: false } });
  });
});

it("writes a complete statement shard and reuses those exact bytes without a second provider call", async () => {
  const rawJson = await admit(Array.from({ length: 32 }, (_, index) => statement(`Recorded statement ${index}.`)));
  const [request] = sourceStatementRequests(messages);
  const key = computeCacheKey(config.model, config.requestProfile, SOURCE_STATEMENTS_PROMPT, request!.userPrompt);
  const path = cacheFilePath(cacheRoot, key);
  const shard = JSON.parse(readFileSync(path, "utf8"));
  expect(shard.raw_json).toBe(rawJson); expect(shard.response_metadata.finish_reason).toBe("stop");
  expect(readdirSync(dirname(path)).filter(name => name.endsWith(".tmp"))).toEqual([]);
  const delegate = { extract: vi.fn(async () => { throw new Error("cached shard must not dispatch"); }) };
  const reread = createCachingSignalExtractor({ cacheRoot, config, delegate });
  expect(await reread.extract({ systemPrompt: SOURCE_STATEMENTS_PROMPT, userPrompt: request!.userPrompt,
    sourceCorpus: sourceStatementSession(messages).rendered.content })).toMatchObject({ rawJson });
  expect(delegate.extract).not.toHaveBeenCalled();
});
