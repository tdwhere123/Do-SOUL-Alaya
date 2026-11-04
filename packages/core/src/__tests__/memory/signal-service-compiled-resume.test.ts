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

function materializedEvent(
  signal: CandidateMemorySignal,
  extras: {
    readonly success: boolean;
    readonly created_objects?: ReadonlyArray<{ readonly object_kind: string; readonly object_id: string }>;
    readonly error?: string;
  }
): EventLogEntry {
  return {
    event_id: extras.success ? "evt_materialized" : "evt_materialization_failed",
    created_at: "2026-03-18T00:00:02.000Z",
    revision: 2,
    event_type: extras.success ? "soul.signal.materialized" : "soul.signal.materialization_failed",
    entity_type: "candidate_memory_signal",
    entity_id: signal.signal_id,
    workspace_id: signal.workspace_id,
    run_id: signal.run_id,
    caused_by: "materialization_router",
    payload_json: {
      signal_id: signal.signal_id,
      workspace_id: signal.workspace_id,
      run_id: signal.run_id,
      created_objects: extras.created_objects ?? [],
      success: extras.success,
      ...(extras.error === undefined ? {} : { error: extras.error })
    }
  };
}

function deferredTriageEvent(signal: CandidateMemorySignal): EventLogEntry {
  return {
    event_id: "evt_deferred",
    created_at: "2026-03-18T00:00:03.000Z",
    revision: 3,
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
      defer_class: "write_path",
      deferral: "lease_busy"
    }
  };
}

function createResumeService(input: {
  readonly existing: CandidateMemorySignal;
  readonly events: readonly EventLogEntry[];
  readonly materialize: ReturnType<typeof vi.fn>;
  readonly warn?: ReturnType<typeof vi.fn>;
}): SignalService {
  const storedEvents = [...input.events];
  return new SignalService({
    eventLogRepo: {
      append: vi.fn((event) => {
        const stored: EventLogEntry = {
          event_id: `evt_${storedEvents.length + 1}`,
          created_at: "2026-03-18T00:00:04.000Z",
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
      materialize: async (signal, context) => await input.materialize(signal, context)
    },
    ...(input.warn === undefined ? {} : { warn: input.warn })
  });
}

describe("SignalService compiled and triaged resume", () => {
  it("does not replay materialization side effects for a compiled signal without a materialization result", async () => {
    const existing = createSignal({ signal_state: "compiled" });
    const materialize = vi.fn(async () => {
      throw new Error("should not rerun materialization");
    });
    const warn = vi.fn();
    const service = createResumeService({
      existing,
      events: [],
      materialize,
      warn
    });

    const result = await service.receiveSignal(createSignal());

    expect(result.signal.signal_state).toBe("compiled");
    expect(result.triage_result).toBe("deferred");
    expect(result.materialization).toBeNull();
    expect(materialize).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "Signal replay found a post-triage signal; not replaying materialization side effects.",
      {
        phase: "signal_replay",
        code: "POST_TRIAGE_REPLAY_SKIPPED",
        detail_sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        detail_char_count: expect.any(Number)
      }
    );
  });

  it("rematerializes a triaged signal whose admission envelope is still unique", async () => {
    const existing = createSignal({ signal_state: "triaged" });
    const materialize = vi.fn(async (signal: CandidateMemorySignal) => ({
      signal_id: signal.signal_id,
      target_kind: "memory_and_claim" as const,
      routing_reason: "resume after triage before compiled fence",
      created_objects: [{ object_kind: "memory_entry", object_id: "memory-1" }],
      success: true as const
    }));
    const service = createResumeService({
      existing,
      events: [emittedEvent(existing)],
      materialize
    });

    const result = await service.receiveSignal(createSignal());

    expect(materialize).toHaveBeenCalledTimes(1);
    expect(result.signal.signal_state).toBe("materialized");
    expect(result.triage_result).toBe("accepted");
    expect(result.materialization).toMatchObject({
      success: true,
      created_objects: [{ object_kind: "memory_entry", object_id: "memory-1" }]
    });
  });

  it("defers a triaged signal whose admission envelope is missing", async () => {
    const existing = createSignal({ signal_state: "triaged" });
    const materialize = vi.fn(async () => {
      throw new Error("should not rematerialize an unverifiable triaged signal");
    });
    const service = createResumeService({
      existing,
      events: [],
      materialize
    });

    const result = await service.receiveSignal(createSignal());

    expect(materialize).not.toHaveBeenCalled();
    expect(result.signal.signal_state).toBe("deferred");
    expect(result.triage_result).toBe("deferred");
    expect(result.materialization).toBeNull();
  });

  it("completes a compiled signal from a successful materialization audit without rematerializing", async () => {
    const existing = createSignal({ signal_state: "compiled" });
    const materialize = vi.fn(async () => {
      throw new Error("should not rematerialize after a successful audit");
    });
    const service = createResumeService({
      existing,
      events: [
        emittedEvent(existing),
        materializedEvent(existing, {
          success: true,
          created_objects: [{ object_kind: "memory_entry", object_id: "memory-1" }]
        })
      ],
      materialize
    });

    const result = await service.receiveSignal(createSignal());

    expect(materialize).not.toHaveBeenCalled();
    expect(result.signal.signal_state).toBe("materialized");
    expect(result.triage_result).toBe("accepted");
    expect(result.materialization).toMatchObject({
      success: true,
      target_kind: "unknown",
      created_objects: [{ object_kind: "memory_entry", object_id: "memory-1" }]
    });
  });

  it("completes from a later redrive success rather than an earlier deferred triage", async () => {
    const existing = createSignal({ signal_state: "compiled" });
    const materialize = vi.fn(async () => {
      throw new Error("should not rematerialize after a later successful redrive audit");
    });
    const service = createResumeService({
      existing,
      events: [
        emittedEvent(existing),
        deferredTriageEvent(existing),
        materializedEvent(existing, {
          success: true,
          created_objects: [{ object_kind: "memory_entry", object_id: "memory-redrive" }]
        })
      ],
      materialize
    });

    const result = await service.receiveSignal(createSignal());

    expect(materialize).not.toHaveBeenCalled();
    expect(result.signal.signal_state).toBe("materialized");
    expect(result.materialization).toMatchObject({
      success: true,
      target_kind: "unknown",
      created_objects: [{ object_kind: "memory_entry", object_id: "memory-redrive" }]
    });
  });

  it("collects a compiled signal with a failed materialization audit as failed without rematerializing", async () => {
    const existing = createSignal({ signal_state: "compiled" });
    const materialize = vi.fn(async () => {
      throw new Error("should not rematerialize after a failed audit");
    });
    const service = createResumeService({
      existing,
      events: [
        emittedEvent(existing),
        materializedEvent(existing, {
          success: false,
          error: "materialization_error:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:chars:12"
        })
      ],
      materialize
    });

    const result = await service.receiveSignal(createSignal());

    expect(materialize).not.toHaveBeenCalled();
    expect(result.signal.signal_state).toBe("failed");
    expect(result.materialization).toMatchObject({
      success: false,
      target_kind: "unknown",
      created_objects: []
    });
  });

  it("does not apply a historical deferred triage while compiled has no later materialization witness", async () => {
    const existing = createSignal({ signal_state: "compiled" });
    const materialize = vi.fn(async () => {
      throw new Error("should not rematerialize a compiled signal with only a historical deferral");
    });
    const service = createResumeService({
      existing,
      events: [emittedEvent(existing), deferredTriageEvent(existing)],
      materialize
    });

    const result = await service.receiveSignal(createSignal());

    expect(materialize).not.toHaveBeenCalled();
    expect(result.signal.signal_state).toBe("compiled");
    expect(result.triage_result).toBe("deferred");
    expect(result.materialization).toBeNull();
  });

  it("returns a failed materialization on replay of a failed signal instead of accepted with null", async () => {
    const existing = createSignal({ signal_state: "failed" });
    const materialize = vi.fn(async () => {
      throw new Error("should not rematerialize a failed signal");
    });
    const service = createResumeService({
      existing,
      events: [
        emittedEvent(existing),
        materializedEvent(existing, {
          success: false,
          error: "materialization_error:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:chars:8"
        })
      ],
      materialize
    });

    const result = await service.receiveSignal(createSignal());

    expect(materialize).not.toHaveBeenCalled();
    expect(result.signal.signal_state).toBe("failed");
    expect(result.materialization).toMatchObject({
      success: false
    });
    expect(result.materialization).not.toBeNull();
  });
});
