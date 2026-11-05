import type { CandidateMemorySignal } from "@do-soul/alaya-protocol";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary({ descendantPreload: new URL("../../../../bench-runner/src/__tests__/support/provider-free-cli-bootstrap.mjs", import.meta.url).href });
});
afterEach(() => expect(isolation.violations).toEqual([]));
afterAll(() => isolation.restore());
import { receiveGardenTaskSignals } from "../../garden/post-turn-extract/evidence-finalizer.js";
import { createSignalOutcomeCounter } from "../../garden/post-turn-extract/signal-receiver.js";

const CREATED_AT = "2026-07-27T12:00:00.000Z";

function candidate(overrides: Partial<CandidateMemorySignal> = {}): CandidateMemorySignal {
  return {
    signal_id: "candidate-1", workspace_id: "workspace-1", run_id: "run-1", surface_id: null, source: "garden_compile",
    signal_kind: "potential_claim", object_kind: "memory_entry", signal_state: "emitted", scope_hint: "project",
    domain_tags: [], confidence: 0.9, evidence_refs: [], source_memory_refs: [], supersedes_refs: [], exception_to_refs: [],
    contradicts_refs: [], incompatible_with_refs: [], created_at: CREATED_AT, raw_payload: { gist: "I use Atlas." },
    source_observation: null, ...overrides
  } as CandidateMemorySignal;
}

describe("garden task signal receipt", () => {
  it("retries a write-path deferred candidate receive once", async () => {
    const receiveSignal = vi.fn(async (signal: CandidateMemorySignal) => receiveSignal.mock.calls.length === 1
      ? { signal, triage_result: "deferred" as const, materialization: { created_objects: [], target_kind: "deferred",
        defer_class: "write_path" as const, deferral: "lease_busy" as const } }
      : { signal, triage_result: "accepted" as const, materialization: {
        created_objects: [{ object_kind: "evidence_capsule", object_id: "evidence-1" }], target_kind: "evidence_only" } });

    await expect(receiveGardenTaskSignals({ candidates: [candidate()], signalReceiver: { receiveSignal } }))
      .resolves.toEqual(["candidate-1"]);

    expect(receiveSignal).toHaveBeenCalledTimes(2);
    expect(receiveSignal.mock.calls.map(call => call[0].signal_id)).toEqual(["candidate-1", "candidate-1"]);
  });

  it("does not extra-retry a deferred candidate without write_path defer_class", async () => {
    const receiveSignal = vi.fn(async (signal: CandidateMemorySignal) => ({
      signal, triage_result: "deferred" as const, materialization: { created_objects: [], target_kind: "deferred" } }));

    await receiveGardenTaskSignals({ candidates: [candidate({ object_kind: "path_relation" })], signalReceiver: { receiveSignal } });

    expect(receiveSignal).toHaveBeenCalledTimes(1);
  });

  it("does not extra-retry a source-grounding deferred candidate and reports failed materialization", async () => {
    const receiveSignal = vi.fn(async (signal: CandidateMemorySignal) => ({
      signal: { ...signal, signal_state: "failed" as const }, triage_result: "deferred" as const,
      materialization: { created_objects: [{ object_kind: "evidence_capsule", object_id: "evidence-1" }],
        target_kind: "deferred", defer_class: "source_grounding" as const } }));
    const outcomes = createSignalOutcomeCounter();

    await receiveGardenTaskSignals({ candidates: [candidate()], signalReceiver: { receiveSignal }, outcomes });

    expect(receiveSignal).toHaveBeenCalledTimes(1);
    expect(outcomes.snapshot()).toEqual({ failed_candidate_signals_count: 1,
      unknown_candidate_signals_count: 0, inflight_candidate_signals_count: 0 });
  });
});
