import { describe, expect, it } from "vitest";
import { buildQuestionDiagnostic, stripReplayCandidatePoolsForGateWrite } from
  "../../../bench/diagnostics.js";
import { readRecallDiagnostics } from
  "../../../bench/diagnostics/schema/diagnostics-private.js";
import { EvidenceCandidateScoringSelectionReceiptSchema } from
  "../../../harness/recall/recall-diagnostics-schema.js";

const receipt = Object.freeze({
  schema_version: 1 as const,
  operator_id: "ordered_candidate_prefix_v1" as const,
  input_candidate_keys: ["workspace_local:memory_entry:memory-a"],
  owner_gist_enabled: true,
  owner_gist_candidate_keys: ["workspace_local:memory_entry:memory-a"],
  full_evidence_candidate_keys: ["workspace_local:memory_entry:memory-a"],
  owner_gist_limit: 16,
  full_evidence_limit: 32,
  input_memory_count: 1,
  owner_gist_selected_count: 1,
  full_evidence_selected_count: 1,
  owner_gist_excluded_count: 0,
  full_evidence_excluded_count: 0
});

describe("LongMemEval evidence selection receipt", () => {
  it("persists the layered selection receipt and strips it from compact gate rows", () => {
    const question = buildQuestionDiagnostic({
      questionId: "q-selection-receipt",
      goldMemoryIds: ["memory-a"],
      answerSessionIds: [],
      deliveredResults: [],
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: {
        diagnostics: {
          evidence_embedding_selection_receipt: receipt,
          candidates: []
        }
      }
    });

    expect(question.evidence_embedding_selection_receipt).toEqual(receipt);
    const compact = stripReplayCandidatePoolsForGateWrite({
      schema_version: 1,
      bench_name: "public",
      split: "test",
      run_at: "2026-08-13T00:00:00.000Z",
      alaya_commit: "test",
      embedding_provider: "none",
      embedding_mode: "disabled",
      provider_state_summary: {
        total: 1,
        provider_returned: 0,
        provider_pending: 0,
        provider_failed: 0,
        provider_not_requested: 1,
        query_embedding_unusable: 0,
        unknown: 0,
        provider_returned_rate: 0,
        provider_pending_rate: 0,
        provider_failed_rate: 0,
        provider_not_requested_rate: 1,
        query_embedding_unusable_rate: 0,
        unknown_rate: 0
      },
      questions: [question]
    });
    expect(compact.questions[0]?.evidence_embedding_selection_receipt).toBeNull();
  });

  it("rejects non-prefix or internally inconsistent selection receipts", () => {
    expect(EvidenceCandidateScoringSelectionReceiptSchema.safeParse({
      ...receipt,
      input_candidate_keys: [
        "workspace_local:memory_entry:memory-a",
        "workspace_local:memory_entry:memory-b"
      ],
      owner_gist_candidate_keys: ["workspace_local:memory_entry:memory-b"],
      full_evidence_candidate_keys: [
        "workspace_local:memory_entry:memory-a",
        "workspace_local:memory_entry:memory-b"
      ],
      input_memory_count: 2,
      owner_gist_selected_count: 1,
      full_evidence_selected_count: 2
    }).success).toBe(false);
    expect(EvidenceCandidateScoringSelectionReceiptSchema.safeParse({
      ...receipt,
      owner_gist_excluded_count: 1
    }).success).toBe(false);
    expect(readRecallDiagnostics({
      diagnostics: {
        evidence_embedding_selection_receipt: {
          ...receipt,
          owner_gist_excluded_count: 1
        },
        candidates: []
      }
    }, "disabled")).toBeNull();
  });
});
