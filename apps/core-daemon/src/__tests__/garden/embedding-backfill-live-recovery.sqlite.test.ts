import { afterEach, expect, it } from "vitest";
import { GardenEventType } from "@do-soul/alaya-protocol";
import { initDatabase, type StorageDatabase } from "@do-soul/alaya-storage";
import { createFaults, createHandoffRuntime, seedHandoffData, WORKSPACE } from "./embedding-backfill-follow-up-fixture.js";

const databases = new Set<StorageDatabase>();
afterEach(() => { for (const database of databases) database.close(); databases.clear(); });

async function fixture() {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  await seedHandoffData(database);
  const faults = createFaults();
  const harness = createHandoffRuntime(database, faults);
  const services = (harness.runtime.backgroundManager as unknown as {
    services: readonly { name: string; task(): Promise<void> }[];
  }).services;
  return { database, faults, ...harness, ordinaryPass: services.find(service => service.name === "GardenScheduler")!.task };
}

function state(database: StorageDatabase) {
  return database.connection.prepare(`SELECT r.state, r.owner_token, t.status, t.outcome
    FROM garden_embedding_backfill_runs r JOIN garden_tasks t ON t.id = r.task_id`).get();
}

async function assertCompleted(harness: Awaited<ReturnType<typeof fixture>>) {
  expect(state(harness.database)).toEqual({ state: "completed", owner_token: null, status: "completed", outcome: "completed" });
  expect(harness.database.connection.prepare("SELECT COUNT(*) AS n FROM memory_embeddings").get()).toEqual({ n: 3 });
  expect(harness.database.connection.prepare("SELECT COUNT(*) AS n FROM relation_assertions").get()).toEqual({ n: 3 });
  expect(harness.faults.embedCalls).toBe(1);
  expect((await harness.eventLog.queryByType("relation.assertion_admitted")).events).toHaveLength(3);
  expect((await harness.eventLog.queryByType(GardenEventType.SOUL_GARDEN_TASK_COMPLETED)).events).toHaveLength(1);
}

it("resumes a settled failed handoff on a later ordinary pass without a process restart", async () => {
  const harness = await fixture();
  harness.faults.failPendingAudit = true;
  await expect(harness.runtime.runEmbeddingBackfillPass(WORKSPACE)).rejects.toThrow(/pending audit failure/);
  expect(state(harness.database)).toEqual({ state: "backfilling", owner_token: null, status: "pending", outcome: null });
  await harness.ordinaryPass();
  await assertCompleted(harness);
});

it.each([false, true])("recovers exhausted parent completion audits on a later targeted pass (failed follow-up: %s)", async failedFollowUp => {
  const harness = await fixture();
  harness.faults.failTaskCompletionAudits = 2;
  if (failedFollowUp) harness.faults.failAdmissionAt = 2;
  await expect(harness.runtime.runEmbeddingBackfillPass(WORKSPACE)).rejects.toThrow(/completion persistence failed/);
  expect(state(harness.database)).toEqual({ state: failedFollowUp ? "pending" : "completed",
    owner_token: null, status: "pending", outcome: null });
  harness.faults.failAdmissionAt = null;
  await harness.runtime.runEmbeddingBackfillPass(WORKSPACE);
  await assertCompleted(harness);
});

it("retains the fence while recovery audits fail, then retries the known-quiescent owner on an ordinary pass", async () => {
  const harness = await fixture();
  harness.faults.failPendingAudit = true;
  harness.faults.failSettledRecoveryAudits = 2;
  await expect(harness.runtime.runEmbeddingBackfillPass(WORKSPACE)).rejects.toThrow(/recovery remains pending/);
  const before = state(harness.database);
  expect(before).toMatchObject({ state: "backfilling", owner_token: expect.any(String), status: "claimed", outcome: null });
  await expect(harness.ordinaryPass()).rejects.toThrow(/settled recovery audit failure/);
  expect(state(harness.database)).toEqual(before);
  expect((await harness.eventLog.queryByType(GardenEventType.SOUL_GARDEN_EMBEDDING_FOLLOW_UP)).events).toHaveLength(0);
  await harness.ordinaryPass();
  await assertCompleted(harness);
});

it("recovers a settled retry whose fence release fails without changing its failed parent receipt", async () => {
  const harness = await fixture();
  harness.faults.failAdmissionAt = 2;
  await expect(harness.runtime.runEmbeddingBackfillPass(WORKSPACE)).rejects.toThrow(/follow_up_failed/);
  const receipt = (await harness.eventLog.queryByType(GardenEventType.SOUL_GARDEN_TASK_COMPLETED)).events[0];
  harness.faults.failAdmissionAt = null;
  harness.database.connection.exec(`CREATE TRIGGER fail_owner_release BEFORE UPDATE OF owner_token
    ON garden_embedding_backfill_runs WHEN NEW.owner_token IS NULL
    BEGIN SELECT RAISE(ABORT, 'release unavailable'); END`);
  await expect(harness.runtime.runEmbeddingBackfillPass(WORKSPACE)).rejects.toThrow(/release unavailable/);
  expect(state(harness.database)).toMatchObject({ state: "completed", owner_token: expect.any(String), status: "failed", outcome: "failed" });
  harness.database.connection.exec("DROP TRIGGER fail_owner_release");
  await harness.ordinaryPass();
  expect(state(harness.database)).toEqual({ state: "completed", owner_token: null, status: "failed", outcome: "failed" });
  expect((await harness.eventLog.queryByType(GardenEventType.SOUL_GARDEN_TASK_COMPLETED)).events).toEqual([receipt]);
  expect((await harness.eventLog.queryByType("relation.assertion_admitted")).events).toHaveLength(3);
  expect(harness.faults.embedCalls).toBe(1);
});

it("does not treat a still-running accepted writer as quiescent when a peer pass fails", async () => {
  const harness = await fixture();
  let unblock!: () => void;
  let announce!: () => void;
  const started = new Promise<void>(resolve => { announce = resolve; });
  harness.faults.pauseUntil = new Promise<void>(resolve => { unblock = resolve; });
  harness.faults.pauseStarted = announce;
  harness.faults.pauseAdmissionAt = 1;
  const active = harness.runtime.runEmbeddingBackfillPass(WORKSPACE);
  await started;
  try {
    const before = state(harness.database);
    await expect(harness.runtime.runEmbeddingBackfillPass(WORKSPACE)).rejects.toThrow(/already owned/);
    await harness.ordinaryPass();
    expect(state(harness.database)).toEqual(before);
    expect((await harness.eventLog.queryByType(GardenEventType.SOUL_GARDEN_EMBEDDING_FOLLOW_UP)).events
      .some(event => event.payload_json.disposition === "recovered")).toBe(false);
  } finally { unblock(); await active; }
  await assertCompleted(harness);
});
