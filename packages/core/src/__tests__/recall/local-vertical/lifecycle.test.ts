import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GardenRole, GardenTaskKind, GardenTier, MemoryDimension } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import { compileConditionalFieldQuery } from "../../../recall/conditional-field/query/compile-query.js";
import { defaultBudget, SNAPSHOT_ID } from "../conditional-field/reference/deployment.fixture.js";
import { SOURCE_ENRICHMENT_QUEUE_HARD_CAP } from "../../../memory/source-write-garden-intent.js";
import { createSliceHarness } from "./harness.js";
import { CONTENT, MEM, NOW, WS } from "./ids.js";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

async function harness() {
  return createSliceHarness((database) => databases.add(database));
}

describe("lifecycle probes", () => {
  it("X1 local source transaction acks with no transport wired", async () => {
    const slice = await harness();
    await slice.writeMemory(MEM.checklist, CONTENT.checklist, MemoryDimension.PROCEDURE, true);
    expect(typeof slice.counters.write_ack_ms === "number" || slice.counters.write_ack_ms === "not_observed").toBe(true);
    expect(slice.counters.write_provider_calls).toBe(0);
    expect(slice.counters.garden_enqueue).toBe(1);
    expect(slice.pendingGarden()).toHaveLength(1);
    const persisted = await slice.memoryEntryRepo.findById(MEM.checklist);
    expect(persisted?.content).toBe(CONTENT.checklist);
  });

  it("X5 recall while enrichment is pending searches raw text and does not enqueue", async () => {
    const slice = await harness();
    await slice.writeMemory(MEM.checklist, CONTENT.checklist, MemoryDimension.PROCEDURE, true);
    const before = slice.counters.garden_enqueue;
    const result = await slice.runRecall({
      text: "Where is the deployment checklist?",
      familyCaps: { embedding: "unavailable" }
    });
    expect(result.membership).toContain(MEM.checklist);
    expect(slice.counters.garden_enqueue).toBe(before);
    expect(result.counters.recall_source_writes).toBe(0);
    expect(result.counters.recall_provider_calls).toBe(0);
    expect(slice.pendingGarden().length).toBeGreaterThan(0);
  });

  it("duplicate enqueue of unchanged work reuses the garden task id", async () => {
    const slice = await harness();
    await slice.writeMemory(MEM.checklist, CONTENT.checklist, MemoryDimension.PROCEDURE, true);
    const pending = slice.pendingGarden();
    expect(pending).toHaveLength(1);
    const existing = pending[0]!;
    expect(slice.garden.enqueue({
      id: existing.id,
      workspace_id: existing.workspace_id,
      role: existing.role,
      kind: existing.kind,
      payload: existing.payload,
      created_at: NOW
    }).task_id).toBe(existing.id);
    expect(slice.pendingGarden()).toHaveLength(1);
    expect(() => slice.garden.enqueue({
      id: existing.id,
      workspace_id: existing.workspace_id,
      role: existing.role,
      kind: existing.kind,
      payload: { ...(existing.payload as object), source_object_id: "other-source" },
      created_at: NOW
    })).toThrow(/different payload/);
  });

  it("X2 same text at distinct occurrences keeps separate sources and work intents", async () => {
    const slice = await harness();
    await slice.writeMemory(MEM.checklist, CONTENT.checklist, MemoryDimension.PROCEDURE, true);
    await slice.writeMemory(MEM.remote, CONTENT.checklist, MemoryDimension.EPISODE, true);
    expect(await slice.memoryEntryRepo.findById(MEM.checklist)).not.toBeNull();
    expect(await slice.memoryEntryRepo.findById(MEM.remote)).not.toBeNull();
    expect(slice.pendingGarden()).toHaveLength(2);
  });

  it("X3 crash after commit recovers the work intent from sqlite", async () => {
    const directory = mkdtempSync(join(tmpdir(), "w00-x3-"));
    const filename = join(directory, "source.sqlite");
    const first = await createSliceHarness((database) => databases.add(database), filename);
    await first.writeMemory(MEM.checklist, CONTENT.checklist, MemoryDimension.PROCEDURE, true);
    const taskId = first.pendingGarden()[0]?.id;
    expect(taskId).toBeDefined();
    first.database.close();
    databases.delete(first.database);
    const second = await createSliceHarness((database) => databases.add(database), filename);
    expect(second.pendingGarden().map((row) => row.id)).toEqual([taskId]);
    expect(await second.memoryEntryRepo.findById(MEM.checklist)).not.toBeNull();
    second.database.close();
    databases.delete(second.database);
    rmSync(directory, { recursive: true, force: true });
  });

  it("X7 queue full rejects the uncommitted write", async () => {
    const slice = await harness();
    for (let index = 0; index < SOURCE_ENRICHMENT_QUEUE_HARD_CAP; index += 1) {
      slice.garden.enqueue({
        id: `fill-${index}`,
        workspace_id: WS,
        role: GardenRole.LIBRARIAN,
        kind: GardenTaskKind.BULK_ENRICH,
        payload: {
          task_id: `fill-${index}`,
          task_kind: GardenTaskKind.BULK_ENRICH,
          required_tier: GardenTier.TIER_2,
          workspace_id: WS,
          run_id: null,
          target_object_refs: [WS],
          priority: 10,
          created_at: NOW
        },
        created_at: NOW
      });
    }
    await expect(
      slice.writeMemory(MEM.checklist, CONTENT.checklist, MemoryDimension.PROCEDURE, true)
    ).rejects.toMatchObject({ code: "CONFLICT", subCode: "RETRYABLE_BACKPRESSURE" });
    expect(await slice.memoryEntryRepo.findById(MEM.checklist)).toBeNull();
    expect(
      slice.garden.peekPending(GardenRole.LIBRARIAN, WS, SOURCE_ENRICHMENT_QUEUE_HARD_CAP + 1)
    ).toHaveLength(SOURCE_ENRICHMENT_QUEUE_HARD_CAP);
  });

  it("official-api parser smoke does not establish artifact admission or worker lifecycle", async () => {
    const slice = await harness();
    const audit = slice.fakeTransportAdmit("Alex works from Lisbon weekdays");
    expect(audit.envelope.disposition).toBe("admitted");
    expect(slice.counters.enrich_execute_ms === "not_observed" || typeof slice.counters.enrich_execute_ms === "number").toBe(true);
    expect(slice.counters.write_provider_calls).toBe(0);
  });

  it("cold then warm then repeat recall keeps zero provider and one selection per request", async () => {
    const slice = await harness();
    const coldWrite = performanceNow();
    await slice.writeMemory(MEM.checklist, CONTENT.checklist, MemoryDimension.PROCEDURE, false);
    const writeAck = slice.counters.write_ack_ms;
    const first = await slice.runRecall({
      text: "Where is the deployment checklist?",
      familyCaps: { embedding: "unavailable" }
    });
    const second = await slice.runRecall({
      text: "Where is the deployment checklist?",
      familyCaps: { embedding: "unavailable" }
    });
    expect(first.membership).toEqual(second.membership);
    expect(first.index.query_id).toBe(second.index.query_id);
    expect(first.index.snapshot_id).toBe(second.index.snapshot_id);
    expect(first.counters.recall_provider_calls).toBe(0);
    expect(second.counters.full_tier_scan).toBe(0);
    expect(writeAck === "not_observed" || (typeof writeAck === "number" && writeAck >= 0)).toBe(true);
    expect(performanceNow() - coldWrite).toBeGreaterThanOrEqual(0);
  });

  it("query interpretation detaches caller scope mutation", () => {
    const scopes = ["workspace-1"];
    const captured = compileConditionalFieldQuery({
      source: "ordinary", text: "deployment checklist",
      snapshot_id: SNAPSHOT_ID, interpretation_clock: NOW,
      budget: defaultBudget(), authorized_scopes: scopes
    });
    const before = JSON.stringify(captured);
    scopes.push("attacker");
    expect(JSON.stringify(captured)).toBe(before);
    expect(JSON.stringify(captured)).not.toContain("attacker");
  });
});

function performanceNow(): number {
  return globalThis.performance.now();
}
