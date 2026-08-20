import { describe, expect, it } from "vitest";
import { SingleRunProvenanceBindingSchema, RunProvenanceBindingSchema } from "../../gates/longmemeval-provenance-schemas.js";
import {
  WORKTREE_STATE_ALGORITHM_HEAD_LF,
  WORKTREE_STATE_ALGORITHM_V2,
  WORKTREE_STATE_ALGORITHM_V3,
  WorktreeStateAlgorithmSchema
} from "../../gates/worktree-state-algorithm.js";
import { compactFixture } from "./longmemeval-provenance-fixture.js";

describe("worktree state algorithm release binding", () => {
  it("parses v2 only as archive-era and rejects dirty v2/v3 release bindings", () => {
    expect(WorktreeStateAlgorithmSchema.parse(WORKTREE_STATE_ALGORITHM_HEAD_LF))
      .toBe(WORKTREE_STATE_ALGORITHM_HEAD_LF);
    expect(WorktreeStateAlgorithmSchema.parse(WORKTREE_STATE_ALGORITHM_V2))
      .toBe(WORKTREE_STATE_ALGORITHM_V2);
    expect(WorktreeStateAlgorithmSchema.parse(WORKTREE_STATE_ALGORITHM_V3))
      .toBe(WORKTREE_STATE_ALGORITHM_V3);

    const child = childProvenance();
    expect(SingleRunProvenanceBindingSchema.parse(child).code.worktree_clean).toBe(true);

    const { worktree_state_algorithm: _algorithm, ...legacyCode } = child.code;
    expect(SingleRunProvenanceBindingSchema.parse({
      ...child,
      code: legacyCode
    }).code.worktree_state_algorithm).toBeUndefined();

    expect(SingleRunProvenanceBindingSchema.safeParse(plantDirty(child, "sha256-worktree-state-v2")).success)
      .toBe(false);
    expect(SingleRunProvenanceBindingSchema.safeParse(plantDirty(child, "sha256-worktree-state-v3")).success)
      .toBe(false);
    expect(RunProvenanceBindingSchema.safeParse(plantDirty(child, "sha256-worktree-state-v2")).success)
      .toBe(false);
    expect(RunProvenanceBindingSchema.safeParse(plantDirty(child, "sha256-worktree-state-v3")).success)
      .toBe(false);
    expect(SingleRunProvenanceBindingSchema.safeParse({
      ...child,
      code: {
        ...child.code,
        worktree_clean: true,
        worktree_state_algorithm: "sha256-worktree-state-v2"
      }
    }).success).toBe(false);
  });
});

function childProvenance() {
  const fixture = compactFixture();
  const artifact = fixture.artifacts.find((item) => item.role === "shard_run_provenance");
  if (artifact === undefined) throw new Error("compact fixture lacks a child provenance");
  return SingleRunProvenanceBindingSchema.parse(JSON.parse(artifact.contents));
}

function plantDirty(
  child: ReturnType<typeof childProvenance>,
  algorithm: "sha256-worktree-state-v2" | "sha256-worktree-state-v3"
) {
  return {
    ...child,
    code: {
      ...child.code,
      worktree_clean: false,
      worktree_state_algorithm: algorithm
    }
  };
}
