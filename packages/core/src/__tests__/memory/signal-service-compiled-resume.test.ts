import { describe, expect, it, vi } from "vitest";
import type { CandidateMemorySignal, EventLogEntry } from "@do-soul/alaya-protocol";
import { SignalService } from "../../memory/signal-service.js";
import { buildSignalEmittedEventInput } from "../../memory/signal-service-helpers.js";
import { atomicUpdateState, createSignal } from "./signal-service.test-support.js";

function serviceFor(state: CandidateMemorySignal["signal_state"], events: readonly EventLogEntry[] = []) {
  const signal = createSignal({ signal_state: state });
  const materialize = vi.fn(async (candidate: CandidateMemorySignal) => ({
    signal_id: candidate.signal_id, target_kind: "memory_and_claim" as const,
    routing_reason: "safe pre-fence resume", created_objects: [{ object_kind: "memory_entry", object_id: "memory-1" }],
    success: true as const
  }));
  const warn = vi.fn();
  const service = new SignalService({
    eventLogRepo: {
      append: vi.fn(event => ({ ...event, event_id: "evt-next", revision: 3, created_at: "2026-03-18T00:00:04.000Z" })),
      queryByEntity: vi.fn(async () => events), transactional: fn => fn()
    },
    signalRepo: { create: vi.fn(), getById: vi.fn(async () => signal), listByRun: vi.fn(async () => []),
      ...atomicUpdateState((signalId, nextState) => createSignal({ signal_id: signalId, signal_state: nextState })) },
    runtimeNotifier: { notifyEntry: vi.fn() }, postTriageMaterializer: { materialize }, warn
  });
  return { service, materialize, warn };
}
function emission(): EventLogEntry {
  return { ...buildSignalEmittedEventInput(createSignal()), event_id: "emission", revision: 0,
    created_at: "2026-03-18T00:00:00.000Z" };
}

describe("SignalService materialization resume", () => {
  it("preserves compiled no-duplicate protection without claiming the owner died", async () => {
    const h = serviceFor("compiled");
    const result = await h.service.receiveSignal(createSignal());
    expect(result).toMatchObject({ signal: { signal_state: "compiled" }, triage_result: "deferred", materialization: null });
    expect(h.materialize).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledWith(
      "Signal replay found a post-triage signal; not replaying materialization side effects.",
      expect.objectContaining({ code: "POST_TRIAGE_REPLAY_SKIPPED" }));
  });
  it("resumes triaged admission with a unique matching envelope before effects started", async () => {
    const h = serviceFor("triaged", [emission()]);
    expect(await h.service.receiveSignal(createSignal())).toMatchObject({
      signal: { signal_state: "materialized" }, triage_result: "accepted",
      materialization: { target_kind: "memory_and_claim", success: true }
    });
    expect(h.materialize).toHaveBeenCalledTimes(1);
  });
  it("defers triaged admission with an unverifiable envelope without materializing", async () => {
    const h = serviceFor("triaged");
    expect(await h.service.receiveSignal(createSignal())).toMatchObject({
      signal: { signal_state: "deferred" }, triage_result: "deferred", materialization: null
    });
    expect(h.materialize).not.toHaveBeenCalled();
  });
  it("keeps unknown effects non-retryable and distinct from failed", async () => {
    const h = serviceFor("materialization_unknown", [emission()]);
    expect(await h.service.receiveSignal(createSignal())).toMatchObject({
      signal: { signal_state: "materialization_unknown" }, triage_result: "unknown", materialization: null
    });
    expect(h.materialize).not.toHaveBeenCalled();
  });
  it("returns an explicit failure for a persisted failed signal without guessing its route", async () => {
    const h = serviceFor("failed");
    expect(await h.service.receiveSignal(createSignal())).toMatchObject({ signal: { signal_state: "failed" },
      materialization: { success: false, target_kind: "unknown" } });
    expect(h.materialize).not.toHaveBeenCalled();
  });
});
