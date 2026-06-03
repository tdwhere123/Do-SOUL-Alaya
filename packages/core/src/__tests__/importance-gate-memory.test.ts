import { describe, expect, it } from "vitest";
import type { MemoryEntry } from "@do-soul/alaya-protocol";
import { classifyMemoryImportance, isMemoryJudgedUseless } from "../importance-gate.js";

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
    // Default: single evidence ref so the evidence-rich keep-criterion (>=2)
    // does NOT fire unless a test sets two.
    evidence_refs: ["evidence-1"],
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
    expect(result.reason).toBe("evidence_basis_rich");
  });

  it("KEEPs (keep) a well-supported memory (reinforcement_count above threshold)", () => {
    const result = classifyMemoryImportance(memory({ reinforcement_count: 50 }));
    expect(result.disposition).toBe("keep");
    expect(result.reason).toBe("well_supported");
  });

  it("judges USELESS only when ALL keep-criteria fail", () => {
    const candidate = memory({
      decay_profile: "normal",
      retention_state: "working",
      evidence_refs: ["only-one"],
      reinforcement_count: 0
    });
    expect(classifyMemoryImportance(candidate).disposition).toBe("judged_useless");
    expect(isMemoryJudgedUseless(candidate)).toBe(true);
  });

  it("treats a null reinforcement_count as zero support (not a keep signal)", () => {
    const candidate = memory({
      retention_state: "working",
      evidence_refs: ["only-one"],
      reinforcement_count: null
    });
    expect(classifyMemoryImportance(candidate).disposition).toBe("judged_useless");
  });

  it("protection order: pinned wins over an otherwise-useless profile", () => {
    const candidate = memory({
      decay_profile: "pinned",
      retention_state: "working",
      evidence_refs: ["only-one"],
      reinforcement_count: 0
    });
    expect(classifyMemoryImportance(candidate).disposition).toBe("protected");
  });
});
