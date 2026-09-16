import { describe, expect, it, vi } from "vitest";
import type { CandidateMemorySignal, EventLogEntry } from "@do-soul/alaya-protocol";
import { SignalService } from "../../memory/signal-service.js";
import { buildSignalEmittedEventInput } from "../../memory/signal-service-helpers.js";
import { atomicUpdateState, createSignal } from "./signal-service.test-support.js";

function emittedEvent(signal: CandidateMemorySignal): EventLogEntry {
  return {
    event_id: "evt_emitted",
    created_at: "2026-03-18T00:00:00.000Z",
    revision: 0,
    ...buildSignalEmittedEventInput(signal)
  };
}

function materializedSuccessEvent(signal: CandidateMemorySignal): EventLogEntry {
  return {
    event_id: "evt_materialized",
    created_at: "2026-03-18T00:00:01.000Z",
    revision: 1,
    event_type: "soul.signal.materialized",
    entity_type: "candidate_memory_signal",
    entity_id: signal.signal_id,
    workspace_id: signal.workspace_id,
    run_id: signal.run_id,
    caused_by: "materialization_router",
    payload_json: {
      signal_id: signal.signal_id,
      workspace_id: signal.workspace_id,
      run_id: signal.run_id,
      created_objects: [],
      success: true
    }
  };
}

function deferredTriageEvent(
  signal: CandidateMemorySignal,
  extras: { readonly defer_class?: "source_grounding"; readonly defer_reason?: string } = {}
): EventLogEntry {
  return {
    event_id: "evt_triaged",
    created_at: "2026-03-18T00:00:02.000Z",
    revision: 2,
    event_type: "soul.signal.triaged",
    entity_type: "candidate_memory_signal",
    entity_id: signal.signal_id,
    workspace_id: signal.workspace_id,
    run_id: signal.run_id,
    caused_by: "materialization_router",
    payload_json: {
      signal_id: signal.signal_id,
      workspace_id: signal.workspace_id,
      run_id: signal.run_id,
      triage_result: "deferred",
      ...extras
    }
  };
}

function createResumeService(input: {
  readonly existing: CandidateMemorySignal;
  readonly events: readonly EventLogEntry[];
  readonly materialize: ReturnType<typeof vi.fn>;
}): SignalService {
  const storedEvents = [...input.events];
  return new SignalService({
    eventLogRepo: {
      append: vi.fn((event) => {
        const stored: EventLogEntry = {
          event_id: `evt_${storedEvents.length + 1}`,
          created_at: "2026-03-18T00:00:03.000Z",
          revision: storedEvents.length,
          ...event
        };
        storedEvents.push(stored);
        return stored;
      }),
      queryByEntity: vi.fn(async (entityType, entityId) =>
        storedEvents.filter((event) => event.entity_type === entityType && event.entity_id === entityId)
      ),
      transactional: <T>(fn: () => T) => fn()
    },
    signalRepo: {
      create: vi.fn(),
      getById: vi.fn(async () => input.existing),
      listByRun: vi.fn(async () => []),
      ...atomicUpdateState((signalId, state) =>
        createSignal({ signal_id: signalId, signal_state: state })
      )
    },
    runtimeNotifier: {
      notifyEntry: vi.fn(async () => {})
    },
    postTriageMaterializer: {
      materialize: input.materialize
    }
  });
}

describe("SignalService write-path deferred resume", () => {
  it("rematerializes a deferred signal that already had a successful materialization event", async () => {
    const existing = createSignal({ signal_state: "deferred" });
    const materialize = vi.fn(async (signal: CandidateMemorySignal) => ({
      signal_id: signal.signal_id,
      target_kind: "evidence_only" as const,
      routing_reason: "retry after reconcile lease released",
      created_objects: [{ object_kind: "memory_entry", object_id: "memory-1" }],
      success: true as const
    }));
    const service = createResumeService({
      existing,
      events: [emittedEvent(existing), materializedSuccessEvent(existing)],
      materialize
    });

    const result = await service.receiveSignal(createSignal());

    expect(materialize).toHaveBeenCalledTimes(1);
    expect(result.signal.signal_state).toBe("materialized");
    expect(result.triage_result).toBe("accepted");
    expect(result.materialization).toMatchObject({
      success: true,
      target_kind: "evidence_only"
    });
  });

  it("does not rematerialize a triage-deferred signal that never materialized", async () => {
    const existing = createSignal({ signal_state: "deferred" });
    const materialize = vi.fn(async () => {
      throw new Error("triage-deferred signals must not rematerialize");
    });
    const service = createResumeService({
      existing,
      events: [emittedEvent(existing), deferredTriageEvent(existing)],
      materialize
    });

    const result = await service.receiveSignal(createSignal());

    expect(materialize).not.toHaveBeenCalled();
    expect(result.signal.signal_state).toBe("deferred");
    expect(result.triage_result).toBe("deferred");
    expect(result.materialization).toBeNull();
  });

  it("does not rematerialize a source-grounding deferral on ordinary receive", async () => {
    const existing = createSignal({ signal_state: "deferred" });
    const materialize = vi.fn(async () => {
      throw new Error("source-grounding deferrals use the claim redrive path");
    });
    const service = createResumeService({
      existing,
      events: [
        emittedEvent(existing),
        materializedSuccessEvent(existing),
        deferredTriageEvent(existing, {
          defer_class: "source_grounding",
          defer_reason: "source_assertion_not_self_contained"
        })
      ],
      materialize
    });

    const result = await service.receiveSignal(createSignal());

    expect(materialize).not.toHaveBeenCalled();
    expect(result.signal.signal_state).toBe("deferred");
    expect(result.materialization).toBeNull();
  });
});
