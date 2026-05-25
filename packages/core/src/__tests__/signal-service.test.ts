import { describe, expect, it, vi } from "vitest";
import { SignalService } from "../signal-service.js";
import type { CandidateMemorySignal, EventLogEntry } from "@do-soul/alaya-protocol";

function createSignal(overrides: Partial<CandidateMemorySignal> = {}): CandidateMemorySignal {
  const { signal_state, ...restOverrides } = overrides;

  return {
    signal_id: "signal-1",
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    source: "model_tool",
    signal_kind: "potential_claim",
    signal_state: signal_state ?? "emitted",
    object_kind: "constraint",
    scope_hint: null,
    domain_tags: ["security"],
    confidence: 0.5,
    evidence_refs: ["msg-1"],
    source_memory_refs: [],
    supersedes_refs: [],
    exception_to_refs: [],
    contradicts_refs: [],
    incompatible_with_refs: [],
    raw_payload: {
      excerpt: "Never print secrets."
    },
    created_at: "2026-03-18T00:00:00.000Z",
    ...restOverrides
  };
}

describe("SignalService", () => {
  it("writes emitted/triaged events in order and moves accepted signals to triaged", async () => {
    const order: string[] = [];
    const storedEvents: EventLogEntry[] = [];
    const service = new SignalService({
      eventLogRepo: {
        append: vi.fn(async (event) => {
          order.push(`event:${event.event_type}`);
          const stored: EventLogEntry = {
            event_id: `evt_${storedEvents.length + 1}`,
            created_at: `2026-03-18T00:00:0${storedEvents.length + 1}.000Z`,
            revision: storedEvents.length,
            ...event
          };
          storedEvents.push(stored);
          return stored;
        }),
        queryByEntity: vi.fn(async (entityType, entityId) =>
          storedEvents.filter((event) => event.entity_type === entityType && event.entity_id === entityId)
        )
      },
      signalRepo: {
        create: vi.fn(async (signal) => {
          order.push("repo:create");
          return {
            ...signal,
            signal_state: "emitted"
          };
        }),
        getById: vi.fn(async () => null),
        listByRun: vi.fn(async () => []),
        updateState: vi.fn(async (signalId, state) => {
          order.push(`repo:update:${state}`);
          return createSignal({ signal_id: signalId, signal_state: state });
        })
      },
      runtimeNotifier: {
        notifyEntry: vi.fn(async (entry) => {
          order.push(`notify:${entry.event_type}`);
        })
      }
    });

    const result = await service.receiveSignal(createSignal());

    expect(result.signal.signal_id).toBe("signal-1");
    expect(result.signal.signal_state).toBe("triaged");
    expect(result.triage_result).toBe("accepted");
    expect(result.materialization).toBeNull();
    expect(order).toEqual([
      "event:soul.signal.emitted",
      "repo:create",
      "notify:soul.signal.emitted",
      "event:soul.signal.triaged",
      "repo:update:triaged",
      "notify:soul.signal.triaged"
    ]);
    expect(storedEvents.map((event) => event.revision)).toEqual([0, 1]);
    expect(storedEvents[1]).toMatchObject({
      event_type: "soul.signal.triaged",
      payload_json: {
        signal_id: "signal-1",
        triage_result: "accepted"
      }
    });
  });

  it("threads source delivery anchors into the emitted EventLog payload", async () => {
    const storedEvents: EventLogEntry[] = [];
    const service = new SignalService({
      eventLogRepo: {
        append: vi.fn(async (event) => {
          const stored: EventLogEntry = {
            event_id: `evt_${storedEvents.length + 1}`,
            created_at: `2026-03-18T00:00:0${storedEvents.length + 1}.000Z`,
            revision: storedEvents.length,
            ...event
          };
          storedEvents.push(stored);
          return stored;
        }),
        queryByEntity: vi.fn(async () => [])
      },
      signalRepo: {
        create: vi.fn(async (signal) => ({ ...signal, signal_state: "emitted" })),
        getById: vi.fn(async () => null),
        listByRun: vi.fn(async () => []),
        updateState: vi.fn(async (signalId, state) => createSignal({ signal_id: signalId, signal_state: state }))
      },
      runtimeNotifier: {
        notifyEntry: vi.fn(async () => {})
      }
    });

    await service.receiveSignal(createSignal({ source_delivery_ids: ["delivery-1", "delivery-2"] }));

    expect(storedEvents[0]).toMatchObject({
      event_type: "soul.signal.emitted",
      payload_json: {
        signal_id: "signal-1",
        source_delivery_ids: ["delivery-1", "delivery-2"]
      }
    });
  });

  it("threads first-class graph refs into the emitted EventLog payload", async () => {
    const storedEvents: EventLogEntry[] = [];
    const service = new SignalService({
      eventLogRepo: {
        append: vi.fn(async (event) => {
          const stored: EventLogEntry = {
            event_id: `evt_${storedEvents.length + 1}`,
            created_at: `2026-03-18T00:00:0${storedEvents.length + 1}.000Z`,
            revision: storedEvents.length,
            ...event
          };
          storedEvents.push(stored);
          return stored;
        }),
        queryByEntity: vi.fn(async () => [])
      },
      signalRepo: {
        create: vi.fn(async (signal) => ({ ...signal, signal_state: "emitted" })),
        getById: vi.fn(async () => null),
        listByRun: vi.fn(async () => []),
        updateState: vi.fn(async (signalId, state) => createSignal({ signal_id: signalId, signal_state: state }))
      },
      runtimeNotifier: {
        notifyEntry: vi.fn(async () => {})
      }
    });

    await service.receiveSignal(
      createSignal({
        source_memory_refs: ["memory-source"],
        supersedes_refs: ["memory-old"],
        exception_to_refs: ["memory-rule"],
        contradicts_refs: ["memory-contradiction"],
        incompatible_with_refs: ["memory-incompatible"]
      })
    );

    expect(storedEvents[0]).toMatchObject({
      event_type: "soul.signal.emitted",
      payload_json: {
        signal_id: "signal-1",
        source_memory_refs: ["memory-source"],
        supersedes_refs: ["memory-old"],
        exception_to_refs: ["memory-rule"],
        contradicts_refs: ["memory-contradiction"],
        incompatible_with_refs: ["memory-incompatible"]
      }
    });
  });

  it("resumes an existing emitted signal through triage and materialization", async () => {
    const appendedEvents: string[] = [];
    const stateUpdates: string[] = [];
    const signalRepo = {
      create: vi.fn(async (signal: CandidateMemorySignal) => ({ ...signal, signal_state: "emitted" as const })),
      getById: vi.fn(async () => createSignal({ signal_state: "emitted" })),
      listByRun: vi.fn(async () => []),
      updateState: vi.fn(async (signalId: string, state: CandidateMemorySignal["signal_state"]) => {
        stateUpdates.push(state);
        return createSignal({ signal_id: signalId, signal_state: state });
      })
    };
    const materialize = vi.fn(async (signal: CandidateMemorySignal) => ({
      signal_id: signal.signal_id,
      target_kind: "memory_and_claim" as const,
      routing_reason: "retry resumed after signal row creation",
      created_objects: [{ object_kind: "memory_entry", object_id: "memory-1" }],
      success: true
    }));
    const service = new SignalService({
      eventLogRepo: {
        append: vi.fn(async (event) => {
          appendedEvents.push(event.event_type);
          return {
            event_id: `evt_${appendedEvents.length}`,
            created_at: "2026-03-18T00:00:01.000Z",
            revision: appendedEvents.length - 1,
            ...event
          };
        }),
        queryByEntity: vi.fn(async () => [])
      },
      signalRepo,
      runtimeNotifier: {
        notifyEntry: vi.fn(async () => {})
      },
      postTriageMaterializer: {
        materialize
      }
    });

    const result = await service.receiveSignal(createSignal());

    expect(signalRepo.create).not.toHaveBeenCalled();
    expect(result.signal.signal_state).toBe("materialized");
    expect(appendedEvents).toEqual([
      "soul.signal.triaged",
      "soul.signal.materialized"
    ]);
    expect(stateUpdates).toEqual(["triaged", "compiled", "materialized"]);
    expect(materialize).toHaveBeenCalledWith(expect.objectContaining({ signal_state: "compiled" }));
  });

  it("does not replay materialization side effects for post-triage signal states", async () => {
    for (const state of ["triaged", "compiled"] as const) {
      const materialize = vi.fn(async () => {
        throw new Error("should not rerun materialization");
      });
      const warn = vi.fn();
      const service = new SignalService({
        eventLogRepo: {
          append: vi.fn(),
          queryByEntity: vi.fn(async () => [])
        } as any,
        signalRepo: {
          create: vi.fn(),
          getById: vi.fn(async () => createSignal({ signal_state: state })),
          listByRun: vi.fn(async () => []),
          updateState: vi.fn()
        } as any,
        runtimeNotifier: {
          notifyEntry: vi.fn()
        } as any,
        postTriageMaterializer: {
          materialize
        },
        warn
      });

      const result = await service.receiveSignal(createSignal());

      expect(result.signal.signal_state).toBe(state);
      expect(result.materialization).toBeNull();
      expect(materialize).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        "Signal replay found a post-triage signal; not replaying materialization side effects.",
        expect.objectContaining({
          signal_id: "signal-1",
          signal_state: state
        })
      );
    }
  });

  it("rejects an idempotent replay whose candidate content changed", async () => {
    const service = new SignalService({
      eventLogRepo: {
        append: vi.fn(),
        queryByEntity: vi.fn(async () => [])
      } as any,
      signalRepo: {
        create: vi.fn(),
        getById: vi.fn(async () => createSignal({
          raw_payload: { excerpt: "original signal" }
        })),
        listByRun: vi.fn(async () => []),
        updateState: vi.fn()
      } as any,
      runtimeNotifier: {
        notifyEntry: vi.fn()
      } as any
    });

    await expect(
      service.receiveSignal(createSignal({
        raw_payload: { excerpt: "changed signal" }
      }))
    ).rejects.toThrow("Candidate signal replay does not match existing signal content");
  });

  it("defers low-confidence potential_conflict signals", async () => {
    const service = new SignalService({
      eventLogRepo: {
        append: vi.fn(async (event) => ({
          event_id: "evt_1",
          created_at: "2026-03-18T00:00:01.000Z",
          revision: 0,
          ...event
        })),
        queryByEntity: vi.fn(async () => [])
      },
      signalRepo: {
        create: vi.fn(async (signal) => ({ ...signal, signal_state: "emitted" })),
        getById: vi.fn(async () => null),
        listByRun: vi.fn(async () => []),
        updateState: vi.fn(async (signalId, state) => createSignal({ signal_id: signalId, signal_state: state }))
      },
      runtimeNotifier: {
        notifyEntry: vi.fn(async () => {})
      },
      postTriageMaterializer: {
        materialize: vi.fn(async () => {
          throw new Error("should not run for deferred signals");
        })
      }
    });

    const result = await service.receiveSignal(
      createSignal({
        signal_kind: "potential_conflict",
        confidence: 0.2
      })
    );

    expect(result.triage_result).toBe("deferred");
    expect(result.signal.signal_state).toBe("deferred");
    expect(result.materialization).toBeNull();
  });

  it("defers invalid schema-grounded signals before materialization can write memory", async () => {
    const materialize = vi.fn(async () => {
      throw new Error("should not run for invalid schema-grounded signals");
    });
    const service = new SignalService({
      eventLogRepo: {
        append: vi.fn(async (event) => ({
          event_id: "evt_1",
          created_at: "2026-03-18T00:00:01.000Z",
          revision: 0,
          ...event
        })),
        queryByEntity: vi.fn(async () => [])
      },
      signalRepo: {
        create: vi.fn(async (signal) => ({ ...signal, signal_state: "emitted" })),
        getById: vi.fn(async () => null),
        listByRun: vi.fn(async () => []),
        updateState: vi.fn(async (signalId, state) => createSignal({ signal_id: signalId, signal_state: state }))
      },
      runtimeNotifier: {
        notifyEntry: vi.fn(async () => {})
      },
      postTriageMaterializer: {
        materialize
      }
    });

    const result = await service.receiveSignal(
      createSignal({
        confidence: 0.9,
        raw_payload: {
          schema_grounding: { version: 1 },
          detected_object: { object_kind: "constraint" },
          field_candidates: [],
          validation_result: { status: "deferred", reasons: ["field_candidates missing"] }
        }
      })
    );

    expect(result.triage_result).toBe("deferred");
    expect(result.signal.signal_state).toBe("deferred");
    expect(result.materialization).toBeNull();
    expect(materialize).not.toHaveBeenCalled();
  });

  it("materializes accepted signals when post-triage materializer succeeds", async () => {
    const service = new SignalService({
      eventLogRepo: {
        append: vi.fn(async (event) => ({
          event_id: "evt_1",
          created_at: "2026-03-18T00:00:01.000Z",
          revision: 0,
          ...event
        })),
        queryByEntity: vi.fn(async () => [])
      },
      signalRepo: {
        create: vi.fn(async (signal) => ({ ...signal, signal_state: "emitted" })),
        getById: vi.fn(async () => null),
        listByRun: vi.fn(async () => []),
        updateState: vi.fn(async (signalId, state) => createSignal({ signal_id: signalId, signal_state: state }))
      },
      runtimeNotifier: {
        notifyEntry: vi.fn(async () => {})
      },
      postTriageMaterializer: {
        materialize: vi.fn(async (signal) => ({
          signal_id: signal.signal_id,
          target_kind: "memory_and_claim" as const,
          routing_reason: "reusable signal with evidence support",
          created_objects: [
            { object_kind: "evidence_capsule", object_id: "evidence-1" },
            { object_kind: "memory_entry", object_id: "memory-1" },
            { object_kind: "claim_form", object_id: "claim-1" }
          ],
          success: true
        }))
      }
    });

    const result = await service.receiveSignal(createSignal());

    expect(result.signal.signal_state).toBe("materialized");
    expect(result.materialization).toMatchObject({
      target_kind: "memory_and_claim" as const,
      success: true,
      created_objects: expect.arrayContaining([
        expect.objectContaining({ object_kind: "memory_entry", object_id: "memory-1" })
      ])
    });
  });

  it("marks the signal failed when post-triage materializer throws", async () => {
    const warn = vi.fn();
    const service = new SignalService({
      eventLogRepo: {
        append: vi.fn(async (event) => ({
          event_id: "evt_1",
          created_at: "2026-03-18T00:00:01.000Z",
          revision: 0,
          ...event
        })),
        queryByEntity: vi.fn(async () => [])
      },
      signalRepo: {
        create: vi.fn(async (signal) => ({ ...signal, signal_state: "emitted" })),
        getById: vi.fn(async () => null),
        listByRun: vi.fn(async () => []),
        updateState: vi.fn(async (signalId, state) => createSignal({ signal_id: signalId, signal_state: state }))
      },
      runtimeNotifier: {
        notifyEntry: vi.fn(async () => {})
      },
      postTriageMaterializer: {
        materialize: vi.fn(async () => {
          throw new Error("materializer exploded");
        })
      },
      warn
    });

    const result = await service.receiveSignal(createSignal());

    expect(result.signal.signal_state).toBe("failed");
    expect(result.materialization).toMatchObject({
      success: false,
      routing_reason: "materialization_exception"
    });
    expect(warn).toHaveBeenCalledWith(
      "Signal materialization failed.",
      expect.objectContaining({
        signal_id: "signal-1",
        error: expect.any(Error)
      })
    );
  });

  it("lists persisted signals for a run", async () => {
    const service = new SignalService({
      eventLogRepo: {
        append: vi.fn(),
        queryByEntity: vi.fn()
      } as any,
      signalRepo: {
        create: vi.fn(),
        getById: vi.fn(),
        listByRun: vi.fn(async () => [createSignal(), createSignal({ signal_id: "signal-2" })]),
        updateState: vi.fn()
      } as any,
      runtimeNotifier: {
        notifyEntry: vi.fn()
      } as any
    });

    await expect(service.listByRun("run-1")).resolves.toHaveLength(2);
  });

  it("emits a corrective soul.signal.triaged deferred event after materialization router returns deferred", async () => {
    // Regression for P2-b: when triage_result is "accepted" but the materializer
    // returns target_kind "deferred", the signal transitions to DEFERRED state in
    // the repo but no follow-up event was notified. Runtime notification consumers were permanently
    // stuck on the initial "accepted" triage event. This verifies the corrective
    // soul.signal.triaged event with triage_result "deferred" is now appended and notified.
    const appendedEvents: Array<{ event_type: string; caused_by: string; payload_json: Record<string, unknown> }> = [];
    const notifiedEventTypes: string[] = [];
    let appendCallCount = 0;

    const service = new SignalService({
      eventLogRepo: {
        append: vi.fn(async (event) => {
          appendCallCount++;
          appendedEvents.push({ event_type: event.event_type, caused_by: event.caused_by, payload_json: event.payload_json as Record<string, unknown> });
          return {
            event_id: `evt_${appendCallCount}`,
            created_at: "2026-03-18T00:00:00.000Z",
            revision: 0,
            ...event
          };
        }),
        queryByEntity: vi.fn(async () => [])
      },
      signalRepo: {
        create: vi.fn(async (signal) => ({ ...signal, signal_state: "emitted" })),
        getById: vi.fn(async () => null),
        listByRun: vi.fn(async () => []),
        updateState: vi.fn(async (signalId, state) => createSignal({ signal_id: signalId, signal_state: state }))
      },
      runtimeNotifier: {
        notifyEntry: vi.fn(async (entry) => {
          notifiedEventTypes.push(entry.event_type);
        })
      },
      postTriageMaterializer: {
        materialize: vi.fn(async (signal) => ({
          signal_id: signal.signal_id,
          target_kind: "deferred" as const,
          routing_reason: "deferred by router",
          created_objects: [],
          success: true
        }))
      }
    });

    const result = await service.receiveSignal(createSignal());

    // Signal must end up in DEFERRED state; return value must reflect final state.
    expect(result.signal.signal_state).toBe("deferred");
    expect(result.triage_result).toBe("deferred");

    // A corrective triage event with triage_result "deferred" must be appended.
    const correctiveEvent = appendedEvents.find(
      (e) => e.event_type === "soul.signal.triaged" && e.payload_json["triage_result"] === "deferred"
    );
    expect(correctiveEvent).toBeDefined();
    expect(correctiveEvent?.caused_by).toBe("materialization_router");

    // The corrective event must also be notify in-process.
    const triagedNotifications = notifiedEventTypes.filter((t) => t === "soul.signal.triaged");
    expect(triagedNotifications).toHaveLength(2); // initial "accepted" + corrective "deferred"
  });
});
