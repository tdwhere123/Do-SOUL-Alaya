import { describe, expect, it } from "vitest";
import { renderRecallEvalRankIdentity } from "../../longmemeval/provenance/recall-eval-rank-identity.js";
import { snapshotQuestionIdDigest } from "../../longmemeval/snapshot.js";

describe("recall-eval rank identity", () => {
  it("preserves snapshot order and is sensitive to delivered rank order", () => {
    const ordered = [
      { questionId: "q-2", deliveredObjectIds: ["m-3"] },
      { questionId: "q-1", deliveredObjectIds: ["m-1", "m-2"] }
    ];
    const binding = {
      expectedQuestionCount: 2,
      expectedQuestionIdDigest: snapshotQuestionIdDigest(ordered),
      requireFullSnapshotMatch: true
    };
    const first = renderRecallEvalRankIdentity(ordered, binding);
    const same = renderRecallEvalRankIdentity(ordered, binding);
    const mismatch = renderRecallEvalRankIdentity([
      { questionId: "q-2", deliveredObjectIds: ["m-3"] },
      { questionId: "q-1", deliveredObjectIds: ["m-2", "m-1"] }
    ], binding);

    expect(same).toBe(first);
    expect(mismatch).not.toBe(first);
    expect(JSON.parse(first)).toMatchObject({
      snapshot_binding: {
        expected_question_count: 2,
        expected_question_id_digest: binding.expectedQuestionIdDigest
      },
      replay: {
        question_count: 2,
        question_id_digest: binding.expectedQuestionIdDigest,
        full_snapshot_match: true
      }
    });
  });

  it("rejects empty and mismatched full-snapshot replays", () => {
    const binding = {
      expectedQuestionCount: 1,
      expectedQuestionIdDigest: snapshotQuestionIdDigest([{ questionId: "q-1" }]),
      requireFullSnapshotMatch: true
    };
    expect(() => renderRecallEvalRankIdentity([], binding)).toThrow(/empty replay/u);
    expect(() => renderRecallEvalRankIdentity([
      { questionId: "q-2", deliveredObjectIds: [] }
    ], binding)).toThrow(/does not match the frozen snapshot binding/u);
  });
});
