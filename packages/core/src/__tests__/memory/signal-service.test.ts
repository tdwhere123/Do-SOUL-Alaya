import { describe, expect, it, vi } from "vitest";
import { SignalService } from "../../memory/signal-service.js";
import type { CandidateMemorySignal, EventLogEntry } from "@do-soul/alaya-protocol";

import { createSignal, signalServiceDependencies } from "./signal-service.test-support.js";

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

it("redacts emitted EventLog raw_payload while preserving the stored signal payload", async () => {
    const storedEvents: EventLogEntry[] = [];
    const signalRepo = {
      create: vi.fn(async (signal: CandidateMemorySignal) => ({
        ...signal,
        signal_state: "emitted" as const
      })),
      getById: vi.fn(async () => null),
      listByRun: vi.fn(async () => []),
      updateState: vi.fn(async (signalId: string, state: CandidateMemorySignal["signal_state"]) =>
        createSignal({ signal_id: signalId, signal_state: state })
      )
    };
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
      signalRepo,
      runtimeNotifier: {
        notifyEntry: vi.fn(async () => {})
      }
    });
    const rawPayload = {
      excerpt: "Never print secrets.",
      matched_text: "Never print secrets.",
      bench_seed: true,
      bench_turn_seed_index: 3,
      bench_full_turn_content: "Never print secrets in CI logs.",
      bench_stored_content: "Never print secrets."
    };

    await service.receiveSignal(createSignal({ raw_payload: rawPayload }));

    expect(signalRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        raw_payload: rawPayload
      })
    );
    expect(storedEvents[0]).toMatchObject({
      event_type: "soul.signal.emitted",
      payload_json: {
        raw_payload: {
          raw_payload_redacted: true,
          raw_payload_sha256: expect.stringMatching(/^sha256:/u),
          raw_payload_key_count: 6,
          bench_summary_seeded: true,
          bench_summary_turn_seed_index: 3,
          bench_full_turn_tokens: Math.ceil("Never print secrets in CI logs.".length / 4),
          bench_stored_content_tokens: Math.ceil("Never print secrets.".length / 4)
        }
      }
    });
    expect(
      (storedEvents[0]!.payload_json as { raw_payload: Record<string, unknown> }).raw_payload
    ).not.toHaveProperty("excerpt");
    expect(
      (storedEvents[0]!.payload_json as { raw_payload: Record<string, unknown> }).raw_payload
    ).not.toHaveProperty("matched_text");
    expect(
      (storedEvents[0]!.payload_json as { raw_payload: Record<string, unknown> }).raw_payload
    ).not.toHaveProperty("bench_seed");
    expect(
      (storedEvents[0]!.payload_json as { raw_payload: Record<string, unknown> }).raw_payload
    ).not.toHaveProperty("bench_turn_seed_index");
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
      success: true as const
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
      const service = new SignalService(signalServiceDependencies({
        signalRepo: {
          create: vi.fn(),
          getById: vi.fn(async () => createSignal({ signal_state: state })),
          listByRun: vi.fn(async () => []),
          updateState: vi.fn()
        },
        postTriageMaterializer: {
          materialize
        },
        warn
      }));

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
    const service = new SignalService(signalServiceDependencies({
      signalRepo: {
        create: vi.fn(),
        getById: vi.fn(async () => createSignal({
          raw_payload: { excerpt: "original signal" }
        })),
        listByRun: vi.fn(async () => []),
        updateState: vi.fn()
      }
    }));

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
          success: true as const
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
});
