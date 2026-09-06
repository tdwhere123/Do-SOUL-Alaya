import { writeFileSync } from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";
import { MemoryDimension } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import { LocalOnnxEmbeddingClient } from "../../../embedding-recall/local-onnx-embedding-client.js";
import { createSliceHarness, MEM } from "./harness.js";

const enabled = process.env.ALAYA_REPAIR_LOCAL_MODEL === "1";
const provider = new LocalOnnxEmbeddingClient({ execution: "in_process" });
const databases: StorageDatabase[] = [];
afterAll(async () => { await provider.close(); for (const db of databases) db.close(); });

describe.skipIf(!enabled)("required real offline embedding positive", () => {
  it("query inference and stored source embeddings distinguish a paraphrase and unrelated distractor", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("network forbidden"); });
    try {
      const slice = await createSliceHarness((db) => databases.push(db), ":memory:", provider);
      await slice.plantLaunchCorpus();
      await slice.writeMemory("40000000-0000-4000-8000-000000000099", "The volcano eruption calendar lists geological events and ash clouds", MemoryDimension.FACT, false);
      const modelStarted = performance.now();
      await slice.plantLocalVectors();
      const documentEmbeddingAndReadinessMs = performance.now() - modelStarted;
      const remote = await slice.runRecall({ text: "Who is working remotely?", k: 1, familyCaps: { lexical: "unavailable", embedding: "ready" } });
      const unrelated = await slice.runRecall({ text: "volcano eruption calendar", k: 1, familyCaps: { lexical: "unavailable", embedding: "ready" } });
      expect(remote.membership).toEqual([MEM.remote]);
      expect(unrelated.membership).toEqual(["40000000-0000-4000-8000-000000000099"]);
      expect(remote.counters.query_embed_count).toBe(1);
      expect(unrelated.counters.query_embed_count).toBe(1);
      expect(network).not.toHaveBeenCalled();
      expect(documentEmbeddingAndReadinessMs).toBeLessThanOrEqual(5000);
      for (const result of [remote, unrelated]) {
        expect(result.counters.phase_ms.total).toBeLessThanOrEqual(2000);
        expect(result.counters.rss).toBeLessThanOrEqual(1024 ** 3);
      }
      writeFileSync("/tmp/stop01-r2-real-model-envelope.json", JSON.stringify({
        createdAt: new Date().toISOString(), model: provider.modelId, documentEmbeddingAndReadinessMs,
        note: "Document embedding includes first local model readiness; each Recall includes its own query inference. No OS cache flush or remote provider.",
        recalls: [remote, unrelated].map((result) => ({ membership: result.membership, counters: result.counters, accounting: result.pack.accounting }))
      }, null, 2));
    } finally { network.mockRestore(); }
  }, 60000);
});
