import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../../scripts/test-support/provider-free/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { vi.restoreAllMocks(); expect(isolation.violations).toEqual([]); });
afterAll(() => isolation.restore());
import { candidate, cli, connect, fixture } from "./recovery-test-fixture.js";

it("discovers an evicted proven deferral after reopen and explicitly recovers through CLI while preserving the FIFO cap and active owner", async () => {
  const h = await fixture();
  try {
    const owner = h.owner;
    await owner.service.receiveSignal(candidate("active"));
    await owner.service.receiveSignal(candidate("evicted"));
    expect(owner.transitions.claimRedrive({ workspace_id: "workspace-1", signal_id: "active", claim_token: "held",
      claim_expires_at: "2099-01-01T00:00:00.000Z" })).not.toBeNull();
    await owner.service.receiveSignal(candidate("later"));
    expect(owner.queue.get("workspace-1", "evicted")).toBeNull();
    expect(owner.queue.ownsClaim("workspace-1", "active", "held")).toBe(true);
    expect(owner.queue.stats("workspace-1").queue_depth).toBe(2);
    await h.reopen();
    const reopened = h.owner, command = cli(reopened.service);
    const listed = await command.run(["list-recoverable"]);
    expect(listed.json).toMatchObject({ action: "list-recoverable", next_after_signal_id: null,
      entries: [{ signal_id: "evicted", workspace_id: "workspace-1", defer_reason: "source_assertion_incomplete" }] });
    expect(reopened.materialize).not.toHaveBeenCalled();
    await expect(reopened.service.receiveSignal(candidate("evicted"))).resolves.toMatchObject({ signal: { signal_state: "deferred" } });
    await expect(reopened.service.redriveSourceGroundingDefer("workspace-1", "evicted")).rejects.toThrow();
    expect(reopened.materialize).not.toHaveBeenCalled();
    expect((await command.run(["recover", "--signal", "evicted", "--raw-payload-file", "/not-read.json"])).result.exitCode).not.toBe(0);
    expect(reopened.materialize).not.toHaveBeenCalled();
    reopened.outcome("materialized");
    const recovered = await command.run(["recover", "--signal", "evicted"]);
    expect(recovered.json).toMatchObject({ action: "recover", signal_id: "evicted", signal_state: "materialized" });
    expect(reopened.materialize).toHaveBeenCalledTimes(1);
    expect(reopened.queue.ownsClaim("workspace-1", "active", "held")).toBe(true);
    expect(reopened.queue.stats("workspace-1").queue_depth).toBe(1);
    expect(reopened.service.listSourceGroundingRecoveryCandidates("workspace-1").entries.map(row => row.signal_id)).toEqual(["later"]);
    const events = await reopened.events.queryByEntityAll("candidate_memory_signal", "evicted");
    const admission = events.find(event => "normalized_fields" in event.payload_json &&
      JSON.stringify(event.payload_json).includes("source_grounding_readmission"));
    expect(admission?.payload_json).toMatchObject({ normalized_fields: { source_grounding_readmission: {
      action: "recover_unqueued", triage_revision: listed.json.entries[0].triage_revision } } });
    expect(admission!.revision).toBeLessThan(events.at(-1)!.revision);
    await expect(reopened.service.recoverSourceGroundingDefer("workspace-1", "evicted")).rejects.toThrow(/proof/);
    expect(reopened.materialize).toHaveBeenCalledTimes(1);
  } finally { await h.close(); }
});

it("rechecks proof at explicit recovery, excludes ambiguous history and advances discovery past refused rows", async () => {
  const h = await fixture(1);
  try {
    const o = h.owner;
    for (const id of ["a-history", "b-malformed", "c-later-audit", "d-safe", "e-recorded-effects", "z-queued"]) await o.service.receiveSignal(candidate(id));
    // Fault/legacy fixtures keep their old outcome audit but lose authoritative lineage or typed evidence.
    await o.signals.updateState("a-history", "deferred");
    o.database.connection.prepare(`UPDATE event_log SET payload_json='{}' WHERE entity_id='b-malformed' AND event_type='soul.signal.triaged'`)
      .run();
    await o.events.append({ event_type: "soul.signal.normalized", entity_type: "candidate_memory_signal", entity_id: "c-later-audit",
      workspace_id: "workspace-1", run_id: "run-1", caused_by: "test", payload_json: {
        signal_id: "c-later-audit", workspace_id: "workspace-1", run_id: "run-1", normalized_fields: { later_unknown: true } } });
    o.database.connection.prepare(`UPDATE event_log SET payload_json=json_set(payload_json, '$.created_objects',
      json('[{"object_kind":"memory_entry","object_id":"retained-effect"}]'))
      WHERE entity_id='e-recorded-effects' AND event_type='soul.signal.materialized'`).run();
    expect(o.service.listSourceGroundingRecoveryCandidates("workspace-1", null, 2))
      .toEqual({ entries: [], next_after_signal_id: "b-malformed" });
    expect(o.service.listSourceGroundingRecoveryCandidates("workspace-1", "b-malformed", 2).entries.map(row => row.signal_id)).toEqual(["d-safe"]);
    expect(o.service.listSourceGroundingRecoveryCandidates("other-workspace").entries).toEqual([]);
    o.materialize.mockClear();
    for (const id of ["a-history", "b-malformed", "c-later-audit", "e-recorded-effects", "z-queued"]) {
      await expect(o.service.recoverSourceGroundingDefer("workspace-1", id)).rejects.toThrow(/proof/);
    }
    await expect(o.service.recoverSourceGroundingDefer("other-workspace", "d-safe")).rejects.toThrow();
    // A previously listed row is not a capability: current state still controls admission.
    await o.signals.updateState("d-safe", "materialization_unknown");
    await expect(o.service.recoverSourceGroundingDefer("workspace-1", "d-safe")).rejects.toThrow(/proof/);
    expect(o.materialize).not.toHaveBeenCalled();
  } finally { await h.close(); }
});

it("rolls back saturated re-admission and its audit, then preserves unfinished recovered effects against a concurrent receiver", async () => {
  const h = await fixture(1);
  let release!: () => void;
  try {
    const o = h.owner;
    await o.service.receiveSignal(candidate("recover")); await o.service.receiveSignal(candidate("held"));
    o.transitions.claimRedrive({ workspace_id: "workspace-1", signal_id: "held", claim_token: "owner",
      claim_expires_at: "2099-01-01T00:00:00.000Z" });
    const before = await o.events.queryByEntityAll("candidate_memory_signal", "recover");
    o.materialize.mockClear();
    await expect(o.service.recoverSourceGroundingDefer("workspace-1", "recover")).rejects.toThrow();
    expect(await o.events.queryByEntityAll("candidate_memory_signal", "recover")).toEqual(before);
    expect(o.queue.get("workspace-1", "recover")).toBeNull(); expect(o.queue.stats("workspace-1").queue_depth).toBe(1);
    expect(o.materialize).not.toHaveBeenCalled();
    // Complete the protected owner through its existing transition, not by dropping an unfinished claim.
    o.transitions.completeRedrive({ workspace_id: "workspace-1", signal_id: "held", claim_token: "owner", event: {
      event_type: "soul.signal.materialized", entity_type: "candidate_memory_signal", entity_id: "held",
      workspace_id: "workspace-1", run_id: "run-1", caused_by: "test", payload_json: {
        signal_id: "held", workspace_id: "workspace-1", run_id: "run-1", success: true, created_objects: [],
        disposition: "materialized", target_kind: "evidence_only", routing_reason: "fixture owner completed" } } });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    o.materialize.mockImplementationOnce(async signal => {
      entered(); await gate;
      return { signal_id: signal.signal_id, target_kind: "evidence_only", routing_reason: "settled", success: true, created_objects: [] };
    });
    const running = o.service.recoverSourceGroundingDefer("workspace-1", "recover");
    await started;
    const peer = connect(o.database, 1);
    try {
      expect(o.queue.hasUnfinishedClaim("workspace-1", "recover")).toBe(true);
      await expect(peer.service.recoverSourceGroundingDefer("workspace-1", "recover")).rejects.toThrow(/proof/);
      await expect(peer.service.redriveSourceGroundingDefer("workspace-1", "recover")).rejects.toThrow();
      expect(peer.materialize).not.toHaveBeenCalled();
      release(); expect((await running).signal.signal_state).toBe("materialized");
    } finally { release(); await running; await peer.service.close(); }
    expect(o.materialize).toHaveBeenCalledTimes(1);
  } finally { release?.(); await h.close(); }
});

it("permits a newly completed deferral to be evicted and recovered again, but not an unknown-effect failure", async () => {
  const h = await fixture(1);
  try {
    const o = h.owner;
    await o.service.receiveSignal(candidate("recover")); await o.service.receiveSignal(candidate("first-other"));
    expect((await o.service.recoverSourceGroundingDefer("workspace-1", "recover")).signal.signal_state).toBe("deferred");
    await o.service.receiveSignal(candidate("second-other"));
    o.outcome("failed");
    const failed = await o.service.recoverSourceGroundingDefer("workspace-1", "recover");
    expect(failed.materialization?.success).toBe(false);
    expect(o.queue.get("workspace-1", "recover")?.claim_token_fingerprint).not.toBeNull();
    const count = o.materialize.mock.calls.length;
    await expect(o.service.recoverSourceGroundingDefer("workspace-1", "recover")).rejects.toThrow(/proof/);
    await expect(o.service.redriveSourceGroundingDefer("workspace-1", "recover")).rejects.toThrow();
    expect(o.materialize).toHaveBeenCalledTimes(count);
  } finally { await h.close(); }
});
