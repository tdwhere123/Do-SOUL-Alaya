import { describe, expect, it } from "vitest";
import { renderRecallEvalRankIdentity } from "../../../bench/provenance/recall-eval/recall-eval-rank-identity.js";
import { snapshotQuestionIdDigest } from "../../../bench/snapshot/materialize.js";

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

  it("binds the selection-boundary artifact into replay identity", () => {
    const collected = [{ questionId: "q-1", deliveredObjects: [object("m-1")] }];
    const binding = {
      filename: "selection-boundaries.ndjson.gz" as const,
      sha256: "a".repeat(64),
      bytes: 123,
      record_count: 4
    };
    const rendered = renderRecallEvalRankIdentity(collected, {
      expectedQuestionCount: 1,
      expectedQuestionIdDigest: snapshotQuestionIdDigest(collected),
      requireFullSnapshotMatch: true,
      selectionBoundary: binding
    });

    const parsed = JSON.parse(rendered) as {
      replay: { selection_boundary: unknown };
    };
    expect(parsed.replay.selection_boundary).toEqual(binding);
    expect(() => renderRecallEvalRankIdentity(collected, {
      expectedQuestionCount: 1,
      expectedQuestionIdDigest: snapshotQuestionIdDigest(collected),
      requireFullSnapshotMatch: true,
      selectionBoundary: { ...binding, sha256: "invalid" }
    })).toThrow(/selection boundary binding is invalid/u);
  });

  it("persists the complete derived snapshot identity in the bound rank artifact", () => {
    const collected = [{ questionId: "q-1", deliveredObjects: [object("m-1")] }];
    const report = {
      schema_version: 1 as const,
      promotable: false as const,
      input_db_sha256: "a".repeat(64),
      rebuilt_db_identity_sha256: "b".repeat(64),
      source_schema_version: 108,
      working_schema_version: 110,
      eligible_owner_count: 3,
      rebuilt_owner_count: 3,
      rejected_owner_count: 0,
      zero_child_owner_count: 1,
      nonzero_child_owner_count: 2,
      child_count: 4,
      projection_kind_counts: [
        { projection_kind: "assistant_observation", child_count: 1 },
        { projection_kind: "user_assertion", child_count: 3 }
      ],
      projection_content_sha256: "c".repeat(64)
    };
    const rendered = renderRecallEvalRankIdentity(collected, {
      expectedQuestionCount: 1,
      expectedQuestionIdDigest: snapshotQuestionIdDigest(collected),
      requireFullSnapshotMatch: true,
      derivedEvidenceProjectionRebuild: report,
      warmDerivedSnapshot: {
        receipt_sha256: "d".repeat(64),
        database_sha256: "e".repeat(64),
        database_schema_version: 110,
        derived_rebuild_identity_sha256: "b".repeat(64)
      }
    });

    expect(JSON.parse(rendered)).toMatchObject({
      snapshot_binding: {
        derived_evidence_projection_rebuild: report,
        warm_derived_snapshot: {
          receipt_sha256: "d".repeat(64),
          database_sha256: "e".repeat(64),
          database_schema_version: 110,
          derived_rebuild_identity_sha256: "b".repeat(64)
        }
      }
    });
  });
});

function object(objectId: string, objectKind = "memory_entry") {
  return { object_id: objectId, object_kind: objectKind };
}
