import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import {
  createCompileSeedRunner,
  type BenchSignalExtractor
} from "../../../longmemeval/compile-seed.js";
import {
  cacheFilePath,
  computeCacheKey
} from "../../../longmemeval/compile-seed/compile-seed-cache.js";
import type { BenchSignalSeedInput } from "../../../harness/daemon.js";
import {
  buildCompileSeedDaemon,
  OFFLINE_CONFIG,
  signalsEnvelope
} from "./compile-seed-fixture.js";
import { writeExtractionCacheTestManifest } from "../extraction/extraction-cache-test-fixture.js";

const MODEL = "cache-only-model";
const REQUEST_PROFILE = "provider-default-v1";
const TURN = "Alice moved to Berlin.";

describe("createCompileSeedRunner — credentialless cache-only path", () => {
  let cacheRoot: string;

  beforeEach(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "compile-seed-cache-only-"));
    vi.stubEnv("ALAYA_OFFICIAL_GARDEN_SECRET_REF", "");
    vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", "");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("uses official_api_compile from a complete cache without an API secret", async () => {
    writeManifest();
    writeShard(signalsEnvelope([
      { distilled: "Alice moved to Berlin.", matched: "Alice moved to Berlin." }
    ]));
    const delegate = vi.fn<BenchSignalExtractor["extract"]>();
    const seeded: BenchSignalSeedInput[] = [];
    const runner = createCompileSeedRunner({
      cacheRoot,
      requiredTurnContents: [TURN],
      extractorFactory: () => ({ extract: delegate }),
      diagnosticDir: null
    });

    const result = await runner.seedTurn({
      daemon: buildCompileSeedDaemon((input) => {
        seeded.push(input);
        return {
          memoryId: "memory-1",
          signalId: "signal-1",
          proposalId: "proposal-1",
          evidenceId: "evidence-1",
          truncated: false,
          charsClipped: 0
        };
      }),
      turnContent: TURN,
      evidenceRefBase: "q1-s0-t0",
      seedIndex: 0,
      workspaceId: "ws-test",
      runId: "run-test"
    });

    expect(result.seeds).toHaveLength(1);
    expect(seeded[0]?.extractionProvider).toBe("official_api_compile");
    expect(delegate).not.toHaveBeenCalled();
    expect(runner.stats).toMatchObject({
      path: "official_api_compile",
      cacheHits: 1,
      llmCalls: 0,
      offlineFallbacks: 0
    });
  });

  it("uses the manifest cache with an explicit credentialless config", async () => {
    writeManifest();
    writeShard(signalsEnvelope([
      { distilled: "Alice moved to Berlin.", matched: "Alice moved to Berlin." }
    ]));
    const delegate = vi.fn<BenchSignalExtractor["extract"]>();
    const runner = createCompileSeedRunner({
      cacheRoot,
      config: {
        providerUrl: "https://example.test/v1",
        model: MODEL,
        requestProfile: REQUEST_PROFILE,
        apiKey: null
      },
      requiredTurnContents: [TURN],
      extractorFactory: () => ({ extract: delegate }),
      diagnosticDir: null
    });

    const result = await runner.seedTurn({
      daemon: buildCompileSeedDaemon(() => ({
        memoryId: "memory-explicit",
        signalId: "signal-explicit",
        proposalId: "proposal-explicit",
        evidenceId: "evidence-explicit",
        truncated: false,
        charsClipped: 0
      })),
      turnContent: TURN,
      evidenceRefBase: "q1-s0-t0",
      seedIndex: 0,
      workspaceId: "ws-test",
      runId: "run-test"
    });

    expect(result.seeds).toHaveLength(1);
    expect(delegate).not.toHaveBeenCalled();
    expect(runner.stats).toMatchObject({
      path: "official_api_compile",
      cacheHits: 1,
      llmCalls: 0,
      offlineFallbacks: 0
    });
  });

  it.each(["missing", "invalid"] as const)(
    "fails closed on a %s shard before the delegate boundary",
    async (fixtureStatus) => {
      writeManifest();
      if (fixtureStatus === "invalid") writeShard("{not-json");
      const delegate = vi.fn<BenchSignalExtractor["extract"]>();
      const runner = createCompileSeedRunner({
        cacheRoot,
        extractorFactory: () => ({ extract: delegate }),
        diagnosticDir: null
      });

      await expect(runner.seedTurn({
        daemon: buildCompileSeedDaemon(() => {
          throw new Error("seed materialization must not run");
        }),
        turnContent: TURN,
        evidenceRefBase: "q1-s0-t0",
        seedIndex: 0,
        workspaceId: "ws-test",
        runId: "run-test"
      })).rejects.toMatchObject({
        kind: "invalid_response",
        cause: {
          message: expect.stringContaining(
            `[longmemeval cache-only] extraction fixture ${fixtureStatus}`
          )
        }
      });

      expect(delegate).not.toHaveBeenCalled();
      expect(runner.stats).toMatchObject({
        path: "official_api_compile",
        cacheHits: 0,
        llmCalls: 0,
        offlineFallbacks: 0
      });
    }
  );

  it("blocks a credentialled miss when the caller disables live extraction", async () => {
    writeManifest();
    const delegate = vi.fn<BenchSignalExtractor["extract"]>();
    const runner = createCompileSeedRunner({
      cacheRoot,
      config: {
        providerUrl: "https://example.test/v1",
        model: MODEL,
        requestProfile: REQUEST_PROFILE,
        apiKey: "test-secret-never-used"
      },
      allowLiveExtraction: false,
      skipPreflight: true,
      extractorFactory: () => ({ extract: delegate }),
      diagnosticDir: null
    });

    await expect(runner.seedTurn({
      daemon: buildCompileSeedDaemon(() => {
        throw new Error("seed materialization must not run");
      }),
      turnContent: TURN,
      evidenceRefBase: "q1-s0-t0",
      seedIndex: 0,
      workspaceId: "ws-test",
      runId: "run-test"
    })).rejects.toMatchObject({
      kind: "invalid_response",
      cause: { message: expect.stringContaining("[longmemeval cache-only]") }
    });

    expect(delegate).not.toHaveBeenCalled();
    expect(runner.stats).toMatchObject({ llmCalls: 0, cacheHits: 0 });
  });

  it("does not attribute a miss to the preceding cache hit", async () => {
    writeManifest();
    writeShard(signalsEnvelope([
      { distilled: "Alice moved to Berlin.", matched: "Alice moved to Berlin." }
    ]));
    const delegate = vi.fn<BenchSignalExtractor["extract"]>();
    const runner = createCompileSeedRunner({
      cacheRoot,
      extractorFactory: () => ({ extract: delegate }),
      diagnosticDir: null
    });
    const daemon = buildCompileSeedDaemon(() => ({
      memoryId: "memory-1",
      signalId: "signal-1",
      proposalId: "proposal-1",
      evidenceId: "evidence-1",
      truncated: false,
      charsClipped: 0
    }));

    await runner.seedTurn({
      daemon,
      turnContent: TURN,
      evidenceRefBase: "q1-s0-t0",
      seedIndex: 0,
      workspaceId: "ws-test",
      runId: "run-test"
    });
    await expect(runner.seedTurn({
      daemon,
      turnContent: "This turn has no cache fixture.",
      evidenceRefBase: "q1-s0-t1",
      seedIndex: 1,
      workspaceId: "ws-test",
      runId: "run-test"
    })).rejects.toMatchObject({ kind: "invalid_response" });

    expect(delegate).not.toHaveBeenCalled();
    expect(runner.stats).toMatchObject({
      cacheHits: 1,
      cachedExtractionFailures: 0,
      liveExtractionFailures: 0,
      lastExtractionSource: null
    });
  });

  it("retains the explicit manifest-less no-credentials fallback", async () => {
    vi.stubEnv("ALAYA_BENCH_REQUIRE_EXTRACTION_CACHE_MANIFEST", "0");
    const extractorFactory = vi.fn();
    const seeded: BenchSignalSeedInput[] = [];
    const runner = createCompileSeedRunner({
      config: OFFLINE_CONFIG,
      cacheRoot,
      extractorFactory,
      diagnosticDir: null
    });

    await runner.seedTurn({
      daemon: buildCompileSeedDaemon((input) => {
        seeded.push(input);
        return {
          memoryId: "memory-1",
          signalId: "signal-1",
          proposalId: "proposal-1",
          evidenceId: "evidence-1",
          truncated: false,
          charsClipped: 0
        };
      }),
      turnContent: TURN,
      evidenceRefBase: "q1-s0-t0",
      seedIndex: 0,
      workspaceId: "ws-test",
      runId: "run-test"
    });

    expect(extractorFactory).not.toHaveBeenCalled();
    expect(seeded[0]?.extractionProvider).toBe("no_credentials_fallback");
    expect(runner.stats).toMatchObject({
      path: "no_credentials_fallback",
      cacheHits: 0,
      llmCalls: 0,
      offlineFallbacks: 1
    });
  });

  function writeManifest(): void {
    writeExtractionCacheTestManifest({
      cacheRoot,
      model: MODEL,
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
      requestProfile: REQUEST_PROFILE
    });
  }

  function writeShard(rawJson: string): void {
    const cacheKey = computeCacheKey(
      MODEL,
      REQUEST_PROFILE,
      OFFICIAL_API_SYSTEM_PROMPT,
      TURN
    );
    const filePath = cacheFilePath(cacheRoot, cacheKey);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify({
      model: MODEL,
      request_profile: REQUEST_PROFILE,
      cache_key: cacheKey,
      raw_json: rawJson,
      extracted_at: "2026-07-16T00:00:00.000Z"
    }), "utf8");
  }
});
