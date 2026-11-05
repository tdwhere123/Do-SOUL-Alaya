import { afterEach, describe, expect, it, vi } from "vitest";
import { CoherenceEdgeProducerService } from "@do-soul/alaya-core";
import { GardenEventType } from "@do-soul/alaya-protocol";
import { initDatabase } from "@do-soul/alaya-storage";
import { createFaults, createHandoffRuntime, seedHandoffData, WORKSPACE } from "./embedding-backfill-follow-up-fixture.js";

afterEach(() => vi.restoreAllMocks());

describe("Garden embedding backfill temporal clean break", () => {
  it.each([false, true])("runs witnessed answers-with but never revives legacy coherence when opt-in is %s", async flag => {
    const database = initDatabase({ filename: ":memory:" });
    try {
      await seedHandoffData(database);
      const coherence = vi.spyOn(CoherenceEdgeProducerService.prototype, "crystallize");
      const harness = createHandoffRuntime(database, createFaults(), flag);
      await harness.runtime.runEmbeddingBackfillPass(WORKSPACE);
      expect(coherence).not.toHaveBeenCalled();
      expect(harness.relationRepo.listAssertionsInCurrentTransaction()).toHaveLength(3);
      const task = database.connection.prepare(`SELECT status, outcome FROM garden_tasks
        WHERE kind = 'embedding_backfill'`).get();
      expect(task).toEqual({ status: "completed", outcome: "completed" });
      const followUps = (await harness.eventLog.queryByType(GardenEventType.SOUL_GARDEN_EMBEDDING_FOLLOW_UP)).events;
      expect(followUps.map(event => event.payload_json.disposition)).toEqual(["pending", "completed"]);
    } finally { database.close(); }
  });

  it("fills the vector cache without forming assertions in cache-only mode", async () => {
    const database = initDatabase({ filename: ":memory:" });
    try {
      await seedHandoffData(database);
      const coherence = vi.spyOn(CoherenceEdgeProducerService.prototype, "crystallize");
      const harness = createHandoffRuntime(database, createFaults(), true);
      await harness.runtime.runEmbeddingBackfillPass(WORKSPACE, "cache_only");
      expect(coherence).not.toHaveBeenCalled();
      expect(harness.relationRepo.listAssertionsInCurrentTransaction()).toEqual([]);
      expect(database.connection.prepare("SELECT COUNT(*) AS n FROM memory_embeddings").get()).toEqual({ n: 3 });
      expect(database.connection.prepare("SELECT state, mode FROM garden_embedding_backfill_runs").get())
        .toEqual({ state: "skipped", mode: "cache_only" });
      const followUps = (await harness.eventLog.queryByType(GardenEventType.SOUL_GARDEN_EMBEDDING_FOLLOW_UP)).events;
      expect(followUps.map(event => event.payload_json)).toEqual([expect.objectContaining({ disposition: "pending" }),
        expect.objectContaining({ disposition: "skipped", reason: "cache_only" })]);
    } finally { database.close(); }
  });
});
