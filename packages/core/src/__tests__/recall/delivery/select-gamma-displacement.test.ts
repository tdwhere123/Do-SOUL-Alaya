import { describe, expect, it } from "vitest";
import { firstSelectGammaExclusionReason } from
  "../../../recall/delivery/select-gamma/admission/first-exclusion.js";
import { selectGammaWalk } from
  "../../../recall/delivery/select-gamma/select-gamma.js";
import type { SelectGammaBinding, SelectGammaRequest } from
  "../../../recall/delivery/select-gamma/types.js";
import { createSelectGammaGenericWalkObjective } from
  "../../../recall/delivery/select-gamma/walk-objective.js";
import { formulaCandidate } from "./select-gamma-parity-pool.js";

describe("Select_Gamma last-slot displacement", () => {
  it("names coverage vs quality on a complete walk", () => {
    const walk = lastSlotDisplacementWalk();
    expect(walk.selected_candidate_keys).toEqual(["cover-winner"]);
    expect(walk.decisions).toHaveLength(3);
    expect(firstSelectGammaExclusionReason("high-quality", walk))
      .toBe("coverage_displaced");
    expect(firstSelectGammaExclusionReason("low-quality", walk))
      .toBe("quality_displaced");
    expect(receiptKind(walk, "high-quality")).toBe("coverage_displaced");
    expect(receiptKind(walk, "low-quality")).toBe("quality_displaced");
  });
});

function lastSlotDisplacementWalk() {
  const candidates = Object.freeze([
    formulaCandidate("cover-winner", {
      quality: 0.2, cover: { slice: 1 }, source: "s-a"
    }),
    formulaCandidate("high-quality", {
      quality: 0.9, cover: {}, source: "s-b"
    }),
    formulaCandidate("low-quality", {
      quality: 0.1, cover: {}, source: "s-c"
    })
  ]);
  const request: SelectGammaRequest = Object.freeze({
    workspace_id: "workspace-1",
    generation_id: `sha256:${"a".repeat(64)}`,
    condition_digest: `sha256:${"b".repeat(64)}`,
    eligible_candidate_keys: Object.freeze(candidates.map(
      ({ candidate_key }) => candidate_key
    )),
    token_budget: 100
  });
  const binding: SelectGammaBinding = Object.freeze({
    workspace_id: request.workspace_id,
    generation_id: request.generation_id,
    condition_digest: request.condition_digest,
    candidates,
    feature_weights: Object.freeze({ slice: 1 }),
    max_selected: 1,
    per_dimension_limits: null,
    source_hard_dedupe: false
  });
  return selectGammaWalk(
    request,
    binding,
    createSelectGammaGenericWalkObjective(binding.feature_weights)
  );
}

function receiptKind(
  walk: ReturnType<typeof selectGammaWalk>,
  candidateKey: string
) {
  return walk.decisions.find((decision) =>
    decision.candidate_key === candidateKey)?.receipt.kind;
}
