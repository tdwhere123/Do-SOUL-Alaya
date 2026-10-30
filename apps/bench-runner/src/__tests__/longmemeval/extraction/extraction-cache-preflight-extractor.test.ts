import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SOURCE_STATEMENTS_PROMPT } from "@do-soul/alaya-soul";
import {
  createCachingSignalExtractor, createCompileSeedRunner, type BenchSignalExtractor
} from "../../../runs/compile-seed.js";
import { cacheFilePath, computeCacheKey } from "../../../runs/compile-seed/compile-seed-cache.js";
import { sourceStatementRequests } from "../../../runs/extraction/source-statement-request.js";
import { admitStatementSessionCache, buildCompileSeedDaemon, makeSeed } from "../compile-seed/compile-seed-fixture.js";
import {
  providerBackedResponseResult, fixtureAttemptAuthority, TEST_EXTRACTION_PROVIDER_URL,
  writeExtractionCacheTestManifest
} from "./extraction-cache-test-fixture.js";
import { EXTRACTION_CONFIG, registerCacheRootHooks } from "./extraction-cache-preflight-fixture.js";

const config = { ...EXTRACTION_CONFIG, providerUrl: TEST_EXTRACTION_PROVIDER_URL,
  sourcePacking: "session-statements" as const };
const messages = [{ message_id: "recorded-user", role: "user" as const, content: "I moved to Berlin." }];
const request = sourceStatementRequests(messages)[0]!;
const input = { systemPrompt: SOURCE_STATEMENTS_PROMPT, sourceCorpus: messages[0]!.content,
  userPrompt: request.userPrompt };
const response = JSON.stringify({ messages: [{ message_id: "recorded-user",
  statements: [{ text: "I moved to Berlin.", relation: "recorded event" }] }] });

let cacheRoot: string;
registerCacheRootHooks("extraction-cache-preflight-", root => { cacheRoot = root; }, root => {
  writeExtractionCacheTestManifest({ cacheRoot: root, model: config.model,
    requestProfile: config.requestProfile, providerUrl: config.providerUrl,
    systemPrompt: SOURCE_STATEMENTS_PROMPT });
});

function delegate() {
  return { extract: vi.fn<BenchSignalExtractor["extract"]>(attempt => providerBackedResponseResult(attempt, response)) };
}
function authority() {
  return fixtureAttemptAuthority({ cacheRoot, model: config.model, requestProfile: config.requestProfile });
}

describe("request-bound cache preflight", () => {
  it("reports a cache hit without calling the live extractor", async () => {
    await admitStatementSessionCache({ cacheRoot, config, messages, rawJson: () => response });
    const live = { extract: vi.fn<BenchSignalExtractor["extract"]>(async () => {
      throw new Error("cache-only smoke must not dispatch");
    }) };
    const turn = { turnContent: messages[0]!.content, turnMessages: messages };
    const runner = createCompileSeedRunner({ config, cacheRoot, requiredExtractionTurns: [turn],
      extractorFactory: () => live, diagnosticDir: null });
    const result = await runner.seedTurn({ ...turn,
      daemon: buildCompileSeedDaemon(() => makeSeed("cached-memory")),
      evidenceRefBase: "raw-round", seedIndex: 0, workspaceId: "workspace-1", runId: "run-1" });
    expect(result.seeds).toHaveLength(1);
    expect(runner.stats).toMatchObject({ cacheHits: 1, llmCalls: 0 });
    expect(live.extract).not.toHaveBeenCalled();
  });

  it("writes the exact configured model into the admitted shard", async () => {
    const live = delegate();
    const extractor = createCachingSignalExtractor({ delegate: live, config, cacheRoot, ...authority() });
    await extractor.extract(input);
    const key = computeCacheKey(config.model, config.requestProfile, input.systemPrompt, input.userPrompt);
    expect(JSON.parse(readFileSync(cacheFilePath(cacheRoot, key), "utf8"))).toMatchObject({ model: "gpt-5.4-mini" });
    expect(live.extract).toHaveBeenCalledOnce();
  });

  it("rejects a model change before writing its different cache key", async () => {
    const live = delegate(), grants = authority();
    await createCachingSignalExtractor({ delegate: live, config, cacheRoot, ...grants }).extract(input);
    const changed = { ...config, model: "gpt-4.1-mini", modelFamily: "gpt-4.1-mini" };
    await expect(createCachingSignalExtractor({ delegate: live, config: changed, cacheRoot, ...grants })
      .extract(input)).rejects.toThrow(/extraction model mismatch/u);
    expect(live.extract).toHaveBeenCalledOnce();
    const key = computeCacheKey(changed.model, changed.requestProfile, input.systemPrompt, input.userPrompt);
    expect(() => readFileSync(cacheFilePath(cacheRoot, key))).toThrow(/ENOENT/u);
  });

  it("rejects a request-profile change before the delegate or shard write", async () => {
    const live = delegate();
    const extractor = createCachingSignalExtractor({ delegate: live,
      config: { ...config, requestProfile: "deepseek-v4-nonthinking-v1" }, cacheRoot, ...authority() });
    await expect(extractor.extract(input)).rejects.toThrow(/request profile mismatch/u);
    expect(live.extract).not.toHaveBeenCalled();
    expect(readdirSync(cacheRoot).filter(entry => /^[0-9a-f]{2}$/u.test(entry))).toEqual([]);
  });

  it.each(["missing", "invalid"] as const)("fails closed on a %s shard when live extraction is disabled", async status => {
    const key = computeCacheKey(config.model, config.requestProfile, input.systemPrompt, input.userPrompt);
    if (status === "invalid") {
      mkdirSync(join(cacheRoot, key.slice(0, 2)), { recursive: true });
      writeFileSync(cacheFilePath(cacheRoot, key), "{torn", "utf8");
    }
    const live = delegate();
    const extractor = createCachingSignalExtractor({ delegate: live, config, cacheRoot, allowLiveExtraction: false });
    await expect(extractor.extract(input)).rejects.toThrow(status === "invalid"
      ? /cache-only.*invalid/u : /cache-only.*missing|missing.*live extraction disabled/u);
    expect(live.extract).not.toHaveBeenCalled();
    if (status === "invalid") expect(readFileSync(cacheFilePath(cacheRoot, key), "utf8")).toBe("{torn");
  });
});
