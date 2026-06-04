import { describe, expect, it } from "vitest";
import type { MemoryEntry } from "@do-soul/alaya-protocol";
import {
  classifyMemoryImportance,
  isMemoryExplicitlyProtected,
  isMemoryJudgedUseless
} from "../importance-gate.js";

function memory(overrides: Partial<MemoryEntry> = {}): Readonly<MemoryEntry> {
  return Object.freeze({
    object_id: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
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
    // Default: source-less (no evidence) so the evidence keep-criterion does NOT
    // fire unless a test sets one. A judged_useless candidate must also be
    // never-reinforced (reinforcement_count 0/null).
    evidence_refs: [],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: "hot",
    activation_score: null,
    retention_score: null,
    manifestation_state: null,
    retention_state: null,
    decay_profile: null,
    confidence: null,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: null,
    contradiction_count: null,
    superseded_by: null,
    ...overrides
  } as MemoryEntry);
}

describe("classifyMemoryImportance keep-criteria", () => {
  it("KEEPs (protected) a pinned-decay-profile memory — never auto-removable", () => {
    const result = classifyMemoryImportance(memory({ decay_profile: "pinned" }));
    expect(result.disposition).toBe("protected");
    expect(isMemoryJudgedUseless(memory({ decay_profile: "pinned" }))).toBe(false);
  });

  it("KEEPs (protected) a hazard-decay-profile memory", () => {
    expect(classifyMemoryImportance(memory({ decay_profile: "hazard" })).disposition).toBe("protected");
  });

  it("KEEPs (report_only) a strictly-governed canon memory", () => {
    expect(classifyMemoryImportance(memory({ retention_state: "canon" })).disposition).toBe("report_only");
  });

  it("KEEPs (report_only) a consolidated memory", () => {
    expect(classifyMemoryImportance(memory({ retention_state: "consolidated" })).disposition).toBe("report_only");
  });

  it("KEEPs (keep) an evidence-rich memory (>=2 evidence refs)", () => {
    const result = classifyMemoryImportance(memory({ evidence_refs: ["e1", "e2"] }));
    expect(result.disposition).toBe("keep");
    expect(result.reason).toBe("evidence_basis");
  });

  // invariant (redteam-I2): a single evidence ref is durable — "durable memories
  // require source AND evidence". A single-evidence fact must NEVER be deleted.
  it("KEEPs (keep) a single-evidence memory — ANY evidence forbids autonomous deletion", () => {
    const result = classifyMemoryImportance(memory({ evidence_refs: ["only-one"], reinforcement_count: 0 }));
    expect(result.disposition).toBe("keep");
    expect(result.reason).toBe("evidence_basis");
    expect(isMemoryJudgedUseless(memory({ evidence_refs: ["only-one"], reinforcement_count: 0 }))).toBe(false);
  });

  it("KEEPs (keep) a reinforced source-less memory (reinforcement_count >= 1)", () => {
    const result = classifyMemoryImportance(memory({ evidence_refs: [], reinforcement_count: 1 }));
    expect(result.disposition).toBe("keep");
    expect(result.reason).toBe("reinforced");
  });

  it("judges USELESS only when source-less AND never reinforced", () => {
    const candidate = memory({
      decay_profile: "normal",
      retention_state: "working",
      evidence_refs: [],
      reinforcement_count: 0
    });
    expect(classifyMemoryImportance(candidate).disposition).toBe("judged_useless");
    expect(isMemoryJudgedUseless(candidate)).toBe(true);
  });

  it("treats a null reinforcement_count as zero support (source-less + null => useless)", () => {
    const candidate = memory({
      retention_state: "working",
      evidence_refs: [],
      reinforcement_count: null
    });
    expect(classifyMemoryImportance(candidate).disposition).toBe("judged_useless");
  });

  it("protection order: pinned wins over an otherwise-useless profile", () => {
    const candidate = memory({
      decay_profile: "pinned",
      retention_state: "working",
      evidence_refs: [],
      reinforcement_count: 0
    });
    expect(classifyMemoryImportance(candidate).disposition).toBe("protected");
  });
});

describe("isMemoryExplicitlyProtected", () => {
  // invariant: the explicit-keep predicate the forget disposition sweep checks
  // BEFORE compression. Pinned / hazard / canon / consolidated are protected;
  // ordinary value signals (evidence richness, reinforcement) are NOT.
  it("is true for pinned, hazard, canon, consolidated", () => {
    expect(isMemoryExplicitlyProtected(memory({ decay_profile: "pinned" }))).toBe(true);
    expect(isMemoryExplicitlyProtected(memory({ decay_profile: "hazard" }))).toBe(true);
    expect(isMemoryExplicitlyProtected(memory({ retention_state: "canon" }))).toBe(true);
    expect(isMemoryExplicitlyProtected(memory({ retention_state: "consolidated" }))).toBe(true);
  });

  it("is false for evidence-rich / reinforced / useless (ordinary value signals compression may override)", () => {
    expect(isMemoryExplicitlyProtected(memory({ evidence_refs: ["e1", "e2"] }))).toBe(false);
    expect(isMemoryExplicitlyProtected(memory({ reinforcement_count: 5 }))).toBe(false);
    expect(
      isMemoryExplicitlyProtected(
        memory({ retention_state: "working", evidence_refs: [], reinforcement_count: 0 })
      )
    ).toBe(false);
  });
});
