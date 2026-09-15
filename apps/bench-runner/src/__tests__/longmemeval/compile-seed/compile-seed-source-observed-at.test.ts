import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { initDatabase } from "@do-soul/alaya-storage";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import { startBenchDaemon } from "../../../harness/daemon.js";
import { createCompileSeedRunner } from "../../../runs/compile-seed.js";
import { CREDENTIALLED_CONFIG, providerBackedResult } from "./compile-seed-fixture.js";
import { writeExtractionCacheTestManifest } from "../extraction/extraction-cache-test-fixture.js";

it("reuses raw interpretations while deriving inclusive memory dates from each retained source clock", async () => {
  const root = await mkdtemp(join(tmpdir(), "compile-seed-observed-"));
  let daemon: Awaited<ReturnType<typeof startBenchDaemon>> | undefined;
  let db: ReturnType<typeof initDatabase> | undefined;
  vi.stubEnv("ALAYA_INGEST_RECONCILIATION_ENABLED", "0");
  vi.stubEnv("ALAYA_OFFICIAL_GARDEN_SECRET_REF", "");
  try {
    const cacheRoot = join(root, "cache");
    writeExtractionCacheTestManifest({ cacheRoot, model: CREDENTIALLED_CONFIG.model,
      providerUrl: CREDENTIALLED_CONFIG.providerUrl, systemPrompt: OFFICIAL_API_SYSTEM_PROMPT });
    const extract = vi.fn(async () => providerBackedResult(JSON.stringify({ interpretations: [{
      assertion_id: 1, relations: [{ predicate: { text: "completed" },
        arguments: [{ role: "object", phrase: { text: "the review" } }],
        qualifiers: [{ role: "time", phrase: { text: "today" } }] }]
    }] })));
    const runner = createCompileSeedRunner({ config: CREDENTIALLED_CONFIG, cacheRoot,
      extractorFactory: () => ({ extract }), allowLiveExtraction: true, skipPreflight: true });
    daemon = await startBenchDaemon({ dataDirRoot: join(root, "consumer"), workspaceId: "observed-source", runId: "observed-source-run" });
    const memoryIds: string[] = [];
    for (const [index, sourceObservedAt] of ["2024-06-15T14:30:00.000Z", "2024-06-16T14:30:00.000Z"].entries()) {
      const result = await runner.seedTurn({ daemon, turnContent: "I completed the review today.",
        turnMessages: [{ message_id: `trusted-user-${index}`, role: "user", content: "I completed the review today." }],
        evidenceRefBase: `q-s-r-${index}`, seedIndex: index, workspaceId: daemon.workspaceId,
        runId: daemon.runId, sourceObservedAt });
      expect(result.seeds).toHaveLength(1);
      const memoryId = result.seeds[0]!.memoryId;
      if (memoryId === undefined) throw new Error("expected memory publication");
      memoryIds.push(memoryId);
    }
    expect(extract).toHaveBeenCalledTimes(1);
    expect(runner.stats.cacheHits).toBe(1);
    db = initDatabase({ filename: join(daemon.dataDir, "alaya.db") });
    const rows = memoryIds.map((id) => db!.connection.prepare(
      "SELECT content, event_time_start, event_time_end, time_precision, time_source FROM memory_entries WHERE object_id = ?"
    ).get(id));
    expect(rows).toEqual([15, 16].map((day) => ({
      content: "User: I completed the review today.",
      event_time_start: `2024-06-${day}T00:00:00.000Z`,
      event_time_end: `2024-06-${day}T23:59:59.999Z`,
      time_precision: "day", time_source: "relative_resolved"
    })));
    const unknown = await runner.seedTurn({ daemon, turnContent: "I completed the review today.",
      evidenceRefBase: "q-s-r-unknown", seedIndex: 2, workspaceId: daemon.workspaceId, runId: daemon.runId });
    expect(unknown.seeds).toHaveLength(1);
    expect(db.connection.prepare("SELECT event_time_start, event_time_end, time_precision, time_source FROM memory_entries WHERE object_id = ?")
      .get(unknown.seeds[0]!.memoryId)).toEqual({ event_time_start: null, event_time_end: null,
        time_precision: null, time_source: null });
    expect(extract).toHaveBeenCalledTimes(1);
  } finally {
    try { await daemon?.shutdown(); }
    finally { db?.close(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
  }
});
