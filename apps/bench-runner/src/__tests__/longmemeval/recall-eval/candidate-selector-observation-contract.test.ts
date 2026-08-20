import { describe, expect, it } from "vitest";
import { buildQuestionDiagnostic } from
  "../../../bench/diagnostics.js";
import { readCandidateSelectorObservation } from
  "../../../bench/diagnostics/artifacts/candidate-selector-observation-reader.js";
import { LongMemEvalQuestionDiagnosticSchema } from
  "../../../bench/diagnostics/schema/diagnostics-schema.js";

const LEGACY_SELECTOR_OBSERVATION = {
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

const SELECTOR_OBSERVATION = {
  ...LEGACY_SELECTOR_OBSERVATION,
  schema_version: 2,
  demand: {
    atoms: [
      { id: "ordering:latest", kind: "ordering", value: "latest", priority: "core" },
      { id: "lexical_term:work", kind: "lexical_term", value: "work", priority: "supporting" }
    ],
    matches: [{
      id: "ordering:latest",
      kind: "ordering",
      value: "latest",
      priority: "core",
      source: "temporal"
    }],
    unmatched: [
      { id: "lexical_term:work", kind: "lexical_term", value: "work", priority: "supporting" }
    ]
  },
  evidence: { ...LEGACY_SELECTOR_OBSERVATION.evidence, source_role: "user" }
} as const;

describe("candidate selector observation contract", () => {
  it("survives raw candidate narrowing and persisted replay", () => {
    const question = buildQuestion({ selector_observation: SELECTOR_OBSERVATION });

    expect(question.candidates[0]?.selector_observation).toEqual(SELECTOR_OBSERVATION);
    expect(LongMemEvalQuestionDiagnosticSchema.parse(question).candidates[0]
      ?.selector_observation).toEqual(SELECTOR_OBSERVATION);
  });

  it("keeps archived version-one observations readable", () => {
    const question = buildQuestion({ selector_observation: LEGACY_SELECTOR_OBSERVATION });

    expect(LongMemEvalQuestionDiagnosticSchema.parse(question).candidates[0]
      ?.selector_observation).toEqual(LEGACY_SELECTOR_OBSERVATION);
  });

  it("persists admission attempts and fact-key projection attribution", () => {
    const admissionAttempts = [{
      pass: "final_selector",
      selection_order: 2,
      admitted: true,
      dropped_reason: null
    }] as const;
    const projectionMatches = [{
      evidence_ref: "evidence-alice-work",
      projection_kind: "fact_key",
      projection_id: 5,
      normalized_rank: 0.8,
      fact_key_forms: [{
        kind: "leave_one_slot_out",
        omitted_slot: { slot_index: 2, role: "value" }
      }],
      fact_slots: [
        { role: "subject", text: "Alice" },
        { role: "relation", text: "works at" },
        { role: "value", text: "Acme" }
      ]
    }] as const;

    const question = buildQuestion({
      admission_attempts: admissionAttempts,
      evidence_projection_matches: projectionMatches
    });

    expect(question.candidates[0]?.admission_attempts).toEqual(admissionAttempts);
    expect(question.candidates[0]?.evidence_projection_matches).toEqual(
      projectionMatches
    );
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

  it("round-trips archived dumps that still carry kind facet demand atoms", () => {
    const observation = {
      ...LEGACY_SELECTOR_OBSERVATION,
      demand: {
        atoms: [{ kind: "facet", value: "occupation_work" }],
        matches: [],
        unmatched: [{ kind: "facet", value: "occupation_work" }]
      }
    };

    expect(readCandidateSelectorObservation(observation)).toEqual(observation);
    const question = buildQuestion({ selector_observation: observation });
    expect(question.candidates[0]?.selector_observation).toEqual(observation);
    expect(LongMemEvalQuestionDiagnosticSchema.parse(question).candidates[0]
      ?.selector_observation).toEqual(observation);
  });

  it("round-trips a storage_error path observation instead of dropping the candidate", () => {
    const observation = {
      ...SELECTOR_OBSERVATION,
      path: { status: "storage_error" as const, receipts: [] }
    };
    const question = buildQuestion({ selector_observation: observation });

    expect(readCandidateSelectorObservation(observation)).toEqual(observation);
    expect(question.candidates[0]?.selector_observation).toEqual(observation);
    expect(LongMemEvalQuestionDiagnosticSchema.parse(question).candidates[0]
      ?.selector_observation).toEqual(observation);
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
