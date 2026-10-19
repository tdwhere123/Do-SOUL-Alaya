import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type EventLogEntry, type Slot } from "@do-soul/alaya-protocol";
import { SqliteConflictMatrixRepo, SqliteSlotRepo, type StorageDatabase } from "@do-soul/alaya-storage";
import { ClaimService } from "../../governance/claims/claim-service.js";
import { ArbitrationService } from "../../governance/proposals/arbitration-service.js";
import { EventPublisher } from "../../runtime/event-publisher.js";
import { createResolutionServiceRealStorage } from "../shared/real-sqlite.test-support.js";
import { createClaimForm } from "./claim-service.test-support.js";

const CLAIM_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLAIM_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SLOT_ID = "33333333-3333-4333-8333-333333333333";
const EDGE_ID = "11111111-1111-4111-8111-111111111111";
const CHANGED_AT = "2026-03-21T01:00:00.000Z";
const databases: StorageDatabase[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function createRuntime(filename = ":memory:") {
  const storage = await createResolutionServiceRealStorage(database => databases.push(database), filename);
  const slotRepo = new SqliteSlotRepo(storage.database);
  const conflictMatrixRepo = new SqliteConflictMatrixRepo(storage.database);
  const notifyEntry = vi.fn((_entry: EventLogEntry) => {
    expect(storage.database.connection.inTransaction).toBe(false);
  });
  const runtimeNotifier = { notify: () => undefined, notifyEntry };
  const eventPublisher = new EventPublisher({ eventLogRepo: storage.eventLogRepo,
    runtimeNotifier, runHotStateService: { apply: () => undefined } });
  const claimService = new ClaimService({ ...storage, eventPublisher, runtimeNotifier, now: () => CHANGED_AT });
  const arbitration = new ArbitrationService({ slotRepo, conflictMatrixRepo, claimService,
    claimRepo: storage.claimFormRepo, eventLogRepo: storage.eventLogRepo, runtimeNotifier, now: () => CHANGED_AT });
  return { ...storage, slotRepo, conflictMatrixRepo, claimService, arbitration, notifyEntry };
}

function seed(runtime: Awaited<ReturnType<typeof createRuntime>>, winnerClaimId: string | null = CLAIM_A,
  challengerStatus: "active" | "contested" = "contested") {
  const incumbent = createClaimForm({ object_id: CLAIM_A,
    claim_status: winnerClaimId === null ? "contested" : "winner" });
  runtime.claimFormRepo.create(incumbent);
  runtime.claimFormRepo.create(createClaimForm({ object_id: CLAIM_B, claim_status: challengerStatus }));
  const slot: Slot = {
    object_id: SLOT_ID, object_kind: "slot", schema_version: 1, lifecycle_state: "active",
    created_at: incumbent.created_at, updated_at: incumbent.updated_at, created_by: "system",
    governance_subject: incumbent.governance_subject, claim_kind: incumbent.claim_kind,
    scope_class: incumbent.scope_class, workspace_id: incumbent.workspace_id,
    winner_claim_id: winnerClaimId, incumbent_since: winnerClaimId === null ? null : incumbent.created_at,
    flip_conditions: []
  };
  runtime.slotRepo.create(slot);
  runtime.conflictMatrixRepo.create({ object_id: EDGE_ID,
    object_kind: "conflict_matrix_edge", schema_version: 1, lifecycle_state: "active",
    created_at: incumbent.created_at, updated_at: incumbent.updated_at, created_by: "user_action",
    source_claim_id: CLAIM_B, target_claim_id: CLAIM_A, edge_type: "supersedes", workspace_id: incumbent.workspace_id });
}

describe("ArbitrationService atomic SQLite winner changes", () => {
  it("rolls back both claim transitions and every audit when the slot write fails, then retries as one committed batch", async () => {
    const runtime = await createRuntime();
    seed(runtime);
    runtime.database.connection.exec(`
      CREATE TRIGGER reject_slot_change BEFORE UPDATE ON slots
      BEGIN SELECT RAISE(ABORT, 'slot write refused'); END;
    `);

    await expect(runtime.arbitration.arbitrateSlot(SLOT_ID)).rejects.toMatchObject({ code: "QUERY_FAILED" });
    expect((await runtime.claimFormRepo.findById(CLAIM_A))?.claim_status).toBe("winner");
    expect((await runtime.claimFormRepo.findById(CLAIM_B))?.claim_status).toBe("contested");
    expect((await runtime.slotRepo.findById(SLOT_ID))?.winner_claim_id).toBe(CLAIM_A);
    expect(await runtime.eventLogRepo.queryByEntity("claim_form", CLAIM_A)).toEqual([]);
    expect(await runtime.eventLogRepo.queryByEntity("claim_form", CLAIM_B)).toEqual([]);
    expect(await runtime.eventLogRepo.queryByEntity("slot", SLOT_ID)).toEqual([]);
    expect(runtime.notifyEntry).not.toHaveBeenCalled();

    runtime.database.connection.exec("DROP TRIGGER reject_slot_change");
    runtime.notifyEntry.mockImplementation(async () => {
      expect(runtime.database.connection.inTransaction).toBe(false);
      expect((await runtime.claimFormRepo.findById(CLAIM_A))?.claim_status).toBe("superseded");
      expect((await runtime.claimFormRepo.findById(CLAIM_B))?.claim_status).toBe("winner");
      expect((await runtime.slotRepo.findById(SLOT_ID))?.winner_claim_id).toBe(CLAIM_B);
      expect(await runtime.eventLogRepo.queryByEntity("slot", SLOT_ID)).toHaveLength(1);
    });
    await expect(runtime.arbitration.arbitrateSlot(SLOT_ID)).resolves.toMatchObject({
      decision: "winner_changed", winner_claim_id: CLAIM_B, slot: { winner_claim_id: CLAIM_B }
    });
    expect(runtime.notifyEntry.mock.calls.map(([entry]) => [entry.event_type, entry.entity_id])).toEqual([
      ["soul.claim.lifecycle_changed", CLAIM_A], ["soul.claim.lifecycle_changed", CLAIM_B],
      ["soul.slot.winner_changed", SLOT_ID]
    ]);
    const incumbentAudits = await runtime.eventLogRepo.queryByEntity("claim_form", CLAIM_A);
    const winnerAudits = await runtime.eventLogRepo.queryByEntity("claim_form", CLAIM_B);
    const slotAudits = await runtime.eventLogRepo.queryByEntity("slot", SLOT_ID);
    expect(incumbentAudits).toHaveLength(1);
    expect(incumbentAudits[0]?.payload_json).toMatchObject({ from_state: "winner", to_state: "superseded",
      reason_code: "arbitration_superseded", caused_by: "system", occurred_at: CHANGED_AT });
    expect(winnerAudits).toHaveLength(1);
    expect(winnerAudits[0]?.payload_json).toMatchObject({ from_state: "contested", to_state: "winner",
      reason_code: "arbitration_winner", caused_by: "system", occurred_at: CHANGED_AT });
    expect(slotAudits).toHaveLength(1);
    expect(slotAudits[0]?.payload_json).toMatchObject({ from_claim_id: CLAIM_A, to_claim_id: CLAIM_B,
      reason_code: "arbitration_decisive_edge_priority", caused_by: "system", occurred_at: CHANGED_AT });
  });

  it("rejects an independently interleaved empty-slot contender and rolls back its distinct claim promotion", async () => {
    const directory = mkdtempSync(join(tmpdir(), "arbitration-contenders-"));
    directories.push(directory);
    const filename = join(directory, "state.sqlite");
    const first = await createRuntime(filename);
    seed(first, null);
    const second = await createRuntime(filename);
    let captured!: () => void;
    let resume!: () => void;
    const prepared = new Promise<void>(resolve => { captured = resolve; });
    const released = new Promise<void>(resolve => { resume = resolve; });
    const prepare = first.claimService.prepareLifecycleTransition.bind(first.claimService);
    vi.spyOn(first.claimService, "prepareLifecycleTransition").mockImplementationOnce(async (...args) => {
      const transition = await prepare(...args);
      captured();
      await released;
      return transition;
    });
    const losingResult = first.arbitration.resolveSlotConflict(SLOT_ID, CLAIM_A, "workspace-1");
    // Attach rejection handling before releasing the independently prepared contender.
    const rejection = expect(losingResult).rejects.toMatchObject({ code: "CONFLICT" });
    await prepared;
    try {
      await expect(second.arbitration.resolveSlotConflict(SLOT_ID, CLAIM_B, "workspace-1"))
        .resolves.toMatchObject({ winner_claim_id: CLAIM_B });
    } finally {
      resume();
    }
    await rejection;

    expect((await first.claimFormRepo.findById(CLAIM_A))?.claim_status).toBe("contested");
    expect((await first.claimFormRepo.findById(CLAIM_B))?.claim_status).toBe("winner");
    expect((await first.slotRepo.findById(SLOT_ID))?.winner_claim_id).toBe(CLAIM_B);
    expect(await first.eventLogRepo.queryByEntity("claim_form", CLAIM_A)).toEqual([]);
    expect(await first.eventLogRepo.queryByEntity("claim_form", CLAIM_B)).toHaveLength(1);
    const slotAudits = await first.eventLogRepo.queryByEntity("slot", SLOT_ID);
    expect(slotAudits).toHaveLength(1);
    expect(slotAudits[0]?.payload_json).toMatchObject({ from_claim_id: null, to_claim_id: CLAIM_B,
      reason_code: "manual_resolution", caused_by: "review" });
    expect(first.notifyEntry).not.toHaveBeenCalled();
    expect(second.notifyEntry).toHaveBeenCalledTimes(2);
  });

  it("refuses the illegal active-to-winner transition before superseding the incumbent or writing audits", async () => {
    const runtime = await createRuntime();
    seed(runtime, CLAIM_A, "active");
    await expect(runtime.arbitration.arbitrateSlot(SLOT_ID)).rejects.toMatchObject({
      code: "VALIDATION", message: "Invalid claim lifecycle transition: active -> winner"
    });
    expect((await runtime.claimFormRepo.findById(CLAIM_A))?.claim_status).toBe("winner");
    expect((await runtime.claimFormRepo.findById(CLAIM_B))?.claim_status).toBe("active");
    expect((await runtime.slotRepo.findById(SLOT_ID))?.winner_claim_id).toBe(CLAIM_A);
    expect(await runtime.eventLogRepo.queryByEntity("claim_form", CLAIM_A)).toEqual([]);
    expect(await runtime.eventLogRepo.queryByEntity("claim_form", CLAIM_B)).toEqual([]);
    expect(await runtime.eventLogRepo.queryByEntity("slot", SLOT_ID)).toEqual([]);
    expect(runtime.notifyEntry).not.toHaveBeenCalled();
  });

  it("returns the committed winner and continues ordered propagation when a lifecycle listener fails", async () => {
    const runtime = await createRuntime();
    seed(runtime);
    runtime.notifyEntry.mockImplementation(entry => {
      expect(runtime.database.connection.inTransaction).toBe(false);
      if (entry.entity_id === CLAIM_A && entry.event_type === "soul.claim.lifecycle_changed") {
        throw new Error("incumbent listener offline");
      }
    });
    await expect(runtime.arbitration.arbitrateSlot(SLOT_ID)).resolves.toMatchObject({
      decision: "winner_changed", winner_claim_id: CLAIM_B, slot: { winner_claim_id: CLAIM_B }
    });
    expect((await runtime.claimFormRepo.findById(CLAIM_A))?.claim_status).toBe("superseded");
    expect((await runtime.claimFormRepo.findById(CLAIM_B))?.claim_status).toBe("winner");
    const incumbentAudits = await runtime.eventLogRepo.queryByEntity("claim_form", CLAIM_A);
    expect(incumbentAudits.map(entry => entry.event_type)).toEqual([
      "soul.claim.lifecycle_changed", "runtime.side_effect_failed"
    ]);
    expect(incumbentAudits[1]?.payload_json).toMatchObject({ operation: "post_commit_propagation",
      committed_event_id: incumbentAudits[0]?.event_id });
    expect(await runtime.eventLogRepo.queryByEntity("claim_form", CLAIM_B)).toHaveLength(1);
    expect(await runtime.eventLogRepo.queryByEntity("slot", SLOT_ID)).toHaveLength(1);
    expect(runtime.notifyEntry.mock.calls.slice(0, 3).map(([entry]) => entry.entity_id))
      .toEqual([CLAIM_A, CLAIM_B, SLOT_ID]);
  });
});

describe("ArbitrationService audited SQLite edge deletion", () => {
  it("appends the deletion before removing the edge and notifies after commit, without auditing missing or cross-workspace requests", async () => {
    const runtime = await createRuntime();
    seed(runtime);
    await expect(runtime.arbitration.deleteEdge(EDGE_ID, "workspace-other")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await runtime.eventLogRepo.queryByEntity("conflict_matrix_edge", EDGE_ID)).toEqual([]);
    runtime.database.connection.exec(`
      CREATE TRIGGER require_edge_audit BEFORE DELETE ON conflict_matrix_edges
      WHEN NOT EXISTS (SELECT 1 FROM event_log WHERE entity_id = OLD.object_id
        AND event_type = 'soul.conflict_matrix_edge.deleted')
      BEGIN SELECT RAISE(ABORT, 'missing edge deletion audit'); END;
    `);
    runtime.notifyEntry.mockImplementation(async () => {
      expect(runtime.database.connection.inTransaction).toBe(false);
      expect(await runtime.conflictMatrixRepo.findById(EDGE_ID)).toBeNull();
    });
    await runtime.arbitration.deleteEdge(EDGE_ID, "workspace-1");
    const events = await runtime.eventLogRepo.queryByEntity("conflict_matrix_edge", EDGE_ID);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event_type: "soul.conflict_matrix_edge.deleted",
      entity_type: "conflict_matrix_edge", entity_id: EDGE_ID, workspace_id: "workspace-1",
      run_id: null, caused_by: "user_action", revision: 0 });
    expect(events[0]?.payload_json).toEqual({ object_id: EDGE_ID, object_kind: "conflict_matrix_edge",
      workspace_id: "workspace-1", run_id: null, source_claim_id: CLAIM_B, target_claim_id: CLAIM_A,
      edge_type: "supersedes" });
    expect(runtime.notifyEntry).toHaveBeenCalledExactlyOnceWith(events[0]);
    await expect(runtime.arbitration.deleteEdge(EDGE_ID, "workspace-1")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await runtime.eventLogRepo.queryByEntity("conflict_matrix_edge", EDGE_ID)).toEqual(events);
    expect(runtime.notifyEntry).toHaveBeenCalledTimes(1);
  });

  it("rolls back the audit on a SQLite deletion failure or when another deletion wins after the lookup", async () => {
    const runtime = await createRuntime();
    seed(runtime);
    runtime.database.connection.exec(`
      CREATE TRIGGER reject_edge_delete BEFORE DELETE ON conflict_matrix_edges
      BEGIN SELECT RAISE(ABORT, 'edge deletion refused'); END;
    `);
    await expect(runtime.arbitration.deleteEdge(EDGE_ID, "workspace-1")).rejects.toMatchObject({ code: "QUERY_FAILED" });
    expect(await runtime.conflictMatrixRepo.findById(EDGE_ID)).not.toBeNull();
    expect(await runtime.eventLogRepo.queryByEntity("conflict_matrix_edge", EDGE_ID)).toEqual([]);
    expect(runtime.notifyEntry).not.toHaveBeenCalled();

    runtime.database.connection.exec("DROP TRIGGER reject_edge_delete");
    const findById = runtime.conflictMatrixRepo.findById.bind(runtime.conflictMatrixRepo);
    vi.spyOn(runtime.conflictMatrixRepo, "findById").mockImplementationOnce(async id => {
      const captured = await findById(id);
      await runtime.arbitration.deleteEdge(id, "workspace-1");
      return captured;
    });
    await expect(runtime.arbitration.deleteEdge(EDGE_ID, "workspace-1")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await runtime.conflictMatrixRepo.findById(EDGE_ID)).toBeNull();
    expect(await runtime.eventLogRepo.queryByEntity("conflict_matrix_edge", EDGE_ID)).toHaveLength(1);
    expect(runtime.notifyEntry).toHaveBeenCalledTimes(1);
  });

  it("rebuilds orphan edges in one audited transaction, rolls the whole batch back on failure, and emits nothing for a valid-only rebuild", async () => {
    const runtime = await createRuntime();
    seed(runtime);
    const secondOrphanId = "22222222-2222-4222-8222-222222222222";
    const validEdgeId = "55555555-5555-4555-8555-555555555555";
    const thirdClaimId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const edge = (await runtime.conflictMatrixRepo.findById(EDGE_ID))!;
    runtime.conflictMatrixRepo.create({ ...edge, object_id: secondOrphanId, edge_type: "exception_to" });
    runtime.claimFormRepo.create(createClaimForm({ object_id: thirdClaimId }));
    runtime.conflictMatrixRepo.create({ ...edge, object_id: validEdgeId, source_claim_id: CLAIM_A,
      target_claim_id: thirdClaimId, edge_type: "supports" });
    // Simulate retained corrupt/imported edges for the orphan-repair entry.
    runtime.database.connection.exec("PRAGMA foreign_keys = OFF");
    runtime.database.connection.prepare("DELETE FROM claim_forms WHERE object_id = ?").run(CLAIM_B);
    runtime.database.connection.exec("PRAGMA foreign_keys = ON");
    runtime.database.connection.exec(`
      CREATE TRIGGER reject_second_orphan BEFORE DELETE ON conflict_matrix_edges
      WHEN OLD.object_id = '${secondOrphanId}'
      BEGIN SELECT RAISE(ABORT, 'orphan deletion refused'); END;
    `);
    await expect(runtime.arbitration.rebuildConflictMatrix("workspace-1")).rejects.toMatchObject({ code: "QUERY_FAILED" });
    expect(await runtime.conflictMatrixRepo.findByWorkspace("workspace-1")).toHaveLength(3);
    expect(await runtime.eventLogRepo.queryByEntity("conflict_matrix_edge", EDGE_ID)).toEqual([]);
    expect(await runtime.eventLogRepo.queryByEntity("conflict_matrix_edge", secondOrphanId)).toEqual([]);
    expect(runtime.notifyEntry).not.toHaveBeenCalled();

    runtime.database.connection.exec("DROP TRIGGER reject_second_orphan");
    await expect(runtime.arbitration.rebuildConflictMatrix("workspace-1")).resolves.toEqual({
      total_edges: 3, orphaned_deleted: 2, valid_edges: 1
    });
    expect((await runtime.conflictMatrixRepo.findByWorkspace("workspace-1")).map(value => value.object_id))
      .toEqual([validEdgeId]);
    const firstAudits = await runtime.eventLogRepo.queryByEntity("conflict_matrix_edge", EDGE_ID);
    const secondAudits = await runtime.eventLogRepo.queryByEntity("conflict_matrix_edge", secondOrphanId);
    expect(firstAudits).toHaveLength(1);
    expect(secondAudits).toHaveLength(1);
    expect(firstAudits[0]).toMatchObject({ event_type: "soul.conflict_matrix_edge.deleted", caused_by: "system",
      payload_json: { object_id: EDGE_ID, source_claim_id: CLAIM_B, target_claim_id: CLAIM_A, edge_type: "supersedes" } });
    expect(secondAudits[0]).toMatchObject({ event_type: "soul.conflict_matrix_edge.deleted", caused_by: "system",
      payload_json: { object_id: secondOrphanId, source_claim_id: CLAIM_B, target_claim_id: CLAIM_A, edge_type: "exception_to" } });
    expect(await runtime.eventLogRepo.queryByEntity("conflict_matrix_edge", validEdgeId)).toEqual([]);
    await expect(runtime.arbitration.rebuildConflictMatrix("workspace-1")).resolves.toEqual({
      total_edges: 1, orphaned_deleted: 0, valid_edges: 1
    });
    expect(runtime.notifyEntry).toHaveBeenCalledTimes(2);
  });
});
