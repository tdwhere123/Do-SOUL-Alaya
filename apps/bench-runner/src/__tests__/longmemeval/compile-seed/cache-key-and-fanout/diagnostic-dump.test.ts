import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const boundary = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterAll(() => { boundary.restore(); expect(boundary.violations).toEqual([]); });
import { SOURCE_STATEMENTS_PROMPT } from "@do-soul/alaya-soul";
import { createCompileSeedRunner, type CompileSeedExtractionConfig } from "../../../../runs/compile-seed.js";
import { cacheFilePath } from "../../../../runs/compile-seed/compile-seed-cache.js";
import { writeExtractionCacheTestManifest } from "../../extraction/extraction-cache-test-fixture.js";
import { computeCacheKey } from "../../../../runs/compile-seed/cache/cache-key.js";
import { sourceStatementRequests } from "../../../../runs/extraction/source-statement-request.js";
import { buildGroundedInterpretationResponse } from "../../extraction-fill/fixture.js";
import { admitStatementSessionCache, buildCompileSeedDaemon } from "../compile-seed-fixture.js";

const TURN = "I recorded a durable diagnostic source.";
const MESSAGES = [{ message_id: "recorded-diagnostic", role: "user" as const, content: TURN }];
const config: CompileSeedExtractionConfig = {
  providerUrl: "https://example.test/v1", model: "gpt-test-mini",
  requestProfile: "provider-default-v1", apiKey: null, sourcePacking: "session-statements"
};

describe("cache-only compile-seed failure diagnostics", () => {
  let cacheRoot: string;
  let diagnosticDir: string;
  let cacheKey: string;

  beforeEach(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "compile-seed-diag-cache-"));
    diagnosticDir = await mkdtemp(join(tmpdir(), "compile-seed-diag-"));
    const userPrompt = sourceStatementRequests(MESSAGES)[0]!.userPrompt;
    writeExtractionCacheTestManifest({ cacheRoot, model: config.model, providerUrl: config.providerUrl, systemPrompt: SOURCE_STATEMENTS_PROMPT });
    await admitStatementSessionCache({ cacheRoot, config, messages: MESSAGES,
      rawJson: () => buildGroundedInterpretationResponse(userPrompt) });
    cacheKey = computeCacheKey(config.model, config.requestProfile, SOURCE_STATEMENTS_PROMPT, userPrompt);
  });

  afterEach(async () => {
    await rm(cacheRoot, { recursive: true, force: true });
    await rm(diagnosticDir, { recursive: true, force: true });
  });

  function unreadableShardRunner(dumpDir: string | null) {
    const extract = vi.fn(async () => { throw new Error("cache-only seed must not call the provider"); });
    const runner = createCompileSeedRunner({ config, cacheRoot,
      requiredExtractionTurns: [{ turnContent: TURN, turnMessages: MESSAGES }],
      diagnosticDir: dumpDir,
      extractorFactory: () => ({ extract }) });
    // Preflight saw a complete cache; the live seed boundary must diagnose later read failure.
    writeFileSync(cacheFilePath(cacheRoot, cacheKey), "{unreadable", "utf8");
    return { runner, extract };
  }

  function seed(runner: ReturnType<typeof createCompileSeedRunner>) {
    return runner.seedTurn({
      daemon: buildCompileSeedDaemon(() => { throw new Error("failed cache read must not seed a memory"); }), turnContent: TURN,
      evidenceRefBase: "q1-s0-t0", seedIndex: 0,
      workspaceId: "workspace-1", runId: "run-test", turnMessages: MESSAGES
    });
  }

  function dumpFiles() {
    return readdirSync(diagnosticDir).filter((file) => file.startsWith("compile-seed-") && file.endsWith(".json"));
  }

  it("writes the exact cache-key prefix when a preflighted shard becomes unreadable", async () => {
    const { runner, extract } = unreadableShardRunner(diagnosticDir);
    await expect(seed(runner)).resolves.toMatchObject({ seeds: [] });
    expect(extract).not.toHaveBeenCalled();
    expect(dumpFiles()).toHaveLength(1);
    const dump = JSON.parse(readFileSync(join(diagnosticDir, dumpFiles()[0]!), "utf8"));
    expect(dump).toMatchObject({
      surface: "compile-seed", provider_kind: "official_api", model_id: "gpt-test-mini",
      workspace_id: "workspace-1", run_id: "run-test", cache_key_prefix: cacheKey.slice(0, 12),
      last_extraction_source: null, live_extraction_failures: 0, cached_extraction_failures: 0
    });
    expect(dump.error_message).toBe("Official garden session compilation is incomplete.");
    expect(runner.stats).toMatchObject({ cacheHits: 0, llmCalls: 0, extractionAttempts: 1 });
  });

  it("keeps failure diagnostics disabled when diagnosticDir is null", async () => {
    const { runner, extract } = unreadableShardRunner(null);
    await expect(seed(runner)).resolves.toMatchObject({ seeds: [] });
    expect(dumpFiles()).toEqual([]);
    expect(extract).not.toHaveBeenCalled();
    // Failed reads never become successful cache hits or attributed live attempts.
    expect(runner.stats).toMatchObject({ cacheHits: 0, llmCalls: 0, extractionAttempts: 1,
      lastExtractionSource: null, liveExtractionFailures: 0, cachedExtractionFailures: 0 });
  });
});
