import { describe, expect, it } from "vitest";
import { renderRecallEvalRankIdentity } from "../../../longmemeval/provenance/recall-eval/recall-eval-rank-identity.js";
import { snapshotQuestionIdDigest } from "../../../longmemeval/snapshot/materialize.js";

describe("recall-eval rank identity", () => {
  it("preserves snapshot order and is sensitive to delivered rank order", () => {
    const ordered = [
      { questionId: "q-2", deliveredObjects: [object("m-3")] },
      { questionId: "q-1", deliveredObjects: [object("m-1"), object("m-2")] }
    ];
    const binding = {
      expectedQuestionCount: 2,
      expectedQuestionIdDigest: snapshotQuestionIdDigest(ordered),
      requireFullSnapshotMatch: true
    };
    const first = renderRecallEvalRankIdentity(ordered, binding);
    const same = renderRecallEvalRankIdentity(ordered, binding);
    const mismatch = renderRecallEvalRankIdentity([
      { questionId: "q-2", deliveredObjects: [object("m-3")] },
      { questionId: "q-1", deliveredObjects: [object("m-2"), object("m-1")] }
    ], binding);

    expect(same).toBe(first);
    expect(mismatch).not.toBe(first);
    const parsed = JSON.parse(first) as {
      questions: Array<{ delivered_objects: unknown[] }>;
    };
    expect(parsed).toMatchObject({
      schema_version: 2,
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
    expect(parsed.questions[0]!.delivered_objects).toEqual([object("m-3")]);
  });

  it("rejects empty and mismatched full-snapshot replays", () => {
    const binding = {
      expectedQuestionCount: 1,
      expectedQuestionIdDigest: snapshotQuestionIdDigest([{ questionId: "q-1" }]),
      requireFullSnapshotMatch: true
    };
    expect(() => renderRecallEvalRankIdentity([], binding)).toThrow(/empty replay/u);
    expect(() => renderRecallEvalRankIdentity([
      { questionId: "q-2", deliveredObjects: [] }
    ], binding)).toThrow(/does not match the frozen snapshot binding/u);
  });

  it("binds object kind as part of delivered rank identity", () => {
    const collected = [{ questionId: "q-1", deliveredObjects: [object("shared")] }];
    const binding = {
      expectedQuestionCount: 1,
      expectedQuestionIdDigest: snapshotQuestionIdDigest(collected),
      requireFullSnapshotMatch: true
    };
    const memory = renderRecallEvalRankIdentity(collected, binding);
    const synthesis = renderRecallEvalRankIdentity([{
      questionId: "q-1",
      deliveredObjects: [object("shared", "synthesis_capsule")]
    }], binding);

    expect(synthesis).not.toBe(memory);
  });
});

function object(objectId: string, objectKind = "memory_entry") {
  return { object_id: objectId, object_kind: objectKind };
}
