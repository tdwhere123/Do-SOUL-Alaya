import { afterEach, describe, expect, it } from "vitest";
import { MemoryDimension } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import { artifactFixture } from "./artifact-lifecycle-fixture.js";
import { createSliceHarness } from "./harness.js";
import { CONTENT, MEM, WS } from "./ids.js";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("W02 incremental projection and read-only recall", () => {
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
    const f = await artifactFixture((database) => databases.add(database));
    await f.write(MEM.checklist, CONTENT.checklist);
    await f.write(MEM.orion, "Alice owns Orion");
    const cursor = f.slice.indexProjection.cursor(WS);
    const orion = f.slice.indexProjection.revision(WS, MEM.orion);
    f.slice.database.connection.transaction(() => {
      f.slice.database.connection.prepare(`UPDATE memory_entries SET lifecycle_state='tombstone',
        retention_state='tombstoned', updated_at=updated_at WHERE object_id=?`).run(MEM.orion);
    })();
    expect(f.slice.indexProjection.freshness(WS, MEM.orion).lexical).toBe("tombstoned");
    expect(f.slice.indexProjection.freshness(WS, MEM.checklist).lexical).toBe("ready");
    const [first, second] = await Promise.all([
      f.slice.runRecall({ text: "Where is the deployment checklist?", familyCaps: { embedding: "unavailable" } }),
      f.slice.runRecall({ text: "Where is the deployment checklist?", familyCaps: { embedding: "unavailable" } })
    ]);
    expect(first.membership).toContain(MEM.checklist);
    expect(second.membership).toEqual(first.membership);
    const tombstoned = await f.slice.runRecall({
      text: "Alice owns Orion", familyCaps: { embedding: "unavailable", typed_relation: "unavailable" }
    });
    expect(tombstoned.membership).not.toContain(MEM.orion);
    expect(f.slice.indexProjection.cursor(WS)?.appliedEventRevision)
      .toBeGreaterThanOrEqual(cursor?.appliedEventRevision ?? 0);
    expect(orion?.tombstoned).toBe(0);
    expect(f.slice.indexProjection.revision(WS, MEM.orion)?.tombstoned).toBe(1);
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
    expect(first.selectionCount).toBe(1);
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
      rBase: 1, nBase: 1, k: 1
    });
    expect(truncated.pack.truncated).toBe(true);
    expect(truncated.pack.claims).toContainEqual({ kind: "truncated" });
    expect(truncated.pack.claims).not.toContainEqual(expect.objectContaining({ kind: "unsupported_exact_aggregate" }));
    const missingCap = await slice.runRecall({
      text: "Who is working remotely?", familyCaps: { embedding: "unavailable" }
    });
    expect(missingCap.pack.claims).toContainEqual({ kind: "capability_unavailable", capability: "embedding" });
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
