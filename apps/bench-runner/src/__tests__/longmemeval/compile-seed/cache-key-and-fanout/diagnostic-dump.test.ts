import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import {
  createCompileSeedRunner,
  type CompileSeedDaemon,
  type CompileSeedExtractionConfig
} from "../../../../bench/compile-seed.js";
import {
  writeExtractionCacheTestManifest
} from "../../extraction/extraction-cache-test-fixture.js";

// Phase A.1 instrument coverage: a seed-side extraction failure must drop one
// diagnostic JSON file carrying cache_key_prefix / model / provider so a
// Phase A.2 preflight reader can attribute the failure to a specific cache
// shard or live call without re-running the bench.
describe("compile-seed diagnostic dump (Phase A.1 instrument)", () => {
  let cacheRoot: string;
  let diagnosticDir: string;

  beforeEach(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "compile-seed-diag-cache-"));
    diagnosticDir = await mkdtemp(join(tmpdir(), "compile-seed-diag-"));
    writeExtractionCacheTestManifest({
      cacheRoot,
      model: "gpt-test-mini",
      providerUrl: "https://example.test/v1",
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
    });
  });

  afterEach(async () => {
    await rm(cacheRoot, { recursive: true, force: true });
    await rm(diagnosticDir, { recursive: true, force: true });
  });

  it("writes a compile-seed-*.json dump carrying cache_key_prefix when live extraction fails", async () => {
    const config: CompileSeedExtractionConfig = {
      providerUrl: "https://example.test/v1",
      model: "gpt-test-mini",
      requestProfile: "provider-default-v1",
      apiKey: "test-key"
    };
    const daemon: CompileSeedDaemon = {
      proposeMemoryFromSignal: async (_input) => ({
        memoryId: "memory-1",
        signalId: "signal-memory-1",
        proposalId: "proposal-memory-1",
        evidenceId: "evidence-memory-1",
        truncated: false,
        charsClipped: 0
      }),
      proposeMemoriesFromCompileSignals: async () => ({ seeds: [], dropped: [] }),
      proposeSynthesis: async () => ({ synthesisId: null })
    };
    const runner = createCompileSeedRunner({
      config,
      cacheRoot,
      allowLiveExtraction: true,
      diagnosticDir,
      extractorFactory: () => ({
        extract: async () => {
          throw new Error("garden extraction HTTP 500 from provider");
        }
      })
    });

    await expect(
      runner.seedTurn({
        daemon,
        turnContent: "Turn whose extraction blows up.",
        evidenceRefBase: "q1-s0-t0",
        seedIndex: 0,
        workspaceId: "ws-test",
        runId: "run-test"
      })
    ).rejects.toThrow("Official garden provider returned an invalid response.");

    const dumpFiles = readdirSync(diagnosticDir).filter(
      (f) => f.startsWith("compile-seed-") && f.endsWith(".json")
    );
    expect(dumpFiles).toHaveLength(1);
    const dump = JSON.parse(
      readFileSync(join(diagnosticDir, dumpFiles[0]!), "utf8")
    ) as Record<string, unknown>;

    expect(dump).toMatchObject({
      surface: "compile-seed",
      provider_kind: "official_api",
      model_id: "gpt-test-mini",
      workspace_id: "ws-test",
      run_id: "run-test",
      last_extraction_source: "live",
      live_extraction_failures: 1,
      cached_extraction_failures: 0
    });
    // cache_key_prefix is the 12-char SHA-256 prefix the caching extractor
    // recorded onto stats.lastCacheKey before the delegate threw.
    expect(typeof dump.cache_key_prefix).toBe("string");
    expect((dump.cache_key_prefix as string).length).toBe(12);
    expect((dump.cache_key_prefix as string)).toMatch(/^[0-9a-f]{12}$/u);
    expect(typeof dump.error_message).toBe("string");
    // The seed-side dump receives the wrapped GardenProviderError (the
    // OfficialApiGardenProvider maps the transport HTTP 500 onto
    // "invalid_response"). The underlying HTTP 500 is in the provider-side
    // dump's `response_status` field, not in the bench-side error_message
    // string.
    expect((dump.error_message as string)).toContain(
      "Official garden provider returned an invalid response."
    );
  });

  it("does not write a dump when diagnosticDir is null (instrument disabled)", async () => {
    const config: CompileSeedExtractionConfig = {
      providerUrl: "https://example.test/v1",
      model: "gpt-test-mini",
      requestProfile: "provider-default-v1",
      apiKey: "test-key"
    };
    const daemon: CompileSeedDaemon = {
      proposeMemoryFromSignal: async () => ({
        memoryId: "memory-1",
        signalId: "signal-memory-1",
        proposalId: "proposal-memory-1",
        evidenceId: "evidence-memory-1",
        truncated: false,
        charsClipped: 0
      }),
      proposeMemoriesFromCompileSignals: async () => ({ seeds: [], dropped: [] }),
      proposeSynthesis: async () => ({ synthesisId: null })
    };
    const runner = createCompileSeedRunner({
      config,
      cacheRoot,
      allowLiveExtraction: true,
      diagnosticDir: null,
      extractorFactory: () => ({
        extract: async () => {
          throw new Error("garden extraction HTTP 502");
        }
      })
    });

    await expect(
      runner.seedTurn({
        daemon,
        turnContent: "Another failing turn.",
        evidenceRefBase: "q2-s0-t0",
        seedIndex: 0,
        workspaceId: "ws-test",
        runId: "run-test"
      })
    ).rejects.toThrow();

    // diagnosticDir was created by beforeEach but never written to.
    const dumpFiles = readdirSync(diagnosticDir).filter(
      (f) => f.startsWith("compile-seed-") && f.endsWith(".json")
    );
    expect(dumpFiles).toHaveLength(0);
    // The classification path still ran so liveExtractionFailures is bumped.
    expect(runner.stats.liveExtractionFailures).toBe(1);
  });
});
