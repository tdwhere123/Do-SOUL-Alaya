import { describe, expect, it } from "vitest";
import { buildQuestionDiagnostic } from
  "../../../longmemeval/diagnostics.js";
import { LongMemEvalQuestionDiagnosticSchema } from
  "../../../longmemeval/diagnostics/schema/diagnostics-schema.js";

const SELECTOR_OBSERVATION = {
  schema_version: 1,
  demand: null,
  evidence: {
    directness: "referenced",
    authority: "verified_user_assertion",
    validity: "behavior_eligible",
    document_identity: null,
    evidence_refs: ["evidence-alice-work"],
    event_status: "asserted",
    preference_polarity: "positive"
  },
  temporal: {
    compatibility: "compatible",
    event_time_start: "2026-07-01T00:00:00.000Z",
    event_time_end: "2026-07-01T01:00:00.000Z",
    valid_from: "2026-07-01T00:00:00.000Z",
    valid_to: null,
    time_precision: "day",
    time_source: "session_timestamp"
  },
  coverage: { marginal_gain: 0.485 },
  path: {
    status: "complete",
    receipts: [{
      receipt_status: "complete",
      path_id: "path-alice-work",
      relation_kind: "answers_with",
      source_object_id: "source-alice",
      target_object_id: "gold-a",
      source_anchor: { kind: "object", object_id: "source-alice" },
      target_anchor: { kind: "object", object_id: "gold-a" },
      source_version: "path-v1",
      edge_conductance: 0.4
    }]
  }
} as const;

describe("candidate selector observation contract", () => {
  it("survives raw candidate narrowing and persisted replay", () => {
    const question = buildQuestion({ selector_observation: SELECTOR_OBSERVATION });

    expect(question.candidates[0]?.selector_observation).toEqual(SELECTOR_OBSERVATION);
    expect(LongMemEvalQuestionDiagnosticSchema.parse(question).candidates[0]
      ?.selector_observation).toEqual(SELECTOR_OBSERVATION);
  });

  it("defaults old rows to null and rejects malformed receipts", () => {
    const legacy = LongMemEvalQuestionDiagnosticSchema.parse(buildQuestion({}));
    expect(legacy.candidates[0]?.selector_observation).toBeNull();

    const malformed = buildQuestion({
      selector_observation: {
        ...SELECTOR_OBSERVATION,
        path: { status: "complete", receipts: [{ path_id: "missing-fields" }] }
      }
    });
    expect(malformed.candidates).toEqual([]);
    expect(malformed.candidate_pool_complete).toBe(false);
  });
});

function buildQuestion(candidateOverrides: Readonly<Record<string, unknown>>) {
  return buildQuestionDiagnostic({
    questionId: "q-selector-observation",
    goldMemoryIds: ["gold-a"],
    answerSessionIds: [],
    deliveredResults: [],
    hitAt1: false,
    hitAt5: false,
    hitAt10: false,
    degradationReason: null,
    embeddingMode: "disabled",
    recallResult: {
      diagnostics: {
        candidate_pool_count: 1,
        fine_assessment_pruned_candidates: [],
        candidates: [{
          object_id: "gold-a",
          object_kind: "memory_entry",
          candidate_key: "workspace_local:memory_entry:gold-a",
          origin_plane: "workspace_local",
          ...candidateOverrides
        }]
      }
    }
  });
}
