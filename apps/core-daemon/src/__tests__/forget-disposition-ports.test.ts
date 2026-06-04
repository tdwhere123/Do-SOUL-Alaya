import { describe, expect, it, vi } from "vitest";
import type { MemoryEntry, SynthesisCapsule } from "@do-soul/alaya-protocol";
import {
  buildLiveCapsuleMemberIndex,
  computeForgetDisposition,
  createTombstoneDispositionSweepPort
} from "../forget-disposition-ports.js";

function memory(overrides: Partial<MemoryEntry> = {}): Readonly<MemoryEntry> {
  return Object.freeze({
    object_id: "mem-1",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "dormant",
    created_at: "2026-03-21T00:00:00.000Z",
    updated_at: "2026-03-21T00:00:00.000Z",
    created_by: "user_action",
    dimension: "preference",
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: "project",
    content: "noise",
    domain_tags: [],
    // invariant (redteam-I2): source-less + never-reinforced is the only
    // judged_useless shape. The default fixture is that shape so the gate-failing
    // cases below resolve to judged_useless / null disposition.
    evidence_refs: [],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: "hot",
    activation_score: null,
    retention_score: null,
    manifestation_state: null,
    retention_state: "working",
    decay_profile: "normal",
    confidence: null,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: 0,
    contradiction_count: null,
    superseded_by: null,
    ...overrides
  } as MemoryEntry);
}

function capsule(overrides: Partial<SynthesisCapsule> = {}): Readonly<SynthesisCapsule> {
  return Object.freeze({
    object_id: "capsule-1",
    object_kind: "synthesis_capsule",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-21T00:00:00.000Z",
    updated_at: "2026-03-21T00:00:00.000Z",
    created_by: "consolidation-executor",
    topic_key: "topic",
    synthesis_type: "cross_evidence",
    summary: "preserved content",
    evidence_refs: [],
    source_memory_refs: ["mem-1"],
    workspace_id: "workspace-1",
    run_id: "run-1",
    synthesis_status: "stable",
    ...overrides
  } as SynthesisCapsule);
}

describe("computeForgetDisposition", () => {
  it("marks a member preserved in a live capsule as compressed", () => {
    const result = computeForgetDisposition(memory(), new Set(["mem-1"]));
    expect(result.disposition).toBe("compressed");
    expect(result.ref).toBe("mem-1");
  });

  it("marks a gate-failing memory with no live capsule as judged_useless", () => {
    const result = computeForgetDisposition(memory(), new Set());
    expect(result.disposition).toBe("judged_useless");
    expect(result.ref).toBeNull();
  });

  it("leaves an evidence-rich memory with no capsule as NULL (kept, never removable)", () => {
    const result = computeForgetDisposition(memory({ evidence_refs: ["e1", "e2"] }), new Set());
    expect(result.disposition).toBeNull();
  });

  it("compresses an evidence-rich (non-protected) member in a live capsule", () => {
    // invariant (protection-before-compressed): evidence richness is an ordinary
    // value signal (the `keep` disposition), which compression OVERRIDES — so an
    // evidence-rich but non-explicitly-protected member in a live capsule is
    // compressed (its content is preserved by the capsule).
    const result = computeForgetDisposition(memory({ evidence_refs: ["e1", "e2"] }), new Set(["mem-1"]));
    expect(result.disposition).toBe("compressed");
  });

  it("compresses a reinforced (non-protected) member in a live capsule", () => {
    // reinforcement_count is also an ordinary value signal that compression
    // overrides when a live capsule preserves the content.
    const result = computeForgetDisposition(
      memory({ reinforcement_count: 5 }),
      new Set(["mem-1"])
    );
    expect(result.disposition).toBe("compressed");
  });

  it("leaves a PINNED member in a live capsule dormant, NOT compressed", () => {
    // invariant (protection-before-compressed): explicit-keep overrides compress.
    const result = computeForgetDisposition(
      memory({ decay_profile: "pinned" }),
      new Set(["mem-1"])
    );
    expect(result.disposition).toBeNull();
    expect(result.ref).toBeNull();
  });

  it("leaves a HAZARD member in a live capsule dormant, NOT compressed", () => {
    const result = computeForgetDisposition(
      memory({ decay_profile: "hazard" }),
      new Set(["mem-1"])
    );
    expect(result.disposition).toBeNull();
  });

  it("leaves a CANON member in a live capsule dormant, NOT compressed", () => {
    const result = computeForgetDisposition(
      memory({ retention_state: "canon" }),
      new Set(["mem-1"])
    );
    expect(result.disposition).toBeNull();
  });

  it("leaves a CONSOLIDATED member in a live capsule dormant, NOT compressed", () => {
    // A consolidated memory is itself higher-order durable truth; it is treated
    // as explicit-keep and must not be compress-deleted.
    const result = computeForgetDisposition(
      memory({ retention_state: "consolidated" }),
      new Set(["mem-1"])
    );
    expect(result.disposition).toBeNull();
  });
});

describe("buildLiveCapsuleMemberIndex", () => {
  it("indexes members of live capsules and excludes archived / tombstoned capsules", async () => {
    const capsuleLookup = {
      findByWorkspaceId: vi.fn(async () => [
        capsule({ object_id: "cap-live", source_memory_refs: ["mem-a"], synthesis_status: "stable" }),
        capsule({ object_id: "cap-archived", source_memory_refs: ["mem-b"], synthesis_status: "archived" }),
        capsule({ object_id: "cap-tombstoned", source_memory_refs: ["mem-c"], lifecycle_state: "tombstone" })
      ])
    };

    const index = await buildLiveCapsuleMemberIndex("workspace-1", capsuleLookup);

    expect(index.get("mem-a")).toBe("cap-live");
    expect(index.has("mem-b")).toBe(false);
    expect(index.has("mem-c")).toBe(false);
  });
});

describe("createTombstoneDispositionSweepPort", () => {
  it("returns a non-null disposition only for preserved-or-useless dormant rows", async () => {
    const memoryLookup = {
      findDormantMemories: vi.fn(async () => [
        memory({ object_id: "mem-compressed" }),
        memory({ object_id: "mem-useless" }),
        memory({ object_id: "mem-kept", evidence_refs: ["e1", "e2"] })
      ])
    };
    const capsuleLookup = {
      findByWorkspaceId: vi.fn(async () => [capsule({ object_id: "cap", source_memory_refs: ["mem-compressed"] })])
    };
    const tombstoneAuthority = {
      autonomousTombstone: vi.fn(async () => memory()),
      autonomousHardDeleteTombstoned: vi.fn(async () => true),
      findTombstonedMemoriesWithDisposition: vi.fn(async () => [])
    };

    const port = createTombstoneDispositionSweepPort({ memoryLookup, capsuleLookup, tombstoneAuthority });
    const candidates = await port.findDormantDispositionCandidates("workspace-1");

    expect(candidates).toEqual([
      { memory_id: "mem-compressed", disposition: "compressed", disposition_ref: "cap" },
      { memory_id: "mem-useless", disposition: "judged_useless", disposition_ref: null },
      { memory_id: "mem-kept", disposition: null, disposition_ref: null }
    ]);
  });

  it("autonomousTombstone short-circuits a null-disposition candidate (never tombstones a kept row)", async () => {
    const tombstoneAuthority = {
      autonomousTombstone: vi.fn(async () => memory()),
      autonomousHardDeleteTombstoned: vi.fn(async () => true),
      findTombstonedMemoriesWithDisposition: vi.fn(async () => [])
    };
    const port = createTombstoneDispositionSweepPort({
      memoryLookup: { findDormantMemories: vi.fn(async () => []) },
      capsuleLookup: { findByWorkspaceId: vi.fn(async () => []) },
      tombstoneAuthority
    });

    await port.autonomousTombstone(
      { memory_id: "mem-kept", disposition: null, disposition_ref: null },
      "task-1"
    );

    expect(tombstoneAuthority.autonomousTombstone).not.toHaveBeenCalled();
  });

  it("autonomousTombstone routes a cleared candidate through the audited authority", async () => {
    const tombstoneAuthority = {
      autonomousTombstone: vi.fn(async () => memory()),
      autonomousHardDeleteTombstoned: vi.fn(async () => true),
      findTombstonedMemoriesWithDisposition: vi.fn(async () => [])
    };
    const port = createTombstoneDispositionSweepPort({
      memoryLookup: { findDormantMemories: vi.fn(async () => []) },
      capsuleLookup: { findByWorkspaceId: vi.fn(async () => []) },
      tombstoneAuthority
    });

    await port.autonomousTombstone(
      { memory_id: "mem-useless", disposition: "judged_useless", disposition_ref: null },
      "task-1"
    );

    expect(tombstoneAuthority.autonomousTombstone).toHaveBeenCalledWith(
      "mem-useless",
      "judged_useless",
      null,
      "autonomous_forget_sweep",
      "deterministic_rule"
    );
  });
});
