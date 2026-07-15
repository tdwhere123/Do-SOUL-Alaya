import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  SignalService,
  createInMemorySourceGroundingDeferQueue,
  type SignalRuntimeNotifier,
  type SignalServicePostTriageMaterializer,
  type SignalServiceWarnPort,
  type SourceGroundingDeferQueueStatePort,
  type SourceGroundingDeferTransitionPort
} from "../../memory/signal-service.js";
import { createSignal } from "./signal-service.test-support.js";
function createDeferredMaterialization(reason: string) {
  return {
    signal_id: "signal-1",
    target_kind: "deferred" as const,
    routing_reason: `garden source grounding failed: ${reason}`,
    defer_reason: reason,
    defer_class: "source_grounding" as const,
    created_objects: [] as const,
    success: true as const
  };
}
function createHarness(options?: {
  readonly queueCap?: number;
  readonly materialize?: ReturnType<typeof vi.fn>;
  readonly notifyEntry?: ReturnType<typeof vi.fn>;
  readonly warn?: ReturnType<typeof vi.fn>;
}) {
  const queue = createInMemorySourceGroundingDeferQueue(options?.queueCap ?? 8);
  const signals = new Map<string, ReturnType<typeof createSignal>>();
  const appendedEvents: Array<{
    event_type: string;
    payload_json: Record<string, unknown>;
  }> = [];
  let appendCallCount = 0;
  const materialize =
    options?.materialize ??
    vi.fn(async () => createDeferredMaterialization("source_assertion_not_self_contained"));
  const notifyEntry = options?.notifyEntry ?? vi.fn(async () => undefined);
  const materializePort = materialize as unknown as SignalServicePostTriageMaterializer["materialize"];
  const notifyPort = notifyEntry as unknown as SignalRuntimeNotifier["notifyEntry"];
  const warnPort = options?.warn as unknown as SignalServiceWarnPort | undefined;
  const appendEvent = (
    event: Parameters<SourceGroundingDeferTransitionPort["recordDefer"]>[0]["events"][number]
  ) => {
    appendCallCount += 1;
    appendedEvents.push({
      event_type: event.event_type,
      payload_json: event.payload_json as Record<string, unknown>
    });
    return {
      event_id: `evt_${appendCallCount}`,
      created_at: "2026-07-14T00:00:00.000Z",
      revision: 0,
      ...event
    };
  };
  const transitions: SourceGroundingDeferTransitionPort = {
    recordDefer: (input) => {
      if (
        input.claim_token !== undefined &&
        !queue.ownsClaim(input.signal.workspace_id, input.signal.signal_id, input.claim_token)
      ) {
        throw new Error("claim mismatch");
      }
      const signal = { ...input.signal, signal_state: "deferred" as const };
      signals.set(signal.signal_id, signal);
      const queue_result = queue.enqueue({
        signal_id: signal.signal_id,
        workspace_id: signal.workspace_id,
        run_id: signal.run_id,
        defer_reason: input.defer_reason
      });
      return {
        signal,
        events: [appendEvent(input.events[0]), appendEvent(input.events[1])],
        queue_result
      };
    },
    claimRedrive: (input) => {
      const signal = signals.get(input.signal_id);
      if (
        signal?.workspace_id !== input.workspace_id ||
        signal.signal_state !== "deferred" ||
        queue.claim(
          input.workspace_id,
          input.signal_id,
          input.claim_token,
          fingerprint(input.claim_token),
          input.claim_expires_at
        ) === null
      ) return null;
      const claimed = {
        ...signal,
        ...(input.raw_payload === undefined ? {} : { raw_payload: input.raw_payload })
      };
      signals.set(input.signal_id, claimed);
      return {
        signal: claimed,
        audit_event: input.audit_event === undefined ? null : appendEvent(input.audit_event),
        claim_token: input.claim_token
      };
    },
    completeRedrive: (input) => {
      const signal = requireClaimedSignal(input.workspace_id, input.signal_id, input.claim_token);
      const materialized = { ...signal, signal_state: "materialized" as const };
      signals.set(input.signal_id, materialized);
      queue.removeClaimed(input.workspace_id, input.signal_id, input.claim_token);
      return { signal: materialized, event: appendEvent(input.event) };
    },
    failRedrive: (input) => {
      const signal = requireClaimedSignal(input.workspace_id, input.signal_id, input.claim_token);
      return { signal, event: appendEvent(input.event) };
    },
    reconcileStaleClaim: (input) => {
      const claim = requireClaimCapability(queue, input.workspace_id, input.signal_id);
      const signal = signals.get(input.signal_id);
      if (
        signal?.workspace_id !== input.workspace_id ||
        fingerprint(claim.claimToken) !== input.claim_token_fingerprint ||
        claim.claimExpiresAt !== input.claim_expires_at || claim.claimExpiresAt > input.expired_before
      ) {
        throw new Error("claim active or no longer matches");
      }
      queue.clearExpiredClaim({
        workspaceId: input.workspace_id,
        signalId: input.signal_id,
        claimToken: claim.claimToken,
        claimExpiresAt: input.claim_expires_at,
        expiredBefore: input.expired_before
      });
      return { signal, event: appendEvent(input.event) };
    }
  };
  function requireClaimedSignal(workspaceId: string, signalId: string, claimToken: string) {
    const signal = signals.get(signalId);
    if (signal?.workspace_id !== workspaceId || !queue.ownsClaim(workspaceId, signalId, claimToken)) {
      throw new Error("claim mismatch");
    }
    return signal;
  }
  const service = new SignalService({
    eventLogRepo: {
      append: vi.fn((event) => appendEvent(event)),
      queryByEntity: vi.fn(async () => [])
    },
    signalRepo: {
      create: vi.fn(async (signal) => {
        const stored = { ...signal, signal_state: "emitted" as const };
        signals.set(stored.signal_id, stored);
        return stored;
      }),
      getById: vi.fn(async (signalId) => signals.get(signalId) ?? null),
      listByRun: vi.fn(async () => []),
      updateState: vi.fn(async (signalId, state) => {
        const existing = signals.get(signalId) ?? createSignal({ signal_id: signalId });
        const next = { ...existing, signal_state: state };
        signals.set(signalId, next);
        return next;
      })
    },
    runtimeNotifier: { notifyEntry: async (entry) => await notifyPort(entry) },
    sourceGroundingDeferQueue: queue,
    sourceGroundingDeferTransitions: transitions,
    postTriageMaterializer: { materialize: async (signal) => await materializePort(signal) },
    ...(warnPort === undefined ? {} : { warn: warnPort })
  });

  return {
    service,
    queue,
    signals,
    appendedEvents,
    materialize,
    notifyEntry,
    transitions
  };
}

function requireClaimCapability(
  queue: SourceGroundingDeferQueueStatePort,
  workspaceId: string,
  signalId: string
) {
  const claim = queue.readClaimCapability(workspaceId, signalId);
  if (claim === null) throw new Error("claim mismatch");
  return claim;
}
describe("SignalService source grounding defer queue", () => {
  it("tags defer reason on EventLog and enqueues for re-drive", async () => {
    const { service, queue, appendedEvents, notifyEntry } = createHarness();
    const result = await service.receiveSignal(
      createSignal({
        source: "garden_compile",
        confidence: 0.9,
        evidence_refs: ["ev-1"],
        raw_payload: {
          proposed_matched_text: "这个更好。",
          full_turn_content: "方案 A 和方案 B。这个更好。"
        }
      })
    );

    expect(result.triage_result).toBe("deferred");
    expect(result.signal.signal_state).toBe("deferred");
    expect(appendedEvents.slice(-2).map((event) => event.event_type)).toEqual([
      "soul.signal.materialized",
      "soul.signal.triaged"
    ]);
    expect(notifyEntry.mock.calls.slice(-2).map(([event]) => event.event_type)).toEqual([
      "soul.signal.materialized",
      "soul.signal.triaged"
    ]);

    const corrective = appendedEvents.find(
      (event) =>
        event.event_type === "soul.signal.triaged" &&
        event.payload_json["triage_result"] === "deferred" &&
        event.payload_json["defer_class"] === "source_grounding"
    );
    expect(corrective?.payload_json["defer_reason"]).toBe("source_assertion_not_self_contained");
    expect(queue.get("workspace-1", "signal-1")?.defer_reason).toBe("source_assertion_not_self_contained");
    expect(service.getSourceGroundingDeferStats("workspace-1").deferred_by_reason).toEqual({
      source_assertion_not_self_contained: 1
    });
  });

  it("keeps a committed defer durable when post-commit notification fails", async () => {
    const notifyEntry = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("runtime broadcast unavailable"))
      .mockResolvedValueOnce(undefined);
    const warn = vi.fn();
    const { service, queue, signals } = createHarness({ notifyEntry, warn });

    const result = await service.receiveSignal(
      createSignal({ source: "garden_compile", confidence: 0.9, evidence_refs: ["ev-1"] })
    );

    expect(result.signal.signal_state).toBe("deferred");
    expect(signals.get("signal-1")?.signal_state).toBe("deferred");
    expect(queue.get("workspace-1", "signal-1")).not.toBeNull();
    expect(notifyEntry).toHaveBeenCalledTimes(4);
    expect(warn).toHaveBeenCalledWith(
      "Committed signal event notification failed; EventLog remains replayable.",
      {
        phase: "event_notification",
        code: "RUNTIME_NOTIFY_FAILED",
        detail_sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        detail_char_count: expect.any(Number)
      }
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("runtime broadcast unavailable");
  });

  it("re-drives a fixed-up signal through grounding and materializes", async () => {
    const materialize = vi
      .fn()
      .mockResolvedValueOnce(createDeferredMaterialization("source_assertion_incomplete"))
      .mockResolvedValueOnce({
        signal_id: "signal-1",
        target_kind: "memory_and_claim" as const,
        routing_reason: "object_kind routed",
        created_objects: [{ object_kind: "memory_entry", object_id: "mem-1" }],
        success: true as const
      });
    const { service, queue, signals, appendedEvents } = createHarness({ materialize });

    await service.receiveSignal(
      createSignal({
        source: "garden_compile",
        confidence: 0.9,
        evidence_refs: ["ev-1"]
      })
    );
    expect(queue.get("workspace-1", "signal-1")).not.toBeNull();

    const redrive = await service.redriveSourceGroundingDefer("workspace-1", "signal-1", {
      raw_payload: {
        proposed_matched_text: "I moved to Berlin.",
        full_turn_content: "I moved to Berlin.",
        private_medical_label: "do-not-audit-this-key"
      }
    });

    expect(redrive.triage_result).toBe("accepted");
    expect(redrive.signal.signal_state).toBe("materialized");
    expect(redrive.materialization?.target_kind).toBe("memory_and_claim");
    expect(queue.get("workspace-1", "signal-1")).toBeNull();
    expect(materialize).toHaveBeenCalledTimes(2);
    expect(signals.get("signal-1")?.raw_payload).toEqual({
      proposed_matched_text: "I moved to Berlin.",
      full_turn_content: "I moved to Berlin.",
      private_medical_label: "do-not-audit-this-key"
    });
    const patchAudit = appendedEvents.find((event) =>
      event.event_type === "soul.signal.normalized" &&
      "source_grounding_redrive_patch" in
        (event.payload_json["normalized_fields"] as Record<string, unknown>)
    );
    expect(patchAudit).toEqual(expect.objectContaining({
      event_type: "soul.signal.normalized",
      payload_json: expect.objectContaining({
        normalized_fields: expect.objectContaining({
          source_grounding_redrive_patch: expect.objectContaining({
            changed_field_count: 4,
            raw_payload_redacted: true,
            raw_payload_key_count: 3
          })
        })
      })
    }));
    expect(JSON.stringify(patchAudit)).not.toContain("I moved to Berlin.");
    expect(JSON.stringify(patchAudit)).not.toContain("private_medical_label");
    expect(JSON.stringify(patchAudit)).not.toContain("do-not-audit-this-key");
  });

  it("re-drives a still-bad signal and defers again with queue entry", async () => {
    const { service, queue } = createHarness();
    await service.receiveSignal(
      createSignal({
        source: "garden_compile",
        confidence: 0.9,
        evidence_refs: ["ev-1"]
      })
    );

    const redrive = await service.redriveSourceGroundingDefer("workspace-1", "signal-1");
    expect(redrive.triage_result).toBe("deferred");
    expect(redrive.signal.signal_state).toBe("deferred");
    expect(queue.get("workspace-1", "signal-1")?.defer_reason).toBe("source_assertion_not_self_contained");
    expect(service.getSourceGroundingDeferStats("workspace-1").deferred_by_reason).toEqual({
      source_assertion_not_self_contained: 2
    });
  });

  it("enforces the FIFO queue bound and keeps lifetime reason counts", async () => {
    const materialize = vi.fn(async (signal: { signal_id: string }) => ({
      ...createDeferredMaterialization("source_assertion_too_long"),
      signal_id: signal.signal_id
    }));
    const { service, queue } = createHarness({ queueCap: 2, materialize });

    for (let index = 1; index <= 3; index += 1) {
      await service.receiveSignal(
        createSignal({
          signal_id: `signal-${index}`,
          source: "garden_compile",
          confidence: 0.9,
          evidence_refs: ["ev-1"]
        })
      );
    }

    expect(queue.list("workspace-1")).toHaveLength(2);
    expect(queue.get("workspace-1", "signal-1")).toBeNull();
    expect(queue.get("workspace-1", "signal-2")).not.toBeNull();
    expect(queue.get("workspace-1", "signal-3")).not.toBeNull();
    expect(service.getSourceGroundingDeferStats("workspace-1")).toMatchObject({
      queue_depth: 2,
      queue_cap: 2,
      deferred_by_reason: { source_assertion_too_long: 3 }
    });
  });

  it("refuses to redrive a deferred signal that is not a source-grounding queue member", async () => {
    const { service, signals, materialize } = createHarness();
    signals.set("signal-unowned", createSignal({
      signal_id: "signal-unowned",
      signal_state: "deferred"
    }));

    await expect(
      service.redriveSourceGroundingDefer("workspace-1", "signal-unowned")
    ).rejects.toThrow("not queued, not deferred, or already claimed");
    expect(materialize).not.toHaveBeenCalled();
  });

  it("allows only one concurrent redrive claim", async () => {
    const materialize = vi
      .fn()
      .mockResolvedValueOnce(createDeferredMaterialization("source_assertion_incomplete"))
      .mockResolvedValue({
        signal_id: "signal-1",
        target_kind: "memory_and_claim" as const,
        routing_reason: "object_kind routed",
        created_objects: [{ object_kind: "memory_entry", object_id: "mem-1" }],
        success: true as const
      });
    const { service } = createHarness({ materialize });
    await service.receiveSignal(createSignal({ source: "garden_compile", confidence: 0.9 }));

    const results = await Promise.allSettled([
      service.redriveSourceGroundingDefer("workspace-1", "signal-1"),
      service.redriveSourceGroundingDefer("workspace-1", "signal-1")
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(materialize).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: "partial created objects",
      createdObjects: [{ object_kind: "memory_entry", object_id: "partial-memory" }]
    },
    { name: "zero reported objects with unknown side effects", createdObjects: [] }
  ])("retains the claim after $name until operator reconciliation", async ({ createdObjects }) => {
    const materialize = vi
      .fn()
      .mockResolvedValueOnce(createDeferredMaterialization("source_assertion_incomplete"))
      .mockResolvedValueOnce({
        signal_id: "signal-1",
        target_kind: "memory_and_claim" as const,
        routing_reason: "object_kind routed",
        created_objects: createdObjects,
        success: false as const,
        error: "materialization failed after an uncertain side-effect boundary"
      });
    const { service, queue, appendedEvents } = createHarness({ materialize });
    await service.receiveSignal(createSignal({ source: "garden_compile", confidence: 0.9 }));

    const failed = await service.redriveSourceGroundingDefer("workspace-1", "signal-1");

    expect(failed.signal.signal_state).toBe("deferred");
    expect(queue.get("workspace-1", "signal-1")?.claim_token_fingerprint).not.toBeNull();
    expect(queue.get("workspace-1", "signal-1")).not.toBeNull();
    expect(appendedEvents.at(-1)?.event_type).toBe("soul.signal.materialization_failed");
    expect(JSON.stringify(appendedEvents.at(-1))).not.toContain(
      "materialization failed after an uncertain side-effect boundary"
    );
    await expect(
      service.redriveSourceGroundingDefer("workspace-1", "signal-1")
    ).rejects.toThrow("already claimed");
    expect(materialize).toHaveBeenCalledTimes(2);
  });

  it("requires explicit reconciliation before retrying an expired crash claim", async () => {
    const materialize = vi
      .fn()
      .mockResolvedValueOnce(createDeferredMaterialization("source_assertion_incomplete"))
      .mockResolvedValueOnce({
        signal_id: "signal-1",
        target_kind: "memory_and_claim" as const,
        routing_reason: "object_kind routed",
        created_objects: [{ object_kind: "memory_entry", object_id: "mem-1" }],
        success: true as const
      });
    const { service, transitions, appendedEvents } = createHarness({ materialize });
    await service.receiveSignal(createSignal({ source: "garden_compile", confidence: 0.9 }));
    const crashClaim = transitions.claimRedrive({
      workspace_id: "workspace-1",
      signal_id: "signal-1",
      claim_token: "crashed-attempt",
      claim_expires_at: "2000-01-01T00:00:00.000Z"
    });
    expect(crashClaim).not.toBeNull();
    await expect(
      service.redriveSourceGroundingDefer("workspace-1", "signal-1")
    ).rejects.toThrow("already claimed");
    expect(materialize).toHaveBeenCalledTimes(1);

    await service.reconcileStaleSourceGroundingRedrive({
      workspaceId: "workspace-1",
      signalId: "signal-1",
      claimTokenFingerprint: fingerprint("crashed-attempt"),
      expectedClaimExpiresAt: "2000-01-01T00:00:00.000Z",
      reason: "operator verified the crashed attempt created no durable objects"
    });
    const retried = await service.redriveSourceGroundingDefer("workspace-1", "signal-1");
    expect(retried.signal.signal_state).toBe("materialized");
    expect(materialize).toHaveBeenCalledTimes(2);
    expect(appendedEvents).toContainEqual(expect.objectContaining({
      event_type: "soul.signal.normalized",
      payload_json: expect.objectContaining({
        normalized_fields: expect.objectContaining({
          source_grounding_redrive_reconciliation: expect.objectContaining({
            expected_claim_expires_at: "2000-01-01T00:00:00.000Z",
            claim_token_sha256: fingerprint("crashed-attempt"),
            reason_sha256: expect.stringMatching(/^sha256:/u),
            reason_char_count: 64
          })
        })
      })
    }));
    expect(JSON.stringify(appendedEvents)).not.toContain("crashed-attempt");
    expect(JSON.stringify(appendedEvents)).not.toContain(
      "operator verified the crashed attempt created no durable objects"
    );
  });
});

function fingerprint(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
