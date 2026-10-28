import { expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROOF_EFFECT_OPERATOR_ID, PROOF_EFFECT_OPERATOR_VERSION, hashEffectGovernanceFrontier,
  type EffectRequest, type Slot
} from "@do-soul/alaya-protocol";
import { SqliteClaimElectionLeaseRepo, SqliteClaimFormRepo, SqliteConflictMatrixRepo, SqliteEventLogRepo,
  SqliteReconciliationLeaseRepo, SqliteSlotRepo, StorageDatabase } from "@do-soul/alaya-storage";
import { openSqliteConnection } from "@do-soul/alaya-storage/sqlite/open-sqlite-connection";
import { ClaimService } from "../../governance/claims/claim-service.js";
import { ArbitrationService } from "../../governance/proposals/arbitration-service.js";
import { ResolutionService, type ResolutionServiceDependencies } from "../../governance/proposals/resolution-service.js";
import { buildEffectDecisionReceipt } from "../../governance/effects/proof-effect-policy.js";
import { EventPublisher } from "../../runtime/event-publisher.js";
import { fieldContractSha256 } from "../../shared/field-hash.js";
import { SlotService } from "../../surfaces/slot-service.js";
import { createResolutionServiceRealStorage } from "../shared/real-sqlite.test-support.js";
import { createClaimForm, createClaimInput } from "./claim-service.test-support.js";

const NOW = "2026-05-17T00:00:00.000Z";
const CANDIDATE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INCUMBENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SLOT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const request = { targetObjectId: CANDIDATE, resolution: "confirm" as const, workspaceId: "workspace-1",
  runId: "run-1", agentTarget: "codex", reviewerIdentity: "reviewer-a", deliveryId: "delivery-1" };

async function createRuntime(beforeEffect?: () => Promise<void>, filename?: string, electionNow?: () => string,
  slotStorage?: Awaited<ReturnType<typeof createResolutionServiceRealStorage>>, useSlotPublisher = false,
  existing?: Awaited<ReturnType<typeof createResolutionServiceRealStorage>>) {
  const storage = existing ?? await createResolutionServiceRealStorage(() => undefined, filename);
  const slotRepo = new SqliteSlotRepo(slotStorage?.database ?? storage.database);
  const conflictMatrixRepo = new SqliteConflictMatrixRepo(storage.database);
  const notifier = { notify: () => undefined, notifyEntry: () => undefined };
  const eventPublisher = new EventPublisher({ eventLogRepo: storage.eventLogRepo, runtimeNotifier: notifier,
    runHotStateService: { apply: () => undefined } });
  let claimService!: ClaimService;
  const arbitration = new ArbitrationService({ slotRepo, conflictMatrixRepo, claimRepo: storage.claimFormRepo,
    eventLogRepo: storage.eventLogRepo, runtimeNotifier: notifier, now: () => NOW,
    claimService: {
      getStorageConnectionIdentity: () => claimService.getStorageConnectionIdentity(),
      prepareLifecycleTransition: (...args) => claimService.prepareLifecycleTransition(...args),
      transitionLifecycle: (...args) => claimService.transitionLifecycle(...args)
    } });
  const slotEventLog = useSlotPublisher ? slotStorage!.eventLogRepo : storage.eventLogRepo;
  const slotPublisher = useSlotPublisher ? new EventPublisher({ eventLogRepo: slotEventLog, runtimeNotifier: notifier,
    runHotStateService: { apply: () => undefined } }) : eventPublisher;
  const slotService = new SlotService({ slotRepo, eventLogRepo: slotEventLog, eventPublisher: slotPublisher,
    arbitrationService: arbitration, runtimeNotifier: notifier, now: () => NOW, generateObjectId: () => SLOT });
  claimService = new ClaimService({ ...storage, eventPublisher, runtimeNotifier: notifier, slotService,
    effectDecisionStore: { insert: receipt => receipt }, now: () => NOW });
  const resolutionDependencies: ResolutionServiceDependencies = { eventPublisher, resolutionAuditRepo: storage.eventLogRepo,
    electionLease: new SqliteClaimElectionLeaseRepo(storage.database), electionNow,
    claimRepo: storage.claimFormRepo, claimService,
    memoryRepo: { findById: async () => null }, memoryService: {} as ResolutionServiceDependencies["memoryService"],
    deferredObligationService: {} as ResolutionServiceDependencies["deferredObligationService"],
    deliveryAuthority: { authorize: async () => ({ deliveredAt: NOW }) },
    effectAuthority: { decide: async input => {
      await beforeEffect?.();
      const witnesses: EffectRequest["supporting_proof_witnesses"] = [];
      const effectRequest: EffectRequest = { schema_version: 2, workspace_id: input.workspaceId,
        actor_id: input.actorId, run_id: input.runId, delivery_id: input.deliveryId, action: input.action,
        target: input.targetObjectId, scope: input.scope, effective_as_of: input.effectiveAsOf,
        supporting_receipt_ids: [], supporting_proof_witnesses: witnesses,
        governance_frontier: hashEffectGovernanceFrontier(witnesses, fieldContractSha256),
        policy_operator_id: PROOF_EFFECT_OPERATOR_ID, policy_operator_version: PROOF_EFFECT_OPERATOR_VERSION };
      return buildEffectDecisionReceipt(effectRequest, "allow", NOW, fieldContractSha256);
    } }, now: () => NOW };
  return { ...storage, slotRepo, claimService, resolution: new ResolutionService(resolutionDependencies),
    secondResolution: new ResolutionService(resolutionDependencies) };
}

function independentStorage(filename: string): Awaited<ReturnType<typeof createResolutionServiceRealStorage>> {
  const database = new StorageDatabase(filename, openSqliteConnection(filename));
  return { database, eventLogRepo: new SqliteEventLogRepo(database), claimFormRepo: new SqliteClaimFormRepo(database) };
}

it("persists a newly materialized claim as draft through the real ClaimService", async () => {
  const runtime = await createRuntime();
  try {
    const created = await runtime.claimService.create(createClaimInput());
    expect(created.claim_status).toBe("draft");
    expect((await runtime.claimFormRepo.findById(created.object_id))?.claim_status).toBe("draft");
    expect((await runtime.eventLogRepo.queryByEntityAll("claim_form", created.object_id))
      .map(event => event.event_type)).toContain("soul.claim.created");
  } finally { runtime.database.close(); }
});

it("reports a committed confirmation when election fails and resumes it for the same delivery and reviewer", async () => {
  const runtime = await createRuntime();
  try {
    runtime.claimFormRepo.create(createClaimForm({ object_id: CANDIDATE }));
    runtime.database.connection.exec(`CREATE TRIGGER refuse_slot BEFORE INSERT ON slots
      BEGIN SELECT RAISE(ABORT, 'slot unavailable'); END;`);
    const first = await runtime.resolution.resolve(request);
    expect(first).toMatchObject({ status: "applied", activatedClaimId: CANDIDATE, electionStatus: "failed" });
    expect((await runtime.claimFormRepo.findById(CANDIDATE))?.claim_status).toBe("active");
    expect(await runtime.eventLogRepo.queryByEntityAll("soul_resolution", CANDIDATE)).toHaveLength(1);
    await expect(runtime.resolution.resolve({ ...request, reviewerIdentity: "reviewer-b" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(runtime.resolution.resolve({ ...request, deliveryId: "delivery-2" })).rejects.toMatchObject({ code: "CONFLICT" });
    runtime.database.connection.exec("DROP TRIGGER refuse_slot");
    const retry = await runtime.resolution.resolve(request);
    expect(retry).toMatchObject({ status: "applied", electionStatus: "completed", auditEventId: first.auditEventId });
    expect((await runtime.slotRepo.findById(SLOT))?.winner_claim_id).toBe(CANDIDATE);
    expect(await runtime.eventLogRepo.queryByEntityAll("soul_resolution", CANDIDATE)).toHaveLength(2);
    const findSlot = vi.spyOn(runtime.slotRepo, "findByUniqueKey");
    await expect(runtime.resolution.resolve(request)).resolves.toMatchObject({ electionStatus: "completed", auditEventId: first.auditEventId });
    expect(findSlot).not.toHaveBeenCalled();
  } finally { runtime.database.close(); }
});

it("reports a pending completion audit after election and finishes it on the original retry", async () => {
  const runtime = await createRuntime();
  try {
    runtime.claimFormRepo.create(createClaimForm({ object_id: CANDIDATE }));
    runtime.database.connection.exec(`CREATE TRIGGER refuse_election_audit BEFORE INSERT ON event_log
      WHEN NEW.event_type = 'soul.resolution.confirm_election_completed'
      BEGIN SELECT RAISE(ABORT, 'election audit unavailable'); END;`);
    const first = await runtime.resolution.resolve(request);
    expect(first).toMatchObject({ status: "applied", electionStatus: "pending" });
    expect((await runtime.slotRepo.findById(SLOT))?.winner_claim_id).toBe(CANDIDATE);
    expect(await runtime.eventLogRepo.queryByEntityAll("soul_resolution", CANDIDATE)).toHaveLength(1);
    runtime.database.connection.exec("DROP TRIGGER refuse_election_audit");
    const retries = await Promise.all([runtime.resolution.resolve(request), runtime.secondResolution.resolve(request)]);
    expect(retries.every(result => result.status === "applied" && result.auditEventId === first.auditEventId)).toBe(true);
    expect(retries.some(result => result.electionStatus === "completed")).toBe(true);
    expect(retries.every(result => result.electionStatus === "pending" || result.electionStatus === "completed")).toBe(true);
    await expect(runtime.resolution.resolve(request)).resolves.toMatchObject({ electionStatus: "completed", auditEventId: first.auditEventId });
    const events = await runtime.eventLogRepo.queryByEntityAll("soul_resolution", CANDIDATE);
    expect(events).toHaveLength(2);
    expect(events.find(event => event.event_type === "soul.resolution.confirm_election_completed")?.payload_json)
      .toMatchObject({ confirmation_event_id: first.auditEventId, delivery_id: request.deliveryId,
        reviewer_identity: request.reviewerIdentity });
  } finally { runtime.database.close(); }
});

it("does not repeat a contested transition already committed by arbitration", async () => {
  const runtime = await createRuntime();
  try {
    const incumbent = createClaimForm({ object_id: INCUMBENT, claim_status: "winner" });
    runtime.claimFormRepo.create(incumbent);
    runtime.claimFormRepo.create(createClaimForm({ object_id: CANDIDATE }));
    const slot: Slot = { object_id: SLOT, object_kind: "slot", schema_version: 1, lifecycle_state: "active",
      created_at: incumbent.created_at, updated_at: incumbent.updated_at, created_by: "system",
      governance_subject: incumbent.governance_subject, claim_kind: incumbent.claim_kind,
      scope_class: incumbent.scope_class, workspace_id: incumbent.workspace_id,
      winner_claim_id: INCUMBENT, incumbent_since: incumbent.created_at, flip_conditions: [] };
    runtime.slotRepo.create(slot);
    await expect(runtime.resolution.resolve(request)).resolves.toMatchObject({ status: "applied", electionStatus: "completed" });
    expect((await runtime.claimFormRepo.findById(CANDIDATE))?.claim_status).toBe("contested");
    const events = await runtime.eventLogRepo.queryByEntityAll("claim_form", CANDIDATE);
    expect(events.filter(event => event.event_type === "soul.claim.lifecycle_changed")).toHaveLength(2);
    expect(events.filter(event => event.event_type === "soul.claim.contested")).toEqual([
      expect.objectContaining({ payload_json: expect.objectContaining({ contested_by: INCUMBENT, triage_result: "deferred" }) })
    ]);
  } finally { runtime.database.close(); }
});

it("rolls back contested state when its typed audit fails and writes it once on election retry", async () => {
  const runtime = await createRuntime();
  try {
    const incumbent = createClaimForm({ object_id: INCUMBENT, claim_status: "winner" });
    runtime.claimFormRepo.create(incumbent);
    runtime.claimFormRepo.create(createClaimForm({ object_id: CANDIDATE }));
    runtime.slotRepo.create({ object_id: SLOT, object_kind: "slot", schema_version: 1, lifecycle_state: "active",
      created_at: incumbent.created_at, updated_at: incumbent.updated_at, created_by: "system",
      governance_subject: incumbent.governance_subject, claim_kind: incumbent.claim_kind,
      scope_class: incumbent.scope_class, workspace_id: incumbent.workspace_id,
      winner_claim_id: INCUMBENT, incumbent_since: incumbent.created_at, flip_conditions: [] });
    runtime.database.connection.exec(`CREATE TRIGGER refuse_contested BEFORE INSERT ON event_log
      WHEN NEW.event_type = 'soul.claim.contested' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`);
    const first = await runtime.resolution.resolve(request);
    expect(first).toMatchObject({ status: "applied", electionStatus: "failed" });
    expect((await runtime.claimFormRepo.findById(CANDIDATE))?.claim_status).toBe("active");
    runtime.database.connection.exec("DROP TRIGGER refuse_contested");
    await expect(runtime.resolution.resolve(request)).resolves.toMatchObject({ status: "applied", electionStatus: "completed" });
    expect((await runtime.claimFormRepo.findById(CANDIDATE))?.claim_status).toBe("contested");
    const events = await runtime.eventLogRepo.queryByEntityAll("claim_form", CANDIDATE);
    expect(events.filter(event => event.event_type === "soul.claim.lifecycle_changed")).toHaveLength(2);
    expect(events.filter(event => event.event_type === "soul.claim.contested")).toHaveLength(1);
  } finally { runtime.database.close(); }
});

it.each([
  ["same delivery", request, true],
  ["different reviewer", { ...request, reviewerIdentity: "reviewer-b" }, false],
  ["different delivery", { ...request, deliveryId: "delivery-2" }, false],
  ["different reason", { ...request, reason: "changed intent" }, false]
] as const)("handles concurrent first confirmations for %s", async (_name, otherRequest, same) => {
  let releaseDecisions!: () => void, decisionsReady!: () => void, releaseElection!: () => void, electionStarted!: () => void;
  const decisionsGate = new Promise<void>(resolve => { releaseDecisions = resolve; });
  const bothDeciding = new Promise<void>(resolve => { decisionsReady = resolve; });
  const electionGate = new Promise<void>(resolve => { releaseElection = resolve; });
  const inElection = new Promise<void>(resolve => { electionStarted = resolve; });
  let decisions = 0;
  const beforeEffect = async () => {
    if (++decisions === 2) decisionsReady();
    await decisionsGate;
  };
  const directory = mkdtempSync(join(tmpdir(), "alaya-confirm-race-"));
  const filename = join(directory, "authority.sqlite");
  const runtime = await createRuntime(beforeEffect, filename);
  const otherRuntime = await createRuntime(beforeEffect, filename, undefined, undefined, false, independentStorage(filename));
  try {
    expect(otherRuntime.database.connection).not.toBe(runtime.database.connection);
    runtime.claimFormRepo.create(createClaimForm({ object_id: CANDIDATE }));
    const election = [runtime, otherRuntime].map(instance => {
      const findSlot = instance.slotRepo.findByUniqueKey.bind(instance.slotRepo);
      return vi.spyOn(instance.slotRepo, "findByUniqueKey").mockImplementation(async (...args) => {
        electionStarted();
        await electionGate;
        return await findSlot(...args);
      });
    });
    const first = runtime.resolution.resolve(request);
    const second = otherRuntime.resolution.resolve(otherRequest);
    const settle = (promise: typeof first) => promise.then(value => ({ value }), error => ({ error }));
    const settled = [settle(first), settle(second)];
    await bothDeciding;
    releaseDecisions();
    await inElection;
    const early = await Promise.race(settled);
    if (same) expect(early).toMatchObject({ value: { status: "applied", electionStatus: "pending" } });
    else expect(early).toMatchObject({ error: { code: "CONFLICT" } });
    expect(election.reduce((count, spy) => count + spy.mock.calls.length, 0)).toBe(1);
    releaseElection();
    const results = await Promise.all(settled);
    const successes = results.flatMap(result => "value" in result ? [result.value] : []);
    expect(successes).toHaveLength(same ? 2 : 1);
    expect(new Set(successes.map(result => result.auditEventId)).size).toBe(1);
    const events = await runtime.eventLogRepo.queryByEntityAll("soul_resolution", CANDIDATE);
    expect(events.filter(event => event.event_type === "soul.resolution.confirm_applied")).toHaveLength(1);
    expect(events.filter(event => event.event_type === "soul.resolution.confirm_election_completed")).toHaveLength(1);
  } finally {
    releaseDecisions(); releaseElection(); runtime.database.close(); otherRuntime.database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("returns pending while another service elects and fences an expired owner after takeover", async () => {
  let releaseOld!: () => void, oldEntered!: () => void;
  const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
  const inOldElection = new Promise<void>(resolve => { oldEntered = resolve; });
  let clock = "2026-05-17T00:00:00.000Z";
  const directory = mkdtempSync(join(tmpdir(), "alaya-election-fence-"));
  const filename = join(directory, "authority.sqlite");
  const old = await createRuntime(undefined, filename, () => clock);
  const next = await createRuntime(undefined, filename, () => clock, undefined, false, independentStorage(filename));
  try {
    expect(next.database.connection).not.toBe(old.database.connection);
    old.claimFormRepo.create(createClaimForm({ object_id: CANDIDATE }));
    const findOld = old.slotRepo.findByUniqueKey.bind(old.slotRepo);
    vi.spyOn(old.slotRepo, "findByUniqueKey").mockImplementation(async (...args) => {
      const snapshot = await findOld(...args);
      oldEntered();
      await oldGate;
      return snapshot;
    });
    const nextElection = vi.spyOn(next.slotRepo, "findByUniqueKey");
    const first = old.resolution.resolve(request);
    await inOldElection;
    const pending = await next.resolution.resolve(request);
    expect(pending).toMatchObject({ status: "applied", electionStatus: "pending" });
    expect(nextElection).not.toHaveBeenCalled();

    clock = "2026-05-17T00:06:00.000Z";
    const takeover = await next.resolution.resolve(request);
    expect(takeover).toMatchObject({ status: "applied", electionStatus: "completed", auditEventId: pending.auditEventId });
    releaseOld();
    await expect(first).resolves.toMatchObject({ status: "applied", electionStatus: "completed", auditEventId: pending.auditEventId });
    expect(await next.eventLogRepo.queryByEntityAll("slot", SLOT)).toHaveLength(1);
    const resolutionEvents = await next.eventLogRepo.queryByEntityAll("soul_resolution", CANDIDATE);
    expect(resolutionEvents.filter(event => event.event_type === "soul.resolution.confirm_applied")).toHaveLength(1);
    expect(resolutionEvents.filter(event => event.event_type === "soul.resolution.confirm_election_completed")).toHaveLength(1);
  } finally {
    releaseOld(); old.database.close(); next.database.close(); rmSync(directory, { recursive: true, force: true });
  }
});

it("does not create a slot for a claim archived while its election is awaiting a read", async () => {
  let resume!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const inElection = new Promise<void>(resolve => { entered = resolve; });
  const directory = mkdtempSync(join(tmpdir(), "alaya-election-archive-"));
  const filename = join(directory, "authority.sqlite");
  const first = await createRuntime(undefined, filename);
  const other = await createRuntime(undefined, filename, undefined, undefined, false, independentStorage(filename));
  try {
    expect(other.database.connection).not.toBe(first.database.connection);
    first.claimFormRepo.create(createClaimForm({ object_id: CANDIDATE }));
    const find = first.slotRepo.findByUniqueKey.bind(first.slotRepo);
    vi.spyOn(first.slotRepo, "findByUniqueKey").mockImplementation(async (...args) => {
      const snapshot = await find(...args); entered(); await gate; return snapshot;
    });
    const confirming = first.resolution.resolve(request);
    await inElection;
    await other.claimService.transitionLifecycle(CANDIDATE, "archived", "review rejected", "user", { skipSlotElection: true });
    resume();
    await expect(confirming).resolves.toMatchObject({ status: "applied", electionStatus: "failed" });
    expect((await other.claimFormRepo.findById(CANDIDATE))?.claim_status).toBe("archived");
    expect(await other.slotRepo.findById(SLOT)).toBeNull();
    expect(await other.eventLogRepo.queryByEntityAll("slot", SLOT)).toEqual([]);
  } finally { resume(); first.database.close(); other.database.close(); rmSync(directory, { recursive: true, force: true }); }
});

it("does not collide with a reconciliation workspace using the same lease key", async () => {
  const runtime = await createRuntime();
  try {
    const reconciliation = new SqliteReconciliationLeaseRepo(runtime.database);
    const key = `claim-election:${JSON.stringify([request.workspaceId, request.targetObjectId])}`;
    expect(reconciliation.tryAcquire(key, "other-owner", "2026-05-17T00:00:00.000Z", "2099-01-01T00:00:00.000Z")).not.toBeNull();
    runtime.claimFormRepo.create(createClaimForm({ object_id: CANDIDATE }));
    await expect(runtime.resolution.resolve(request)).resolves.toMatchObject({ status: "applied", electionStatus: "completed" });
    expect(reconciliation.findByKey(key)?.owner_token).toBe("other-owner");
  } finally { runtime.database.close(); }
});

it("does not record election completion after an already-elected claim is archived", async () => {
  let resume!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const inElection = new Promise<void>(resolve => { entered = resolve; });
  const directory = mkdtempSync(join(tmpdir(), "alaya-election-completion-"));
  const filename = join(directory, "authority.sqlite");
  const first = await createRuntime(undefined, filename);
  const other = await createRuntime(undefined, filename, undefined, undefined, false, independentStorage(filename));
  try {
    expect(other.database.connection).not.toBe(first.database.connection);
    first.claimFormRepo.create(createClaimForm({ object_id: CANDIDATE }));
    first.database.connection.exec(`CREATE TRIGGER refuse_election_completion BEFORE INSERT ON event_log
      WHEN NEW.event_type = 'soul.resolution.confirm_election_completed' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`);
    await expect(first.resolution.resolve(request)).resolves.toMatchObject({ electionStatus: "pending" });
    first.database.connection.exec("DROP TRIGGER refuse_election_completion");
    const find = first.slotRepo.findByUniqueKey.bind(first.slotRepo);
    vi.spyOn(first.slotRepo, "findByUniqueKey").mockImplementation(async (...args) => {
      const snapshot = await find(...args); entered(); await gate; return snapshot;
    });
    const retry = first.resolution.resolve(request);
    await inElection;
    await other.claimService.transitionLifecycle(CANDIDATE, "archived", "review rejected", "user", { skipSlotElection: true });
    resume();
    await expect(retry).resolves.toMatchObject({ status: "applied", electionStatus: "pending" });
    const events = await other.eventLogRepo.queryByEntityAll("soul_resolution", CANDIDATE);
    expect(events.filter(event => event.event_type === "soul.resolution.confirm_election_completed")).toHaveLength(0);
  } finally { resume(); first.database.close(); other.database.close(); rmSync(directory, { recursive: true, force: true }); }
});

it.each(["publisher", "slot repository"] as const)("fails closed when the election %s uses another SQLite connection", async mismatched => {
  const other = await createResolutionServiceRealStorage(() => undefined);
  const runtime = await createRuntime(undefined, undefined, undefined, other, mismatched === "publisher");
  try {
    runtime.claimFormRepo.create(createClaimForm({ object_id: CANDIDATE }));
    await expect(runtime.resolution.resolve(request)).resolves.toMatchObject({ status: "applied", electionStatus: "failed" });
    expect((await runtime.claimFormRepo.findById(CANDIDATE))?.claim_status).toBe("active");
    expect(await runtime.slotRepo.findById(SLOT)).toBeNull();
    expect(await other.eventLogRepo.queryByEntityAll("slot", SLOT)).toEqual([]);
    expect((await runtime.eventLogRepo.queryByEntityAll("soul_resolution", CANDIDATE))
      .filter(event => event.event_type === "soul.resolution.confirm_election_completed")).toEqual([]);
  } finally { runtime.database.close(); other.database.close(); }
});
