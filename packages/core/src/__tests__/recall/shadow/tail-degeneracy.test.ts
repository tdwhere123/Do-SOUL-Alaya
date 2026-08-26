import { describe, expect, it } from "vitest";
import { CAPTURE_IDENTITY_DIGEST } from "../../../recall/shadow/index.js";
import {
  deterministicTailDecidedThisPick,
  type DeterministicTailPickEvidence
} from "../../../recall/shadow/walk.js";
import {
  FIRST_PICK_TAIL_DECIDED_SHARE_MAX,
  evaluateFirstPickTailDegeneracy
} from "../../../recall/shadow/ranking/tail-degeneracy.js";

describe("first-pick tail degeneracy property", () => {
  it("holds when the max-G cohort is unique", () => {
    const pick = receipt(["cover-only"]);
    expect(deterministicTailDecidedThisPick(pick)).toBe(false);
    const report = evaluateFirstPickTailDegeneracy([pick]);
    expect(report.holds).toBe(true);
    expect(report.share).toBe(0);
    expect(report.max_share).toBe(FIRST_PICK_TAIL_DECIDED_SHARE_MAX);
  });

  it("fails when a tied max-G cohort is unshrunk by Psi", () => {
    const pick = receipt(["aaa-distractor", "zzz-cover"]);
    expect(deterministicTailDecidedThisPick(pick)).toBe(true);
    const report = evaluateFirstPickTailDegeneracy([pick]);
    expect(report.holds).toBe(false);
    expect(report.share).toBe(1);
    expect(report.tail_decided_count).toBe(1);
  });

  it("does not count a Psi-shrunk equal-G cohort as tail-decided", () => {
    const pick: DeterministicTailPickEvidence = {
      max_g_cohort: ["aaa", "bbb"],
      equal_g_dominance_rejects: [{ candidate_key: "bbb", dominated_by: "aaa" }]
    };
    expect(deterministicTailDecidedThisPick(pick)).toBe(false);
    expect(evaluateFirstPickTailDegeneracy([pick]).holds).toBe(true);
  });

  it("keeps the capture identity digest unchanged", () => {
    expect(CAPTURE_IDENTITY_DIGEST).toBe(
      "db68fc1dbd2f3e2a71dab08df7feb86c683de12c54ccdc10edfb17916dcef0e3"
    );
  });
});

function receipt(cohort: readonly string[]): DeterministicTailPickEvidence {
  return {
    max_g_cohort: cohort,
    equal_g_dominance_rejects: []
  };
}
