import { describe, expect, it } from "vitest";
import {
  BenchRecallDiagnosticsSchema
} from "../../../harness/recall/recall-diagnostics-schema.js";
import {
  assembleQuestionDiagnostic
} from "../../../longmemeval/diagnostics/question-assembly.js";
import {
  readRecallDiagnostics
} from "../../../longmemeval/diagnostics/schema/diagnostics-private.js";
import {
  LongMemEvalQuestionDiagnosticSchema
} from "../../../longmemeval/diagnostics/schema/diagnostics-schema.js";

const packetPlanTrace = {
  schema_version: 1,
  assessment_path: "snapshot",
  baseline_candidate_keys: [
    "workspace_local:memory_entry:memory-a",
    "global:evidence_capsule:evidence-b"
  ],
  planned_candidate_keys: [
    "global:evidence_capsule:evidence-b",
    "workspace_local:memory_entry:memory-a"
  ],
  actual_candidate_keys: [
    "global:evidence_capsule:evidence-b",
    "workspace_local:memory_entry:memory-a"
  ],
  decision: {
    status: "accepted",
    challenger_candidate_key: "global:evidence_capsule:evidence-b",
    victim_candidate_key: "workspace_local:memory_entry:memory-a",
    reason: "bounded_displacement"
  }
} as const;

describe("packet plan trace diagnostics schemas", () => {
  it("keeps bench recall diagnostics compatible when the optional trace is absent", () => {
    const parsed = BenchRecallDiagnosticsSchema.parse(benchDiagnostics());

    expect(parsed).not.toHaveProperty("packet_plan_trace");
  });

  it("accepts a valid packet plan trace in bench recall diagnostics", () => {
    const parsed = BenchRecallDiagnosticsSchema.parse({
      ...benchDiagnostics(),
      packet_plan_trace: packetPlanTrace
    });

    expect(parsed.packet_plan_trace).toEqual(packetPlanTrace);
  });

  it("reads the raw trace and persists it through question assembly", () => {
    const recallResult = {
      diagnostics: { packet_plan_trace: packetPlanTrace }
    };
    const diagnostics = readRecallDiagnostics(recallResult, "disabled");
    if (diagnostics === null) {
      throw new Error("expected valid raw recall diagnostics");
    }
    const assembled = assembleQuestionDiagnostic({
      questionId: "packet-plan-trace-assembly",
      goldMemoryIds: [],
      answerSessionIds: [],
      deliveredResults: [],
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      degradationReason: null,
      recallResult,
      embeddingMode: "disabled"
    }, {
      diagnostics,
      deliveredResults: [],
      activeConstraintResults: [],
      gold: [],
      candidates: []
    });

    expect({
      read: diagnostics.packetPlanTrace,
      persisted: assembled.packet_plan_trace
    }).toEqual({
      read: packetPlanTrace,
      persisted: packetPlanTrace
    });
  });

  it("accepts nullable and valid packet plan traces in persisted diagnostics", () => {
    expect(
      LongMemEvalQuestionDiagnosticSchema.parse({
        ...persistedQuestionDiagnostic(),
        packet_plan_trace: null
      }).packet_plan_trace
    ).toBeNull();

    expect(
      LongMemEvalQuestionDiagnosticSchema.parse({
        ...persistedQuestionDiagnostic(),
        packet_plan_trace: packetPlanTrace
      }).packet_plan_trace
    ).toEqual(packetPlanTrace);
  });
});

function benchDiagnostics() {
  return {
    query_probes: {
      normalized_query: "question",
      object_ids: [],
      subject_hints: [],
      evidence_refs: [],
      run_ids: [],
      surface_ids: [],
      file_paths: [],
      command_names: [],
      package_names: [],
      task_refs: [],
      dimensions: [],
      scope_classes: [],
      domain_tags: [],
      lexical_terms: [],
      expanded_terms: [],
      phrases: [],
      char_ngrams: [],
      date_terms: []
    },
    total_scanned: 0,
    candidate_pool_count: 0,
    pre_budget_count: 0,
    delivered_count: 0,
    embedding_provider_status: "provider_not_requested",
    provider_degradation_reason: null,
    answer_rerank_status: "not_requested",
    answer_rerank_expected_count: 0,
    answer_rerank_scored_count: 0,
    answer_rerank_failure_class: null,
    graph_expansion_plane_count_per_hop: [0, 0],
    graph_expansion_plane_count_per_edge_type: {
      derives_from: 0,
      recalls: 0,
      supports: 0
    },
    fusion_breakdown: [],
    candidates: [],
    fine_assessment_pruned_candidates: []
  };
}

function persistedQuestionDiagnostic() {
  return {
    question_id: "packet-plan-trace",
    round_index: null,
    gold_memory_ids: [],
    answer_session_ids: [],
    delivered_results: [],
    active_constraint_results: [],
    hit_at_1: false,
    hit_at_5: false,
    hit_at_10: false,
    miss_classification: "no_gold",
    degradation_reason: null,
    recall_diagnostics_present: true,
    recall_diagnostics_keys: [],
    provider_state: "provider_not_requested",
    provider_degradation_reason: null,
    graph_expansion_plane_count_per_hop: [0, 0],
    graph_expansion_plane_count_per_edge_type: {
      derives_from: 0,
      recalls: 0,
      supports: 0
    },
    candidate_key_collisions: [],
    gold: []
  };
}
