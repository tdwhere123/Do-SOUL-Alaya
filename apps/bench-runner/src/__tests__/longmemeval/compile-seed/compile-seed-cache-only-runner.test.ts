import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const boundary = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SOURCE_STATEMENTS_PROMPT } from "@do-soul/alaya-soul";
import { createCompileSeedRunner } from "../../../runs/compile-seed.js";
import { cacheFilePath, writeCachedExtraction } from "../../../runs/compile-seed/cache/cache-shard.js";
import { computeExtractionTurnCacheKeys } from "../../../runs/compile-seed/cache/cache-key.js";
import { admitStatementSessionCache, buildCompileSeedDaemon, CREDENTIALLED_CONFIG, OFFLINE_CONFIG, makeSeed } from "./compile-seed-fixture.js";
import { writeExtractionCacheTestManifest } from "../extraction/extraction-cache-test-fixture.js";

const config = { ...CREDENTIALLED_CONFIG, sourcePacking: "session-statements" as const };
const messages = [{ message_id: "recorded-user", role: "user" as const, content: "Alice moved to Berlin." }];
const turn = { turnContent: messages[0]!.content, turnMessages: messages, evidenceRefBase: "raw-turn", seedIndex: 0,
  workspaceId: "workspace-1", runId: "run-1" };
let cacheRoot: string;
beforeEach(async () => {
  cacheRoot = await mkdtemp(join(tmpdir(), "statement-cache-only-"));
  vi.stubEnv("ALAYA_OFFICIAL_GARDEN_SECRET_REF", ""); vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", "");
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(cacheRoot, { recursive: true, force: true }); });
afterAll(() => { boundary.restore(); expect(boundary.violations).toEqual([]); });
function manifest() {
  writeExtractionCacheTestManifest({ cacheRoot, model: config.model, providerUrl: config.providerUrl, systemPrompt: SOURCE_STATEMENTS_PROMPT });
}
async function admit() {
  manifest();
  await admitStatementSessionCache({ cacheRoot, config, messages, rawJson: () => JSON.stringify({ messages: [{
    message_id: "recorded-user", statements: [{ text: "Alice moved to Berlin.", relation: "recorded event" }] }] }) });
}
function shard(rawJson: string) {
  const key = computeExtractionTurnCacheKeys(config.model, config.requestProfile, SOURCE_STATEMENTS_PROMPT, turn, config.sourcePacking)[0]!;
  writeCachedExtraction(cacheRoot, key, { model: config.model, request_profile: config.requestProfile,
    cache_key: key, raw_json: rawJson, extracted_at: "2026-07-16T00:00:00.000Z" });
  return cacheFilePath(cacheRoot, key);
}

describe("credentialless session cache consumption", () => {
  it("uses an admitted provider cache without loading an API secret", async () => {
    await admit();
    const delegate = vi.fn(async () => { throw new Error("cache must not dispatch"); });
    const runner = createCompileSeedRunner({ cacheRoot, requiredExtractionTurns: [turn],
      extractorFactory: () => ({ extract: delegate }), diagnosticDir: null });
    const daemon = buildCompileSeedDaemon(() => makeSeed("cached-memory"));
    expect((await runner.seedTurn({ ...turn, daemon })).seeds).toHaveLength(1);
    expect(delegate).not.toHaveBeenCalled();
    expect(runner.stats).toMatchObject({ path: "official_api_compile", cacheHits: 1, llmCalls: 0, offlineFallbacks: 0 });
  });

  it("retains historical bytes but refuses to admit them at a current request key", async () => {
    manifest();
    const path = shard('{"interpretations":[{"assertion_id":1,"relations":[{"predicate":{"text":"moved"},"arguments":[],"qualifiers":[]}]}]}');
    const before = readFileSync(path), delegate = vi.fn(async () => { throw new Error("retired cache must not dispatch"); });
    const runner = createCompileSeedRunner({ cacheRoot, config: { ...config, apiKey: null }, skipPreflight: true,
      extractorFactory: () => ({ extract: delegate }), diagnosticDir: null });
    const publish = vi.fn(() => makeSeed("unexpected"));
    await expect(runner.seedTurn({ ...turn, daemon: buildCompileSeedDaemon(publish) })).rejects.toThrow(/retained-only/u);
    expect(publish).not.toHaveBeenCalled(); expect(delegate).not.toHaveBeenCalled(); expect(readFileSync(path)).toEqual(before);
  });

  it.each(["missing", "invalid"])("retains a failed receipt for a %s shard without dispatch or synthetic publication", async status => {
    manifest(); if (status === "invalid") shard("{not-json");
    const delegate = vi.fn(async () => { throw new Error("unavailable cache must not dispatch"); });
    const publish = vi.fn(() => makeSeed("unexpected"));
    const runner = createCompileSeedRunner({ cacheRoot, config: { ...config, apiKey: null }, skipPreflight: true,
      extractorFactory: () => ({ extract: delegate }), diagnosticDir: null });
    expect((await runner.seedTurn({ ...turn, daemon: buildCompileSeedDaemon(publish) })).seeds).toEqual([]);
    expect(delegate).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled();
    expect(runner.stats).toMatchObject({ cacheHits: 0, llmCalls: 0, offlineFallbacks: 0,
      lastStatementSession: { receipt: { status: "failed", messages: [{ status: "failed" }] } } });
  });

  it("does not attribute a subsequent miss to the preceding cache hit", async () => {
    await admit();
    const delegate = vi.fn(async () => { throw new Error("cache-only runner must not dispatch"); });
    const runner = createCompileSeedRunner({ cacheRoot, config: { ...config, apiKey: null },
      extractorFactory: () => ({ extract: delegate }), diagnosticDir: null });
    const daemon = buildCompileSeedDaemon(() => makeSeed("cached-memory"));
    expect((await runner.seedTurn({ ...turn, daemon })).seeds).toHaveLength(1);
    expect((await runner.seedTurn({ ...turn, daemon, seedIndex: 1, evidenceRefBase: "missing-round",
      turnContent: "Different source.", turnMessages: [{ message_id: "other-user", role: "user", content: "Different source." }] })).seeds).toEqual([]);
    expect(delegate).not.toHaveBeenCalled();
    expect(runner.stats).toMatchObject({ cacheHits: 1, cachedExtractionFailures: 0, liveExtractionFailures: 0,
      lastExtractionSource: null, lastStatementSession: { receipt: { status: "failed" } } });
  });

  it("retains a manifest-less no-credentials source without constructing a provider or inventing a fallback memory", async () => {
    vi.stubEnv("ALAYA_BENCH_REQUIRE_EXTRACTION_CACHE_MANIFEST", "0");
    const extractorFactory = vi.fn(), publish = vi.fn(() => makeSeed("unexpected"));
    const runner = createCompileSeedRunner({ config: OFFLINE_CONFIG, cacheRoot, extractorFactory, diagnosticDir: null });
    const daemon = buildCompileSeedDaemon(publish), imported = vi.spyOn(daemon, "importSourceRecord");
    expect((await runner.seedTurn({ ...turn, daemon })).seeds).toEqual([]);
    expect(imported).toHaveBeenCalledOnce(); expect(publish).not.toHaveBeenCalled(); expect(extractorFactory).not.toHaveBeenCalled();
    expect(runner.stats).toMatchObject({ path: "no_credentials_fallback", cacheHits: 0, llmCalls: 0, offlineFallbacks: 1 });
  });

  it.each(["explicit", "environment"])("refuses a missing %s cache before provider construction despite inspection opt-out", source => {
    vi.stubEnv("ALAYA_BENCH_REQUIRE_EXTRACTION_CACHE_MANIFEST", "0");
    const missing = join(cacheRoot, "missing"), extractorFactory = vi.fn();
    vi.stubEnv("ALAYA_BENCH_EXTRACTION_CACHE_ROOT", source === "environment" ? missing : cacheRoot);
    expect(() => createCompileSeedRunner({ config: OFFLINE_CONFIG, ...(source === "explicit" ? { cacheRoot: missing } : {}),
      extractorFactory, diagnosticDir: null })).toThrow(`selected extraction cache root does not exist: ${missing}`);
    expect(extractorFactory).not.toHaveBeenCalled();
  });
});
