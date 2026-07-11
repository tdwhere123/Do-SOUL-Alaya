import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startBenchDaemon, type BenchDaemonHandle } from "../../harness/daemon.js";

const hostOnnxIt = process.env.ALAYA_RUN_HOST_ONNX_INTEGRATION === "1" ? it : it.skip;

describe("bench daemon embedding-backfill EventLog lifecycle", () => {
  const memoryCount = 500;
  let daemon: BenchDaemonHandle | undefined;
  let root: string | undefined;
  let savedCacheDir: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await daemon?.shutdown().catch(() => undefined);
    if (root !== undefined) await rm(root, { recursive: true, force: true });
    if (savedCacheDir === undefined) delete process.env.ALAYA_LOCAL_EMBEDDING_CACHE_DIR;
    else process.env.ALAYA_LOCAL_EMBEDDING_CACHE_DIR = savedCacheDir;
  });

  hostOnnxIt("warms a real SQLite workspace without an embedding-backfill warning", async () => {
    const stderr: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    savedCacheDir = process.env.ALAYA_LOCAL_EMBEDDING_CACHE_DIR;
    process.env.ALAYA_LOCAL_EMBEDDING_CACHE_DIR = join(
      process.env.HOME ?? "/home/tdwhere",
      ".cache/do-soul-alaya/models"
    );
    root = await mkdtemp(join(tmpdir(), "embedding-eventlog-integration-"));
    daemon = await startBenchDaemon({
      dataDirRoot: root,
      workspaceId: "embedding-eventlog-workspace",
      runId: "embedding-eventlog-run",
      embeddingMode: "env",
      embeddingProviderKind: "local_onnx"
    });
    const { seeds, dropped } = await daemon.proposeMemoriesFromCompileSignals(
      Array.from({ length: memoryCount }, (_, index) => ({
        signalKind: "potential_claim",
        objectKind: "fact",
        confidence: 0.9,
        distilledFact: `Mira uses oat milk in coffee order ${index + 1}.`,
        turnContent: `Mira uses oat milk in coffee order ${index + 1}.`,
        evidenceRef: `embedding-eventlog-${index + 1}`,
        turnSeedIndex: index + 1,
        extractionProvider: "official_api_compile",
        productionRawPayload: {
          matched_text: `Mira uses oat milk in coffee order ${index + 1}.`,
          hqs: ["What milk does Mira use in coffee?"]
        }
      }))
    );

    expect(dropped).toEqual([]);
    const warmup = await daemon.warmEmbeddingCache(seeds.map((seed) => seed.memoryId));

    expect(warmup.ready_count).toBe(memoryCount);
    expect(stderr.join("\n")).not.toContain(
      "embedding backfill task failed; continuing Garden background pass"
    );
  }, 180_000);
});
