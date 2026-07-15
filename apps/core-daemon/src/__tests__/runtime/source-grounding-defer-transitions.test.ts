import { afterEach, describe, expect, it } from "vitest";
import {
  SignalEventType,
  SignalState
} from "@do-soul/alaya-protocol";
import {
  closeTestDatabases,
  createFileCompetitionHarness,
  createHarness,
  createSignal,
  deferredEvent,
  failedMaterializationEvent,
  fingerprint,
  materializedEvent,
  normalizedEvent,
  reconcile,
  signalEvents
} from "./source-grounding-defer/transition-test-fixture.js";

afterEach(closeTestDatabases);

describe("source-grounding defer transitions", () => {
  it("claims once, persists the patch, and commits only redacted audit metadata", async () => {
    const harness = await createHarness(SignalState.DEFERRED, true);
    const rawPayload = { full_turn_content: "I moved to Berlin." };

    const claim = harness.transitions.claimRedrive({
      workspace_id: "workspace-1",
      signal_id: "signal-1",
      claim_token: "claim-1",
      claim_expires_at: "2026-07-15T01:00:00.000Z",
      raw_payload: rawPayload,
      audit_event: normalizedEvent({
        source_grounding_redrive_patch: {
          raw_payload_redacted: true,
          raw_payload_sha256: "sha256:fixture"
        }
      })
    });
    const second = harness.transitions.claimRedrive({
      workspace_id: "workspace-1",
      signal_id: "signal-1",
      claim_token: "claim-2",
      claim_expires_at: "2026-07-15T02:00:00.000Z",
      audit_event: normalizedEvent({ duplicate: true })
    });

    expect(claim?.signal.raw_payload).toEqual(rawPayload);
    expect(second).toBeNull();
    expect(harness.queueRepo.get("workspace-1", "signal-1")).toMatchObject({
      claim_token_fingerprint: fingerprint("claim-1")
    });
    expect(harness.queueRepo.get("workspace-1", "signal-1")).not.toHaveProperty("claim_token");
    const events = await signalEvents(harness);
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("I moved to Berlin.");
  });

  it("rolls back audit and queue claim when signal CAS misses", async () => {
    const harness = await createHarness(SignalState.MATERIALIZED, true);

    expect(harness.transitions.claimRedrive({
      workspace_id: "workspace-1",
      signal_id: "signal-1",
      claim_token: "claim-1",
      claim_expires_at: "2026-07-15T01:00:00.000Z",
      raw_payload: { full_turn_content: "patched" },
      audit_event: normalizedEvent({ full_turn_content: "patched" })
    })).toBeNull();

    expect(harness.queueRepo.get("workspace-1", "signal-1")?.claim_token_fingerprint).toBeNull();
    expect(await signalEvents(harness)).toEqual([]);
    await expect(harness.signalRepo.getById("signal-1")).resolves.toMatchObject({
      signal_state: SignalState.MATERIALIZED,
      raw_payload: { full_turn_content: "original" }
    });
  });

  it("rolls back event and signal state when defer enqueue fails", async () => {
    const harness = await createHarness(SignalState.COMPILED, false);
    harness.database.connection.exec(`
      CREATE TRIGGER fail_defer_enqueue
      BEFORE INSERT ON source_grounding_defer_queue
      BEGIN SELECT RAISE(ABORT, 'injected defer enqueue failure'); END;
    `);

    expect(() => harness.transitions.recordDefer({
      signal: harness.signal,
      defer_reason: "source_assertion_incomplete",
      events: [materializedEvent(), deferredEvent()]
    })).toThrow("Failed to enqueue source grounding defer row");

    await expect(harness.signalRepo.getById("signal-1")).resolves.toMatchObject({
      signal_state: SignalState.COMPILED
    });
    expect(harness.queueRepo.get("workspace-1", "signal-1")).toBeNull();
    expect(await signalEvents(harness)).toEqual([]);
  });

  it("rolls back before state or queue mutation when EventLog append fails", async () => {
    const harness = await createHarness(SignalState.COMPILED, false);
    harness.database.connection.exec(`
      CREATE TRIGGER fail_defer_event
      BEFORE INSERT ON event_log
      WHEN NEW.event_type = 'soul.signal.materialized'
      BEGIN SELECT RAISE(ABORT, 'injected event failure'); END;
    `);

    expect(() => harness.transitions.recordDefer({
      signal: harness.signal,
      defer_reason: "source_assertion_incomplete",
      events: [materializedEvent(), deferredEvent()]
    })).toThrow();

    await expect(harness.signalRepo.getById("signal-1")).resolves.toMatchObject({
      signal_state: SignalState.COMPILED
    });
    expect(harness.queueRepo.get("workspace-1", "signal-1")).toBeNull();
    expect(await signalEvents(harness)).toEqual([]);
  });

  it("preserves active claims and the new defer obligation when the workspace cap is full", async () => {
    const harness = await createHarness(SignalState.DEFERRED, true, 1);
    expect(harness.transitions.claimRedrive({
      workspace_id: "workspace-1",
      signal_id: "signal-1",
      claim_token: "active-claim",
      claim_expires_at: "2026-07-15T01:00:00.000Z"
    })).not.toBeNull();
    const second = createSignal("signal-2");
    await harness.signalRepo.create(second);
    const compiled = await harness.signalRepo.updateState(second.signal_id, SignalState.COMPILED);

    const committed = harness.transitions.recordDefer({
      signal: compiled,
      defer_reason: "source_assertion_incomplete",
      events: [materializedEvent("signal-2"), deferredEvent("signal-2")]
    });

    expect(committed.events.map((event) => event.event_type)).toEqual([
      SignalEventType.SOUL_SIGNAL_MATERIALIZED,
      SignalEventType.SOUL_SIGNAL_TRIAGED
    ]);
    expect(committed.signal.signal_state).toBe(SignalState.DEFERRED);
    expect(harness.queueRepo.get("workspace-1", "signal-1")?.claim_token_fingerprint).toBe(
      fingerprint("active-claim")
    );
    expect(harness.queueRepo.list("workspace-1").map((entry) => entry.signal_id)).toEqual([
      "signal-1",
      "signal-2"
    ]);
    expect(harness.transitions.claimRedrive({
      workspace_id: "workspace-1",
      signal_id: "signal-2",
      claim_token: "blocked-overflow-claim",
      claim_expires_at: "2026-07-15T02:00:00.000Z"
    })).toBeNull();

    harness.transitions.completeRedrive({
      workspace_id: "workspace-1",
      signal_id: "signal-1",
      claim_token: "active-claim",
      event: materializedEvent("signal-1")
    });
    expect(harness.transitions.claimRedrive({
      workspace_id: "workspace-1",
      signal_id: "signal-2",
      claim_token: "recovered-overflow-claim",
      claim_expires_at: "2026-07-15T03:00:00.000Z"
    })).not.toBeNull();
  });

  it("rolls back completion when claimed queue removal fails", async () => {
    const harness = await createHarness(SignalState.DEFERRED, true);
    const claim = harness.transitions.claimRedrive({
      workspace_id: "workspace-1",
      signal_id: "signal-1",
      claim_token: "claim-1",
      claim_expires_at: "2026-07-15T01:00:00.000Z"
    });
    expect(claim).not.toBeNull();
    harness.database.connection.exec(`
      CREATE TRIGGER fail_claimed_delete
      BEFORE DELETE ON source_grounding_defer_queue
      BEGIN SELECT RAISE(ABORT, 'injected claimed delete failure'); END;
    `);

    expect(() => harness.transitions.completeRedrive({
      workspace_id: "workspace-1",
      signal_id: "signal-1",
      claim_token: "claim-1",
      event: materializedEvent()
    })).toThrow();

    await expect(harness.signalRepo.getById("signal-1")).resolves.toMatchObject({
      signal_state: SignalState.DEFERRED
    });
    expect(harness.queueRepo.get("workspace-1", "signal-1")?.claim_token_fingerprint).toBe(
      fingerprint("claim-1")
    );
    expect(await signalEvents(harness)).toEqual([]);
  });

  it("records redrive failure while retaining the claim and blocking concurrent retry", async () => {
    const harness = await createHarness(SignalState.DEFERRED, true);
    expect(harness.transitions.claimRedrive({
      workspace_id: "workspace-1",
      signal_id: "signal-1",
      claim_token: "uncertain-claim",
      claim_expires_at: "2026-07-15T01:00:00.000Z"
    })).not.toBeNull();

    harness.transitions.failRedrive({
      workspace_id: "workspace-1",
      signal_id: "signal-1",
      claim_token: "uncertain-claim",
      event: failedMaterializationEvent()
    });

    expect(harness.queueRepo.get("workspace-1", "signal-1")?.claim_token_fingerprint).toBe(
      fingerprint("uncertain-claim")
    );
    expect(harness.transitions.claimRedrive({
      workspace_id: "workspace-1",
      signal_id: "signal-1",
      claim_token: "concurrent-claim",
      claim_expires_at: "2026-07-15T02:00:00.000Z"
    })).toBeNull();
    await expect(harness.signalRepo.getById("signal-1")).resolves.toMatchObject({
      signal_state: SignalState.DEFERRED
    });
    expect((await signalEvents(harness)).map((event) => event.event_type)).toEqual([
      SignalEventType.SOUL_SIGNAL_MATERIALIZATION_FAILED
    ]);
  });

  it("never steals an expired claim and clears it only through audited reconciliation", async () => {
    const harness = await createHarness(SignalState.DEFERRED, true);
    expect(harness.transitions.claimRedrive({
      workspace_id: "workspace-1",
      signal_id: "signal-1",
      claim_token: "crashed-claim",
      claim_expires_at: "2000-01-01T00:00:00.000Z"
    })).not.toBeNull();
    expect(harness.transitions.claimRedrive({
      workspace_id: "workspace-1",
      signal_id: "signal-1",
      claim_token: "stolen-claim",
      claim_expires_at: "2030-01-01T00:00:00.000Z"
    })).toBeNull();

    expect(() => harness.transitions.reconcileStaleClaim({
      workspace_id: "workspace-1",
      signal_id: "signal-1",
      claim_token_fingerprint: fingerprint("crashed-claim"),
      claim_expires_at: "1999-01-01T00:00:00.000Z",
      expired_before: "2026-07-15T00:00:00.000Z",
      event: normalizedEvent({ reconciliation: "stale-view" })
    })).toThrow("active or no longer matches");
    expect(harness.queueRepo.get("workspace-1", "signal-1")?.claim_token_fingerprint).toBe(
      fingerprint("crashed-claim")
    );
    expect(await signalEvents(harness)).toHaveLength(0);

    harness.transitions.reconcileStaleClaim({
      workspace_id: "workspace-1",
      signal_id: "signal-1",
      claim_token_fingerprint: fingerprint("crashed-claim"),
      claim_expires_at: "2000-01-01T00:00:00.000Z",
      expired_before: "2026-07-15T00:00:00.000Z",
      event: normalizedEvent({ reconciliation: "operator-confirmed" })
    });

    expect(harness.queueRepo.get("workspace-1", "signal-1")?.claim_token_fingerprint).toBeNull();
    expect(await signalEvents(harness)).toHaveLength(1);
  });

  it("rejects a stale reconciler across two file-backed SQLite connections", async () => {
    const harness = await createFileCompetitionHarness();
    try {
      expect(harness.first.transitions.claimRedrive({
        workspace_id: "workspace-1",
        signal_id: "signal-1",
        claim_token: "first-claim",
        claim_expires_at: "2000-01-01T00:00:00.000Z"
      })).not.toBeNull();
      const staleView = harness.second.queueRepo.get("workspace-1", "signal-1")!;

      reconcile(harness.first.transitions, staleView, "first-claim-cleared");
      expect(harness.first.transitions.claimRedrive({
        workspace_id: "workspace-1",
        signal_id: "signal-1",
        claim_token: "replacement-claim",
        claim_expires_at: "2001-01-01T00:00:00.000Z"
      })).not.toBeNull();

      expect(() => reconcile(
        harness.second.transitions,
        staleView,
        "stale-competitor"
      )).toThrow("active or no longer matches");
      expect(harness.second.queueRepo.get("workspace-1", "signal-1")).toMatchObject({
        claim_token_fingerprint: fingerprint("replacement-claim")
      });
      await expect(harness.second.eventLogRepo.queryByEntityAll(
        "candidate_memory_signal",
        "signal-1"
      )).resolves.toHaveLength(1);
    } finally {
      await harness.close();
    }
  });
});
