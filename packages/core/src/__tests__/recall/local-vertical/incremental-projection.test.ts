import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryDimension } from "@do-soul/alaya-protocol";
import { initializeSemanticArtifactCandidateSchema, type StorageDatabase } from "@do-soul/alaya-storage";
import { artifactFixture } from "./artifact-lifecycle-fixture.js";
import { createSliceHarness } from "./harness.js";
import { CONTENT, MEM, NOW, WS } from "./ids.js";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("incremental projection and read-only recall", () => {
  it("A1 raw recall hits planted evidence while enrichment is pending then updates only the changed view", async () => {
    const f = await artifactFixture((database) => databases.add(database));
    await f.write(MEM.checklist, CONTENT.checklist);
    expect(f.slice.indexProjection.freshness(WS, MEM.checklist)).toMatchObject({
      lexical: "ready", semantic: "pending", embedding: "pending"
    });
    const pending = await f.slice.runRecall({
      text: "Where is the deployment checklist?",
      familyCaps: { embedding: "unavailable" }
    });
    expect(pending.membership).toContain(MEM.checklist);
    expect(pending.counters.recall_source_writes).toBe(0);
    expect(pending.counters.recall_provider_calls).toBe(0);
    expect(f.slice.pendingGarden().length).toBeGreaterThan(0);
    const other = await f.write(MEM.orion, "Alice owns Orion");
    const checklistBefore = f.slice.indexProjection.revision(WS, MEM.checklist);
    expect(await f.worker(transport()).run(WS, other)).toBe("completed");
    expect(f.slice.indexProjection.freshness(WS, MEM.orion).semantic).toBe("ready");
    expect(f.slice.indexProjection.freshness(WS, MEM.checklist).semantic).toBe("pending");
    expect(f.slice.indexProjection.revision(WS, MEM.checklist)).toEqual(checklistBefore);
    const enriched = await f.slice.runRecall({
      text: "Where is the deployment checklist?",
      familyCaps: { embedding: "unavailable" }
    });
    expect(enriched.membership).toContain(MEM.checklist);
  });

  it("A2 restart, duplicate init, tombstone and concurrent reads preserve identity and freshness", async () => {
    const directory = mkdtempSync(join(tmpdir(), "w02-a2-"));
    const filename = join(directory, "source.sqlite");
    const first = await createSliceHarness((database) => databases.add(database), filename);
    await first.writeMemory(MEM.checklist, CONTENT.checklist, MemoryDimension.PROCEDURE, true);
    const checklistRevision = first.indexProjection.revision(WS, MEM.checklist);
    expect(checklistRevision?.tombstoned).toBe(0);
    first.database.close();
    databases.delete(first.database);
    const reopened = await createSliceHarness((database) => databases.add(database), filename);
    expect(reopened.indexProjection.revision(WS, MEM.checklist)).toEqual(checklistRevision);
    initializeSemanticArtifactCandidateSchema(reopened.database.connection);
    expect(reopened.indexProjection.revision(WS, MEM.checklist)).toEqual(checklistRevision);
    await reopened.writeMemory(MEM.orion, "Alice owns Orion", MemoryDimension.FACT, false);
    const cursor = reopened.indexProjection.cursor(WS);
    const updateWithinTransaction = reopened.memoryEntryRepo.updateWithinTransaction;
    if (updateWithinTransaction === undefined) {
      throw new Error("memory update transaction port is required for W02 tombstone");
    }
    updateWithinTransaction.call(reopened.memoryEntryRepo, MEM.orion, {
      retention_state: "tombstoned",
      updated_at: NOW
    }, { beforeUpdate: () => undefined, afterUpdate: () => undefined }, WS);
    expect(reopened.indexProjection.freshness(WS, MEM.orion).lexical).toBe("tombstoned");
    expect(reopened.indexProjection.freshness(WS, MEM.checklist).lexical).toBe("ready");
    const [left, right] = await Promise.all([
      reopened.runRecall({ text: "Where is the deployment checklist?", familyCaps: { embedding: "unavailable" } }),
      reopened.runRecall({ text: "Where is the deployment checklist?", familyCaps: { embedding: "unavailable" } })
    ]);
    expect(left.membership).toContain(MEM.checklist);
    expect(right.membership).toEqual(left.membership);
    const tombstoned = await reopened.runRecall({
      text: "Alice owns Orion", familyCaps: { embedding: "unavailable", typed_relation: "unavailable" }
    });
    expect(tombstoned.membership).not.toContain(MEM.orion);
    expect(reopened.indexProjection.cursor(WS)?.appliedEventRevision)
      .toBeGreaterThanOrEqual(cursor?.appliedEventRevision ?? 0);
    expect(reopened.indexProjection.revision(WS, MEM.orion)?.tombstoned).toBe(1);
    reopened.database.close();
    databases.delete(reopened.database);
    rmSync(directory, { recursive: true, force: true });
  });

  it("A3 warm repeated recall makes zero extract, enqueue or source writes", async () => {
    const slice = await createSliceHarness((database) => databases.add(database));
    await slice.writeMemory(MEM.checklist, CONTENT.checklist, MemoryDimension.PROCEDURE, true);
    const beforeEnqueue = slice.counters.garden_enqueue;
    const first = await slice.runRecall({
      text: "Where is the deployment checklist?", familyCaps: { embedding: "unavailable" }
    });
    const second = await slice.runRecall({
      text: "Where is the deployment checklist?", familyCaps: { embedding: "unavailable" }
    });
    expect(first.membership).toEqual(second.membership);
    expect(first.index.query_id).toBe(second.index.query_id);
    expect(second.counters.recall_provider_calls).toBe(0);
    expect(second.counters.recall_source_writes).toBe(0);
    expect(second.counters.garden_enqueue).toBe(beforeEnqueue);
    expect(second.counters.full_tier_scan).toBe(0);
  });

  it("A4 missing object and pending derived state stay explicit, never source absence", async () => {
    const slice = await createSliceHarness((database) => databases.add(database));
    await slice.writeMemory(MEM.checklist, CONTENT.checklist, MemoryDimension.PROCEDURE, true);
    expect(slice.indexProjection.freshness(WS, MEM.checklist)).toMatchObject({
      lexical: "ready", semantic: "pending"
    });
    expect(slice.indexProjection.freshness(WS, "missing-object")).toMatchObject({
      lexical: "missing", semantic: "unavailable", embedding: "unavailable"
    });
    const truncated = await slice.runRecall({
      text: "Where is the deployment checklist?",
      familyCaps: { embedding: "unavailable" },
      budget: { work_units: 1 }
    });
    expect(truncated.index.completeness.logical_index).not.toBe("complete");
    expect(truncated.index.entries).toEqual([]);
    const missingCap = await slice.runRecall({
      text: "Who is working remotely?", familyCaps: { embedding: "unavailable" }
    });
    expect(missingCap.counters.recall_provider_calls).toBe(0);
    expect(missingCap.index.completeness.interpretation_coverage).not.toBe("complete");
  });
});

function transport() {
  const calls: string[] = [];
  return {
    calls,
    execute: async (request: string) => {
      calls.push(request);
      const unit = JSON.parse(request) as { text: string };
      return JSON.stringify({ signals: [{ object_kind: "decision", confidence: 0.8,
        matched_text: unit.text, distilled_fact: unit.text }] });
    },
    reconcile: async () => ({ kind: "unknown" as const })
  };
}
