import { dirname, join } from "node:path";
import pino from "pino";
import { afterEach, expect, it, vi } from "vitest";
import { EventPublisher } from "@do-soul/alaya-core";
import { GardenTaskKind, GardenTier, type GardenTaskDescriptor } from "@do-soul/alaya-protocol";
import { GardenScheduler } from "@do-soul/alaya-soul";
import { createGardenBackgroundDataPorts } from "@do-soul/alaya-storage";
import { createKnowledgeFoundation } from "../../../runtime/daemon/wiring/daemon-knowledge-foundation.js";
import { createDaemonRepositories } from "../../../runtime/daemon/wiring/daemon-repositories.js";
import { createGardenRuntimeEventLogPort, createGardenRuntimeJanitor } from "../../../garden/runtime/runtime-composition.js";
import { createGardenSchedulerEventLogPort, createHealthJournalPort } from "../../../garden/runtime/runtime-core-support.js";
import { createTombstoneDispositionSweepPort } from "../../../garden/support/forget-disposition-ports.js";
import { createRuntimeInput } from "../../garden/runtime-fixture.js";
import { createPreservationFixture, PRESERVATION_CLOCK, PRESERVATION_RUN,
  PRESERVATION_WORKSPACE as WS } from "../../garden/independent-preservation.test-support.js";

const fixtures: Awaited<ReturnType<typeof createPreservationFixture>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const f of fixtures) await f.dispose();
  fixtures.length = 0;
});

async function fixture() {
  // Date-only clock control dates the real terminal transition past SQLite's real
  // 24-hour grace. Never rewrite a captured member or bypass its revision guard.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(PRESERVATION_CLOCK);
  const f = await createPreservationFixture();
  fixtures.push(f);
  const logger = pino({ enabled: false });
  const repositories = createDaemonRepositories({ database: f.database, warn: logger.warn.bind(logger) });
  const runtimeNotifier = { notify: vi.fn(), notifyEntry: f.notifier.notifyEntry };
  const eventPublisher = new EventPublisher({ eventLogRepo: repositories.eventLogRepo,
    runtimeNotifier, runHotStateService: { apply: vi.fn() } });
  const root = dirname(f.database.filename);
  const foundation = createKnowledgeFoundation({ ...repositories, database: f.database,
    runtimeNotifier, filesDirectory: root, warnLogger: logger,
    configPaths: { configDir: root, tomlPath: join(root, "config.toml"), envPath: join(root, ".env"),
      auditDir: join(root, "audit"), secretsDir: join(root, "secrets"), operationsDir: join(root, "operations") }
  }, eventPublisher);
  async function member(sourceId: string) {
    // Reuse native source publication only; capsule creation, adoption and GC all
    // use the actual daemon foundation services, not the fixture's MemoryService.
    const { memory } = await f.publishMember(sourceId);
    const capsule = await foundation.synthesisService.create({ created_by: "deterministic_rule",
      topic_key: sourceId, synthesis_type: "cross_evidence", summary: "Organizing summary, not retained content",
      evidence_refs: [], source_memory_refs: [memory.object_id], workspace_id: WS, run_id: PRESERVATION_RUN });
    const dormant = await foundation.memoryService.findById(memory.object_id);
    if (dormant === null) throw new Error("published dormant member missing");
    return { memory: dormant, capsule };
  }
  async function adopt(sourceId: string) {
    const published = await member(sourceId);
    await foundation.memoryService.autonomousTombstone(published.memory.object_id, "compressed",
      published.capsule.object_id, "retain independent history", "deterministic_rule");
    return published;
  }
  return { ...f, repositories, foundation, eventPublisher, member, adopt };
}

it("the assembled daemon adopts proof and physically deletes a past-grace member without losing its history", async () => {
  const f = await fixture();
  const { memory, capsule } = await f.adopt("daemon-retained-source");
  expect(await f.foundation.memoryService.findById(memory.object_id)).toMatchObject({
    lifecycle_state: "tombstone", forget_disposition: "compressed", updated_at: PRESERVATION_CLOCK });
  expect(await f.foundation.synthesisService.readHistoricalMember(WS, capsule.object_id, memory.object_id))
    .toMatchObject({ status: "ready", history: { member: memory } });
  vi.useRealTimers();
  expect(await f.foundation.memoryService.autonomousHardDeleteTombstoned(memory.object_id, "GC", "deterministic_rule"))
    .toBe(true);
  expect(await f.repositories.memoryEntryRepo.findById(memory.object_id)).toBeNull();
  expect(await f.foundation.synthesisService.readHistoricalMember(WS, capsule.object_id, memory.object_id))
    .toMatchObject({ status: "ready", history: { member: memory } });
  const events = await f.repositories.eventLogRepo.queryByEntityAll("memory_entry", memory.object_id);
  expect(events.filter(event => event.payload_json.to_state === "deleted")).toHaveLength(1);
  expect(events.find(event => event.payload_json.preservation)?.payload_json.preservation)
    .toMatchObject({ capsule_id: capsule.object_id, schema_version: 1 });
  expect(f.notifications.every(notification => notification.committed)).toBe(true);
});

it("the assembled daemon refuses compressed GC when historical proof is absent", async () => {
  const f = await fixture();
  const { memory, capsule } = await f.member("legacy-without-capture");
  const id = memory.object_id;
  // Simulate an imported legacy compressed marker: membership is not a proof.
  f.database.connection.prepare(`UPDATE memory_entries SET lifecycle_state='tombstone',
    retention_state='tombstoned',forget_disposition='compressed',forget_disposition_ref=? WHERE object_id=?`)
    .run(capsule.object_id, id);
  expect(await f.foundation.synthesisService.readHistoricalMember(WS, capsule.object_id, id)).toEqual({ status: "missing" });
  expect(await f.foundation.memoryService.autonomousHardDeleteTombstoned(id, "GC", "deterministic_rule")).toBe(false);
  expect(await f.repositories.memoryEntryRepo.findById(id)).not.toBeNull();
  const events = await f.repositories.eventLogRepo.queryByEntityAll("memory_entry", id);
  expect(events.filter(event => event.payload_json.to_state === "deleted")).toEqual([]);
  expect(events.filter(event => String(event.payload_json.reason_code).startsWith("preservation_revoked:"))).toHaveLength(1);
});

it("the assembled daemon propagates historical-reader failure without deleting or caching it as missing proof", async () => {
  const f = await fixture();
  const { memory } = await f.adopt("reader-failure");
  vi.spyOn(f.repositories.synthesisCapsuleRepo, "readHistoricalMember")
    .mockRejectedValueOnce(new Error("historical read unavailable"));
  await expect(f.foundation.memoryService.autonomousHardDeleteTombstoned(memory.object_id, "GC", "deterministic_rule"))
    .rejects.toThrow("historical read unavailable");
  expect(await f.repositories.memoryEntryRepo.findById(memory.object_id)).not.toBeNull();
  expect(f.database.connection.prepare("SELECT COUNT(*) AS n FROM memory_gc_deferrals").get()).toEqual({ n: 0 });
  expect(await f.foundation.memoryService.autonomousHardDeleteTombstoned(memory.object_id, "GC", "deterministic_rule"))
    .toBe(true);
});

it("the production Janitor defaults to deferred GC while retaining foundation disposition success and skip audits", async () => {
  const f = await fixture();
  const supported = await f.member("supported-disposition");
  const unsupported = await f.member("unsupported-disposition");
  f.database.connection.prepare("DELETE FROM source_statement_memory_bindings WHERE memory_id=?")
    .run(unsupported.memory.object_id);
  const authority = f.foundation.memoryService;
  const hardDelete = vi.spyOn(authority, "autonomousHardDeleteTombstoned");
  const scheduler = new GardenScheduler(createGardenSchedulerEventLogPort(f.eventPublisher));
  const report = vi.spyOn(scheduler, "reportCompletion").mockResolvedValue(undefined);
  const janitor = createGardenRuntimeJanitor({
    ...createRuntimeInput(), now: () => PRESERVATION_CLOCK,
    eventPublisher: f.eventPublisher, eventLogRepo: f.repositories.eventLogRepo,
    gardenDataPorts: createGardenBackgroundDataPorts(f.database),
    tombstoneDispositionSweepPort: createTombstoneDispositionSweepPort({
      memoryLookup: f.repositories.memoryEntryRepo, capsuleLookup: f.repositories.synthesisCapsuleRepo,
      tombstoneAuthority: { autonomousTombstone: authority.autonomousTombstone.bind(authority),
        autonomousHardDeleteTombstoned: authority.autonomousHardDeleteTombstoned.bind(authority),
        findTombstonedMemoriesWithDisposition: f.repositories.memoryEntryRepo.findTombstonedMemoriesWithDisposition.bind(f.repositories.memoryEntryRepo) }
    })
  }, scheduler, createHealthJournalPort(f.repositories.healthJournalRepo), createGardenRuntimeEventLogPort);
  const task: GardenTaskDescriptor = { task_id: "foundation-disposition", task_kind: GardenTaskKind.TOMBSTONE_GC,
    required_tier: GardenTier.TIER_0, workspace_id: WS, run_id: PRESERVATION_RUN,
    target_object_refs: [], priority: 10, created_at: PRESERVATION_CLOCK };
  const result = await janitor.run(task);
  expect(result).toMatchObject({ success: true, objects_affected: [supported.memory.object_id], audit_entries: [
    `[SKIPPED] disposition_sweep: ${unsupported.memory.object_id} independent historical preservation unavailable (kept)`,
    "disposition_sweep: 1 dormant memories autonomously tombstoned (1 retained, no disposition or strong ref)",
    "[DEFERRED] tombstone_gc: temporal_assertion_provenance_required"
  ] });
  expect(hardDelete).not.toHaveBeenCalled();
  expect(await authority.findById(supported.memory.object_id)).toMatchObject({ lifecycle_state: "tombstone" });
  expect(await authority.findById(unsupported.memory.object_id)).toMatchObject({ lifecycle_state: "dormant", forget_disposition: null });
  const events = await f.repositories.eventLogRepo.queryByTypeAll("soul.memory.state_changed");
  expect(events.filter(event => event.payload_json.to_state === "tombstone").map(event => event.entity_id))
    .toEqual([supported.memory.object_id]);
  expect(events.filter(event => event.payload_json.to_state === "deleted")).toEqual([]);
  expect(report).toHaveBeenCalledExactlyOnceWith(result);
});
