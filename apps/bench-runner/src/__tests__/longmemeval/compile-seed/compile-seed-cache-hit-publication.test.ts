import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SOURCE_INTERPRETATION_CONTRACT } from "@do-soul/alaya-protocol";
import {
  OFFICIAL_API_SYSTEM_PROMPT
} from "@do-soul/alaya-soul";
import {
  initDatabase,
  SqliteMemoryEntryRepo,
  SqliteSignalRepo
} from "@do-soul/alaya-storage";
import { startBenchDaemon, type BenchDaemonHandle } from "../../../harness/daemon.js";
import { removeTempDirectory } from "../../support/temp-cleanup.js";
import {
  createCompileSeedRunner,
  type BenchSignalExtractor
} from "../../../runs/compile-seed.js";
import {
  cacheFilePath,
  computeSourceTurnCacheKey
} from "../../../runs/compile-seed/compile-seed-cache.js";
import { writeExtractionCacheTestManifest } from "../extraction/extraction-cache-test-fixture.js";

const MODEL = "cache-only-model";
const REQUEST_PROFILE = "provider-default-v1";
const TURN = "Alice uses tools.";
const CLOCK = "2026-09-14T12:00:00.000Z";

describe("compile-seed cache-hit seedTurn publication", () => {
  let cacheRoot: string;
  let dataDirRoot: string | undefined;
  let daemon: BenchDaemonHandle | undefined;

  beforeEach(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "compile-seed-cache-hit-pub-"));
    vi.stubEnv("ALAYA_OFFICIAL_GARDEN_SECRET_REF", "");
    vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", "");
  });

  afterEach(async () => {
    await daemon?.shutdown().catch(() => undefined);
    daemon = undefined;
    vi.unstubAllEnvs();
    await Promise.all([
      removeTempDirectory(cacheRoot, []),
      dataDirRoot === undefined ? Promise.resolve() : removeTempDirectory(dataDirRoot)
    ]);
    dataDirRoot = undefined;
  });

  it("publishes a cache-hit seedTurn observation through SQLite and reopens it", async () => {
    writeManifest();
    writeShard(JSON.stringify({
      interpretations: [{
        assertion_id: 1,
        relations: [{
          predicate: { text: "uses" },
          arguments: [
            { role: "agent", phrase: { text: "Alice" } },
            { role: "object", phrase: { text: "tools" } }
          ],
          qualifiers: []
        }]
      }]
    }));
    dataDirRoot = await mkdtemp(join(tmpdir(), "compile-seed-hit-daemon-"));
    daemon = await startBenchDaemon({
      dataDirRoot,
      workspaceId: "ws-cache-hit",
      runId: "run-cache-hit",
      embeddingMode: "disabled"
    });
    const delegate = vi.fn<BenchSignalExtractor["extract"]>();
    const runner = createCompileSeedRunner({
      cacheRoot,
      requiredTurnContents: [TURN],
      extractorFactory: () => ({ extract: delegate }),
      diagnosticDir: null
    });

    const result = await runner.seedTurn({
      daemon,
      turnContent: TURN,
      evidenceRefBase: "q1-s0-t0",
      seedIndex: 0,
      workspaceId: "ws-cache-hit",
      runId: "run-cache-hit",
      sourceObservedAt: CLOCK
    });

    expect(delegate).not.toHaveBeenCalled();
    expect(runner.stats).toMatchObject({
      path: "official_api_compile",
      cacheHits: 1,
      llmCalls: 0
    });
    expect(result.seeds).toHaveLength(1);
    const seeded = result.seeds[0];
    expect(seeded?.memoryId).toBeDefined();
    if (seeded?.memoryId === undefined) {
      throw new Error("expected memory_entry seed");
    }

    const dbPath = join(daemon.dataDir, "alaya.db");
    let database = initDatabase({ filename: dbPath });
    try {
      const signal = await new SqliteSignalRepo(database).getById(seeded.signalId);
      expect(signal).toMatchObject({
        interpretation_contract: SOURCE_INTERPRETATION_CONTRACT,
        object_kind: null,
        confidence: null
      });
      const published = await new SqliteMemoryEntryRepo(database).findById(seeded.memoryId);
      expect(published).toMatchObject({
        dimension: "observation",
        confidence: null,
        content: expect.stringContaining("Alice uses tools.")
      });
      database.close();
      database = initDatabase({ filename: dbPath });
      const reopened = await new SqliteMemoryEntryRepo(database).findById(seeded.memoryId);
      expect(reopened).toMatchObject({
        object_id: published!.object_id,
        dimension: "observation",
        confidence: null
      });
    } finally {
      if (!database.isClosed()) database.close();
    }
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
    const cacheKey = computeSourceTurnCacheKey(
      MODEL,
      REQUEST_PROFILE,
      OFFICIAL_API_SYSTEM_PROMPT,
      { turnContent: TURN }
    );
    const filePath = cacheFilePath(cacheRoot, cacheKey);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify({
      model: MODEL,
      request_profile: REQUEST_PROFILE,
      cache_key: cacheKey,
      raw_json: rawJson,
      extracted_at: CLOCK
    }), "utf8");
  }
});
