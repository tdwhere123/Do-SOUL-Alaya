import { describe, expect, it, vi } from "vitest";
import {
  CandidateMemorySignalSchema,
  ControlPlaneObjectKind,
  RetentionPolicy,
  SignalKind,
  SignalSource,
  type CandidateMemorySignal
} from "@do-soul/alaya-protocol";
import { SqliteHandoffGapAdapter, buildHandoffGapCleanupPort } from "../../handoff/gap-adapter.js";

function createSignal(overrides: Partial<CandidateMemorySignal> = {}): CandidateMemorySignal {
  return CandidateMemorySignalSchema.parse({
    signal_id: "signal-1",
    workspace_id: "ws-1",
    run_id: "run-1",
    surface_id: "surface-1",
    source: SignalSource.MODEL_TOOL,
    signal_kind: SignalKind.POTENTIAL_HANDOFF,
    object_kind: "handoff",
    scope_hint: "project",
    domain_tags: ["handoff"],
    confidence: 0.9,
    evidence_refs: [],
    canonical_entities: [],
    source_memory_refs: [],
    supersedes_refs: [],
    exception_to_refs: [],
    contradicts_refs: [],
    incompatible_with_refs: [],
    raw_payload: {},
    created_at: "2026-07-06T00:00:00.000Z",
    ...overrides
  });
}

function repoStub() {
  return {
    createGap: vi.fn((record) => record),
    createHandoff: vi.fn((record) => record),
    listAll: vi.fn(() => [{ runtime_id: "handoff-1" }]),
    findExpiredObjects: vi.fn(() => [{ object_kind: "gap_record", object_id: "gap-1", expires_at: "2026-07-06T00:00:00.000Z" }]),
    deleteExpired: vi.fn(),
    deleteById: vi.fn()
  };
}

describe("SqliteHandoffGapAdapter", () => {
  it("materializes explicit gap signals as gap records with signal-derived summaries", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T00:00:00.000Z"));
    const repo = repoStub();
    const adapter = new SqliteHandoffGapAdapter(
      repo as unknown as ConstructorParameters<typeof SqliteHandoffGapAdapter>[0],
      60_000
    );

    const created = adapter.createFromSignal(
      createSignal({
        signal_id: "signal-gap",
        object_kind: "Context Gap",
        raw_payload: { gap_detected: true, excerpt: " Missing deployment handoff. " }
      })
    );

    expect(created.object_kind).toBe("gap_record");
    expect(created.object_id).toBe(repo.createGap.mock.calls[0]?.[0].runtime_id);
    expect(repo.createGap).toHaveBeenCalledWith(expect.objectContaining({
      object_kind: ControlPlaneObjectKind.GAP_RECORD,
      task_surface_ref: "surface-1",
      expires_at: "2026-07-06T00:01:00.000Z",
      derived_from: "signal-gap",
      retention_policy: RetentionPolicy.RUN_SCOPED,
      gap_kind: "context_gap",
      detected_in_run_id: "run-1",
      surface_id: "surface-1",
      description: "Missing deployment handoff.",
      ttl_ms: 60_000
    }));
    expect(repo.createHandoff).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("materializes non-gap handoff signals as handoff records", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T00:00:00.000Z"));
    const repo = repoStub();
    const adapter = new SqliteHandoffGapAdapter(
      repo as unknown as ConstructorParameters<typeof SqliteHandoffGapAdapter>[0],
      120_000
    );

    const created = adapter.createFromSignal(createSignal({ signal_id: "signal-handoff" }));

    expect(created.object_kind).toBe("handoff_record");
    expect(created.object_id).toBe(repo.createHandoff.mock.calls[0]?.[0].runtime_id);
    expect(repo.createHandoff).toHaveBeenCalledWith(expect.objectContaining({
      object_kind: ControlPlaneObjectKind.HANDOFF_RECORD,
      task_surface_ref: "surface-1",
      expires_at: "2026-07-06T00:02:00.000Z",
      derived_from: "signal-handoff",
      retention_policy: RetentionPolicy.RUN_SCOPED,
      handoff_kind: "run_handoff",
      source_run_id: "run-1",
      target_run_id: null,
      surface_id: "surface-1",
      ttl_ms: 120_000
    }));
    expect(repo.createGap).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("delegates listing and expiry cleanup to the repository boundary", () => {
    const repo = repoStub();
    const adapter = new SqliteHandoffGapAdapter(
      repo as unknown as ConstructorParameters<typeof SqliteHandoffGapAdapter>[0]
    );

    expect(adapter.listHandoffs()).toEqual([{ runtime_id: "handoff-1" }]);
    adapter.clearExpired("2026-07-06T01:00:00.000Z");

    expect(repo.listAll).toHaveBeenCalledTimes(1);
    expect(repo.deleteExpired).toHaveBeenCalledWith("2026-07-06T01:00:00.000Z");
  });
});

describe("buildHandoffGapCleanupPort", () => {
  it("finds and removes expired handoff/gap objects through the repo", async () => {
    const repo = repoStub();
    const port = buildHandoffGapCleanupPort(
      repo as unknown as Parameters<typeof buildHandoffGapCleanupPort>[0]
    );

    const expired = await port.findExpiredObjects("2026-07-06T01:00:00.000Z");
    await port.removeExpiredObjects(expired);

    expect(repo.findExpiredObjects).toHaveBeenCalledWith("2026-07-06T01:00:00.000Z");
    expect(repo.deleteById).toHaveBeenCalledWith("gap-1");
  });
});
