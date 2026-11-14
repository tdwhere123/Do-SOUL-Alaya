import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../../scripts/test-support/provider-free/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(async () => { await cleanupGardenMcpHarnesses(); vi.restoreAllMocks(); expect(isolation.violations).toEqual([]); });
afterAll(() => isolation.restore());
import { SignalService } from "@do-soul/alaya-core";
import { createGardenMcpHarness, cleanupGardenMcpHarnesses } from "./garden-mcp-tools-fixture.js";
import { createGardenClaimReclaimer } from "../../../garden/host-worker/host-worker-task-maintenance.js";

it("lets an admitted receive settle after reclaim but fences later siblings and preserves successor retry", async () => {
  let now = "2026-05-07T00:00:00.000Z", release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const receive = SignalService.prototype.receiveSignal, dispatched: string[] = [];
  vi.spyOn(SignalService.prototype, "receiveSignal").mockImplementation(async function (this: SignalService, signal) {
    dispatched.push(signal.signal_id);
    if (dispatched.length === 1) { entered(); await gate; }
    return await receive.call(this, signal);
  });
  const h = await createGardenMcpHarness({ now: () => now });
  const task = "completion-expired-inflight";
  h.enqueueTask(task); await h.callTool("garden.claim_task", { task_id: task });
  const request = { task_id: task, status: "completed", result_envelope: { candidate_signals: ["one", "two"].map(text => ({
    signal_kind: "potential_preference", object_kind: "memory_entry", scope_hint: "project", domain_tags: ["garden"],
    confidence: 0.9, evidence_refs: ["memory-1"], raw_payload: { observation: text } })) } };
  const completing = h.callTool("garden.complete_task", request);
  const rejected = expect(completing).rejects.toThrow(/claim changed before candidate signal emission/);
  try {
    await started;
    now = "2026-05-07T00:10:00.001Z";
    await createGardenClaimReclaimer({ now: () => now, gardenTaskRepo: h.gardenTaskRepo })();
    expect(h.getGardenTask(task).status).toBe("pending");
    await h.gardenTaskRepo.claimAtomic(task, "new-claimant", now);
    release(); await rejected;
    expect(dispatched).toHaveLength(1);
    expect(h.getGardenTask(task)).toMatchObject({ status: "claimed", claimed_by: "new-claimant" });
    const count = () => h.database.connection.prepare("SELECT COUNT(*) AS n FROM signals").pluck().get();
    expect(count()).toBe(1);
    const firstAudits = await h.eventLogRepo.queryByEntityAll("candidate_memory_signal", dispatched[0]!);
    expect(firstAudits.length).toBeGreaterThan(0);
    h.setContext({ agentTarget: "new-claimant" });
    await h.callTool("garden.complete_task", request);
    expect(count()).toBe(2);
    expect(dispatched).toHaveLength(3);
    expect(dispatched[1]).toBe(dispatched[0]);
    expect(dispatched[2]).not.toBe(dispatched[0]);
    expect(await h.eventLogRepo.queryByEntityAll("candidate_memory_signal", dispatched[0]!)).toEqual(firstAudits);
    expect(h.getGardenTask(task).status).toBe("completed");
    const completed = (await h.eventLogRepo.queryByEntityAll("garden_task", task))
      .filter(event => event.event_type === "soul.garden.task_completed");
    expect(completed).toHaveLength(1);
  } finally { release(); await completing.catch(() => undefined); }
});
