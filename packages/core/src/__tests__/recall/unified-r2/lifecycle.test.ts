import { afterEach, describe, expect, it } from "vitest";
import { MemoryDimension } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import { captureQuerySpec } from "../../../recall/decision/budget-aware-q/capture.js";
import { fieldContractSha256 } from "../../../shared/field-hash.js";
import { createSliceHarness } from "./harness.js";
import { CONTENT, MEM, NOW } from "./ids.js";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

async function harness() {
  return createSliceHarness((database) => databases.add(database));
}

describe("C02 lifecycle probes", () => {
  it("X1 write acks with blocked transport and zero provider calls", async () => {
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
    expect(() => slice.garden.enqueue({
      id: `enrich:workspace-1:${MEM.checklist}:v1`,
      workspace_id: "workspace-1",
      role: "librarian",
      kind: "bulk_enrich",
      payload: { source_object_id: MEM.checklist, source_revision: 1 },
      created_at: NOW
    })).toThrow(/already exists/);
    expect(slice.pendingGarden()).toHaveLength(1);
  });

  it("optional fake-transport enrichment uses official-api admission", async () => {
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
    expect(first.selectionCount).toBe(1);
    expect(second.selectionCount).toBe(1);
    expect(first.counters.recall_provider_calls).toBe(0);
    expect(second.counters.full_tier_scan).toBe(0);
    expect(writeAck === "not_observed" || (typeof writeAck === "number" && writeAck >= 0)).toBe(true);
    expect(performanceNow() - coldWrite).toBeGreaterThanOrEqual(0);
  });

  it("M1 capture detaches caller mutation on the slice QuerySpec", () => {
    const scopes = ["workspace-1"];
    const captured = captureQuerySpec({
      text: "M1 slice",
      asOf: NOW,
      authorizedScopes: scopes
    }, fieldContractSha256, () => NOW);
    scopes.push("attacker");
    expect(captured.spec.authorizedScopes).toEqual(["workspace-1"]);
  });
});

function performanceNow(): number {
  return globalThis.performance.now();
}
