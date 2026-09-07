import { afterEach, describe, expect, it, vi } from "vitest";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import { createSliceHarness, CONTENT, MEM } from "./harness.js";

const databases = new Set<StorageDatabase>();
afterEach(() => { vi.restoreAllMocks(); for (const database of databases) database.close(); databases.clear(); });
const harness = () => createSliceHarness((database) => databases.add(database));

describe("real local conditional-field recall", () => {
  it("returns source payload with zero provider calls while optional enrichment is pending", async () => {
    const slice = await harness();
    await slice.plantLaunchCorpus({ enrich: true });
    const pending = slice.pendingGarden();
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    const result = await slice.runRecall({ text: "deployment checklist" });
    expect(result.membership).toContain(MEM.checklist);
    expect(result.previews.get(MEM.checklist)).toBe(CONTENT.checklist);
    expect(result.index.entries.every((entry) => entry.claim === "unknown")).toBe(true);
    expect(result.index.completeness.interpretation_coverage).not.toBe("complete");
    expect(slice.pendingGarden()).toEqual(pending);
    expect(result.counters.recall_source_writes).toBe(0);
    expect(network).not.toHaveBeenCalled();
  });

  it("unavailable lexical observations do not become exhausted-empty or semantic success", async () => {
    const slice = await harness();
    await slice.plantLaunchCorpus({ plantVectors: true });
    const result = await slice.runRecall({ text: "deployment checklist",
      familyCaps: { lexical: "unavailable", typed_relation: "unavailable", embedding: "ready" } });
    expect(result.index.entries).toEqual([]);
    expect(result.index.completeness.observed_coverage).toBe("unavailable");
    expect(result.counters.query_embed_count).toBe(0);
  });

  it("repeated source-only recall retains exact query, snapshot and representation identities", async () => {
    const slice = await harness();
    await slice.plantLaunchCorpus();
    const first = await slice.runRecall({ text: "deployment checklist" });
    const second = await slice.runRecall({ text: "deployment checklist" });
    expect(second.index).toEqual(first.index);
    expect(second.counters.recall_source_writes).toBe(0);
  });

  it("retains uncertainty for unsupported aggregate and temporal interpretations", async () => {
    const slice = await harness();
    await slice.plantLaunchCorpus({ includeTemporalOwners: true });
    for (const text of ["How many owners ever?", "Not before June 1, who owned Orion?",
      "Before January 1, 2020 and after June 1, who owned Orion?"]) {
      const result = await slice.runRecall({ text });
      expect(result.index.completeness.interpretation_coverage).not.toBe("complete");
      expect(result.index.entries.every((entry) => entry.claim !== "supported")).toBe(true);
    }
  });

  it("rejects a resource envelope before source observation", async () => {
    const slice = await harness();
    await slice.plantLaunchCorpus();
    const result = await slice.runRecall({ text: "deployment checklist", budget: { work_units: 1 } });
    expect(result.index.entries).toEqual([]);
    expect(result.index.completeness.logical_index).toBe("resource_rejected");
    expect(result.counters.source_reads).toBe(0);
  });
});
