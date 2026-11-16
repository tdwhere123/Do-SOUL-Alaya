import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { createPreservationFixture, PRESERVATION_WORKSPACE as WS } from "./independent-preservation.test-support.js";

const fixtures: Awaited<ReturnType<typeof createPreservationFixture>>[] = [];
afterEach(async () => { for (const f of fixtures) await f.dispose(); fixtures.length = 0; });
async function fixture() { const f = await createPreservationFixture(); fixtures.push(f); return f; }

it("defers more than one batch of unsupported oldest tombstones once without starving newer proven GC", async () => {
  const f = await fixture();
  const published = await f.publishMember("eligible-newer", "retained newer material");
  const capsule = await f.createCapsule([published.memory.object_id]);
  const ids: string[] = [];
  for (let i = 0; i < 51; i++) {
    const id = randomUUID(); ids.push(id);
    await f.memoryEntryRepo.create({ ...published.memory, object_id: id, evidence_refs: [],
      lifecycle_state: "tombstone", retention_state: "tombstoned", forget_disposition: "compressed",
      forget_disposition_ref: "legacy-capsule-without-proof", updated_at: "2010-01-01T00:00:00.000Z" });
  }
  await f.sweep();
  expect(f.database.connection.prepare("SELECT COUNT(*) AS n FROM memory_gc_deferrals").get()).toEqual({ n: 0 });
  expect(await f.sweep(true)).toMatchObject({ success: true, objects_affected: [] });
  expect(f.database.connection.prepare("SELECT COUNT(*) AS n FROM memory_gc_deferrals").get()).toEqual({ n: 50 });
  expect(await f.sweep(true)).toMatchObject({ success: true, objects_affected: [published.memory.object_id] });
  expect(f.database.connection.prepare("SELECT COUNT(*) AS n FROM memory_gc_deferrals").get()).toEqual({ n: 51 });
  const audits = () => f.database.connection.prepare("SELECT COUNT(*) AS n FROM event_log WHERE json_extract(payload_json,'$.reason_code') LIKE 'preservation_revoked:%'").get();
  expect(audits()).toEqual({ n: 51 });
  expect(await f.sweep(true)).toMatchObject({ success: true, objects_affected: [] });
  expect(audits()).toEqual({ n: 51 });
  expect(await f.memoryService.autonomousHardDeleteTombstoned(ids[0]!, "direct retry", "deterministic_rule")).toBe(false);
  expect(audits()).toEqual({ n: 51 });
  expect(await f.synthesisService.readHistoricalMember(WS, capsule.object_id, published.memory.object_id)).toMatchObject({ status: "ready" });
  expect(f.database.connection.prepare("SELECT COUNT(*) AS n FROM memory_entries").get()).toEqual({ n: 51 });
  const reopened = f.reopen();
  expect(await reopened.sweep(true)).toMatchObject({ success: true, objects_affected: [] });
  expect(reopened.database.connection.prepare("SELECT COUNT(*) AS n FROM memory_gc_deferrals").get()).toEqual({ n: 51 });
});

it("rolls back a failed deferral audit and reconsiders a legitimately changed revision", async () => {
  const f = await fixture();
  const { memory } = await f.publishMember("deferred-source");
  f.database.connection.prepare("DELETE FROM source_statement_memory_bindings WHERE memory_id=?").run(memory.object_id);
  f.database.connection.prepare("UPDATE memory_entries SET lifecycle_state='tombstone',retention_state='tombstoned',forget_disposition='compressed',forget_disposition_ref='legacy' WHERE object_id=?")
    .run(memory.object_id);
  f.database.connection.exec("CREATE TRIGGER refuse_defer BEFORE INSERT ON memory_gc_deferrals BEGIN SELECT RAISE(ABORT,'deferral unavailable'); END");
  await expect(f.memoryService.autonomousHardDeleteTombstoned(memory.object_id, "GC", "deterministic_rule")).rejects.toThrow();
  expect(f.database.connection.prepare("SELECT COUNT(*) AS n FROM event_log WHERE json_extract(payload_json,'$.reason_code') LIKE 'preservation_revoked:%'").get()).toEqual({ n: 0 });
  f.database.connection.exec("DROP TRIGGER refuse_defer");
  expect(await f.memoryService.autonomousHardDeleteTombstoned(memory.object_id, "GC", "deterministic_rule")).toBe(false);
  f.database.connection.prepare("UPDATE memory_entries SET evidence_refs='[]',reinforcement_count=0,forget_disposition='judged_useless',forget_disposition_ref=NULL WHERE object_id=?")
    .run(memory.object_id);
  expect(f.database.connection.prepare("SELECT COUNT(*) AS n FROM memory_gc_deferrals").get()).toEqual({ n: 0 });
  expect(await f.memoryService.autonomousHardDeleteTombstoned(memory.object_id, "GC", "deterministic_rule")).toBe(true);
});

it("reports unsupported compressed membership as a Janitor skip without falling through to judged-useless", async () => {
  const f = await fixture();
  const { memory } = await f.publishMember("unsupported-member");
  await f.createCapsule([memory.object_id]);
  f.database.connection.prepare("DELETE FROM source_statement_memory_bindings WHERE memory_id=?").run(memory.object_id);
  const result = await f.sweep();
  expect(result).toMatchObject({ success: true, outcome: "skipped", objects_affected: [] });
  expect(await f.memoryService.findById(memory.object_id)).toMatchObject({ lifecycle_state: "dormant", forget_disposition: null });
  expect(f.database.connection.prepare("SELECT COUNT(*) AS n FROM historical_memory_captures").get()).toEqual({ n: 0 });
});
