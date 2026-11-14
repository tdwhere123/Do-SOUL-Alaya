import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const boundary = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../../scripts/test-support/provider-free/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationMessage, SourceStatementRequest } from "@do-soul/alaya-protocol";
import { OFFICIAL_API_SYSTEM_PROMPT, SOURCE_STATEMENTS_PROMPT, OfficialApiGardenProvider,
  resolveOfficialApiSystemPrompt } from "@do-soul/alaya-soul";
import { createCachingSignalExtractor, createCompileSeedRunner, type BenchSignalExtractor,
  type CompileSeedExtractionConfig } from "../../../runs/compile-seed.js";
import { computeExtractionTurnCacheKeys, computeSourceTurnCacheKey, computeSourceTurnCacheKeys }
  from "../../../runs/compile-seed/compile-seed-cache.js";
import { cacheFilePath, inspectCachedExtraction, inspectCachedExtractionContent, writeCachedExtraction }
  from "../../../runs/compile-seed/cache/cache-shard.js";
import { sourceStatementRequests, sourceStatementSession } from "../../../runs/extraction/source-statement-request.js";
import { readExtractionCacheManifest, writeExtractionCacheManifest }
  from "../../../runs/extraction/cache/extraction-cache-manifest.js";
import { buildCompileSeedDaemon, makeSeed } from "./compile-seed-fixture.js";
import { TEST_EXTRACTION_PROVIDER_URL, writeExtractionCacheTestManifest,
  providerBackedResponseResult, fixtureAttemptAuthority } from "../extraction/extraction-cache-test-fixture.js";

const CONFIG: CompileSeedExtractionConfig = { model: "test-model", modelFamily: "test-model",
  providerUrl: TEST_EXTRACTION_PROVIDER_URL, requestProfile: "provider-default-v1", apiKey: "test-key",
  sourcePacking: "session-statements" };
const messages = (count = 2): ConversationMessage[] => Array.from({ length: count }, (_, index) => ({
  message_id: `m${index}`, role: index % 2 === 0 ? "user" : "assistant", content: `Recorded event ${index}.`
}));
const response = (prompt: string) => JSON.stringify({ messages: (JSON.parse(prompt) as SourceStatementRequest)
  .messages.map(message => ({ message_id: message.message_id,
    statements: [{ text: message.text, relation: "recorded event" }] })) });
let cacheRoot: string;
beforeEach(() => { cacheRoot = mkdtempSync(join(tmpdir(), "statement-cache-identity-")); });
afterEach(() => { rmSync(cacheRoot, { recursive: true, force: true }); });
afterAll(() => { boundary.restore(); expect(boundary.violations).toEqual([]); });

function currentManifest(count: number) {
  writeExtractionCacheTestManifest({ cacheRoot, model: CONFIG.model, systemPrompt: SOURCE_STATEMENTS_PROMPT });
  writeExtractionCacheManifest(cacheRoot, { ...readExtractionCacheManifest(cacheRoot)!,
    requested_turns: count, cached_turns: count, coverage: 1 });
}

function currentExtractor(raw: (prompt: string) => string = response, count = 1) {
  currentManifest(count);
  const delegate: BenchSignalExtractor = { extract: vi.fn(input => providerBackedResponseResult(input, raw(input.userPrompt))) };
  const extractor = createCachingSignalExtractor({ config: CONFIG, cacheRoot, delegate,
    ...fixtureAttemptAuthority({ cacheRoot, model: CONFIG.model, requestProfile: CONFIG.requestProfile, startingMissing: count }) });
  return { delegate, extractor };
}

function context(host: readonly ConversationMessage[]) {
  return { workspace_id: "workspace-1", run_id: sourceStatementSession(host).sessionId,
    surface_id: null, turn_messages: host };
}

describe("canonical session request cache identity", () => {
  it("keeps retained historical prompts and assertion-batch identities inspectable", () => {
    const retained = resolveOfficialApiSystemPrompt("bf255feebdf99106871e33241f7bba3260e3f02874f0eefe36db803cc95d7705");
    expect(retained).toBeDefined();
    const input = { turnContent: "I prefer jasmine tea." };
    expect(computeSourceTurnCacheKeys(CONFIG.model, CONFIG.requestProfile, retained!, input))
      .not.toEqual(computeSourceTurnCacheKeys(CONFIG.model, CONFIG.requestProfile, OFFICIAL_API_SYSTEM_PROMPT, input));
    const source = Array.from({ length: 9 }, (_, index) => `I recorded durable detail number ${index}.`).join(" ");
    expect(computeSourceTurnCacheKeys(CONFIG.model, CONFIG.requestProfile, OFFICIAL_API_SYSTEM_PROMPT,
      { turnContent: source })).toHaveLength(2);
  });

  it("shares complete target/context request keys between planning and actual extraction", async () => {
    const host = messages(65), requests = sourceStatementRequests(host);
    expect(requests.map(row => row.source.messages.length)).toEqual([64, 1]);
    expect(requests[1]!.source.context.map(row => row.message_id)).toEqual(host.slice(0, 64).map(row => row.message_id));
    const { delegate, extractor } = currentExtractor(response, 2);
    const provider = new OfficialApiGardenProvider({ apiKey: "test-key", extractor });
    const receipt = await provider.extractSourceStatements("unused fallback", context(host));
    expect(receipt.status).toBe("complete");
    expect(receipt.messages).toHaveLength(65);
    expect(delegate.extract).toHaveBeenCalledTimes(2);
    const keys = computeExtractionTurnCacheKeys(CONFIG.model, CONFIG.requestProfile, SOURCE_STATEMENTS_PROMPT,
      { turnContent: "unused fallback", turnMessages: host });
    expect(keys).toHaveLength(2);
    for (const key of keys) expect(inspectCachedExtraction(cacheRoot, key, CONFIG.model, CONFIG.requestProfile).status).toBe("hit");
    expect(vi.mocked(delegate.extract).mock.calls.map(([input]) => input.userPrompt))
      .toEqual(requests.map(row => row.userPrompt));
  });

  it("reuses session cache across publication runs without redispatch or session-sized replacement of the raw round", async () => {
    const host = messages(), { delegate, extractor } = currentExtractor();
    await new OfficialApiGardenProvider({ apiKey: "test-key", extractor }).extractSourceStatements("", context(host));
    const received: string[] = [];
    const daemon = buildCompileSeedDaemon(input => { received.push(input.distilledFact); return makeSeed(`memory-${received.length}`); });
    for (const runId of ["run-first", "run-replay"]) {
      const runner = createCompileSeedRunner({ config: CONFIG, cacheRoot });
      await runner.seedTurn({ daemon, workspaceId: "workspace-1", runId, seedIndex: 0,
        evidenceRefBase: runId, turnContent: "raw round", turnMessages: host });
      expect(runner.stats).toMatchObject({ cacheHits: 1, llmCalls: 0, factsProduced: 2 });
      expect(runner.stats.lastExtractionShards).toHaveLength(1);
    }
    expect(received).toEqual([...host, ...host].map(message => message.content));
    expect(delegate.extract).toHaveBeenCalledOnce();
  });

  it("changes request identity for role, body, order and recorded time while excluding caller fallback copy", () => {
    const host = messages();
    const keys = (rows: readonly ConversationMessage[], fallback = "fallback") => computeExtractionTurnCacheKeys(
      CONFIG.model, CONFIG.requestProfile, SOURCE_STATEMENTS_PROMPT, { turnContent: fallback, turnMessages: rows });
    const original = keys(host);
    expect(keys(host, "another run summary")).toEqual(original);
    for (const changed of [[...host].reverse(), [{ ...host[0]!, role: "assistant" as const }, host[1]!],
      [{ ...host[0]!, content: "Changed event." }, host[1]!],
      [{ ...host[0]!, created_at: "2026-01-01T00:00:00.000Z" }, host[1]!]]) {
      expect(keys(changed)).not.toEqual(original);
    }
  });

  it("does not classify malformed cached transport output as a successful empty extraction", async () => {
    const host = messages(), { delegate, extractor } = currentExtractor(() => '{"messages":[');
    const provider = new OfficialApiGardenProvider({ apiKey: "test-key", extractor });
    await expect(provider.extractSourceStatements("", context(host))).rejects.toBeDefined();
    expect(delegate.extract).toHaveBeenCalledOnce();
    const [key] = computeExtractionTurnCacheKeys(CONFIG.model, CONFIG.requestProfile, SOURCE_STATEMENTS_PROMPT,
      { turnContent: "", turnMessages: host });
    expect(inspectCachedExtraction(cacheRoot, key!, CONFIG.model, CONFIG.requestProfile).status).not.toBe("hit");
  });

  it("retains historical nonempty bytes without treating them as a current session response", async () => {
    writeExtractionCacheTestManifest({ cacheRoot, model: CONFIG.model, systemPrompt: OFFICIAL_API_SYSTEM_PROMPT });
    const host = messages(1), raw = '{"interpretations":[{"assertion_id":1,"relations":[{"predicate":{"text":"recorded"},"arguments":[],"qualifiers":[]}]}]}';
    const key = computeSourceTurnCacheKey(CONFIG.model, CONFIG.requestProfile, OFFICIAL_API_SYSTEM_PROMPT,
      { turnContent: host[0]!.content, turnMessages: host });
    writeCachedExtraction(cacheRoot, key, { model: CONFIG.model, request_profile: CONFIG.requestProfile,
      cache_key: key, raw_json: raw, extracted_at: "2026-07-22T00:00:00.000Z" });
    const before = readFileSync(cacheFilePath(cacheRoot, key));
    expect(inspectCachedExtractionContent({ raw_json: raw }).status).toBe("hit");
    expect(inspectCachedExtraction(cacheRoot, key, CONFIG.model, CONFIG.requestProfile))
      .toMatchObject({ status: "retired", eligibility: "retained_only" });
    const delegate = { extract: vi.fn(async () => { throw new Error("retired output must not dispatch"); }) };
    const provider = new OfficialApiGardenProvider({ apiKey: "test-key", extractor: createCachingSignalExtractor({
      cacheRoot, config: CONFIG, delegate, allowLiveExtraction: false }) });
    await expect(provider.extractSourceStatements("", context(host))).rejects.toBeDefined();
    expect(delegate.extract).not.toHaveBeenCalled();
    expect(readFileSync(cacheFilePath(cacheRoot, key))).toEqual(before);
  });

  it("refuses string-only extraction without inventing host message identities", async () => {
    const extract = vi.fn(async () => ({ rawJson: '{"messages":[]}' }));
    const provider = new OfficialApiGardenProvider({ apiKey: "test-key", extractor: { extract } });
    await expect(provider.extractSourceStatements("Unbound body", { workspace_id: "workspace-1",
      run_id: "run", surface_id: null, turn_messages: [] })).rejects.toThrow("host message identities");
    expect(extract).not.toHaveBeenCalled();
  });
});
