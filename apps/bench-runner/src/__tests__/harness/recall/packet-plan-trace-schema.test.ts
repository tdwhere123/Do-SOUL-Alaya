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

const obsoletePacketPlanTraceV1 = {
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

const packetPlanTraceV2 = {
  schema_version: 2,
  assessment_path: "snapshot",
  baseline_candidate_keys: [
    "workspace_local:memory_entry:memory-a",
    "global:evidence_capsule:evidence-b",
    "workspace_local:synthesis_capsule:synthesis-c"
  ],
  planned_candidate_keys: [
    "workspace_local:memory_entry:memory-a",
    "global:evidence_capsule:evidence-d",
    "global:evidence_capsule:evidence-b"
  ],
  actual_candidate_keys: [
    "workspace_local:memory_entry:memory-a",
    "global:evidence_capsule:evidence-d",
    "global:evidence_capsule:evidence-b"
  ],
  head_width: 2,
  baseline_head_candidate_keys: [
    "workspace_local:memory_entry:memory-a",
    "global:evidence_capsule:evidence-b"
  ],
  embedding_head: [{
    candidate_key: "global:evidence_capsule:evidence-d",
    embedding_rank: 1
  }],
  consensus_head_candidate_keys: [
    "workspace_local:memory_entry:memory-a",
    "global:evidence_capsule:evidence-d"
  ],
  immutable_tail_candidate_keys: [
    "workspace_local:synthesis_capsule:synthesis-c"
  ],
  protected_candidates: [{
    candidate_key: "workspace_local:memory_entry:memory-a",
    rank_limit: 1
  }],
  added_candidate_keys: ["global:evidence_capsule:evidence-d"],
  removed_candidate_keys: ["workspace_local:synthesis_capsule:synthesis-c"],
  decision: {
    status: "accepted",
    reason: "strict_tail_consensus"
  }
} as const;

const rejectedPacketPlanTraceV2 = {
  ...packetPlanTraceV2,
  actual_candidate_keys: packetPlanTraceV2.baseline_candidate_keys,
  protected_candidates: [{
    candidate_key: "global:evidence_capsule:evidence-b",
    rank_limit: 2
  }],
  decision: {
    status: "rejected",
    reason: "protected_candidate_constraint"
  }
} as const;

const noOpPacketPlanTraceV2 = {
  ...packetPlanTraceV2,
  planned_candidate_keys: packetPlanTraceV2.baseline_candidate_keys,
  actual_candidate_keys: packetPlanTraceV2.baseline_candidate_keys,
  embedding_head: [],
  consensus_head_candidate_keys: packetPlanTraceV2.baseline_head_candidate_keys,
  protected_candidates: [],
  added_candidate_keys: [],
  removed_candidate_keys: [],
  decision: {
    status: "no_op",
    reason: "no_finite_embedding_head"
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
      packet_plan_trace: packetPlanTraceV2
    });

    expect(parsed.packet_plan_trace).toEqual(packetPlanTraceV2);
  });

  it.each([
    ["accepted", packetPlanTraceV2],
    ["rejected", rejectedPacketPlanTraceV2],
    ["no-op", noOpPacketPlanTraceV2]
  ] as const)("reads and persists a raw %s trace unchanged", (_version, packetPlanTrace) => {
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

  it("rejects the obsolete v1 trace at both bench persistence boundaries", () => {
    expect(() => BenchRecallDiagnosticsSchema.parse({
      ...benchDiagnostics(),
      packet_plan_trace: obsoletePacketPlanTraceV1
    })).toThrow();

    expect(() => LongMemEvalQuestionDiagnosticSchema.parse({
      ...persistedQuestionDiagnostic(),
      packet_plan_trace: obsoletePacketPlanTraceV1
    })).toThrow();

    expect(() => readRecallDiagnostics({
      diagnostics: { packet_plan_trace: obsoletePacketPlanTraceV1 }
    }, "disabled")).toThrow();
  });

  it("accepts nullable support-set packet traces in persisted diagnostics", () => {
    expect(
      LongMemEvalQuestionDiagnosticSchema.parse({
        ...persistedQuestionDiagnostic(),
        packet_plan_trace: null
      }).packet_plan_trace
    ).toBeNull();

    expect(
      LongMemEvalQuestionDiagnosticSchema.parse({
        ...persistedQuestionDiagnostic(),
        packet_plan_trace: packetPlanTraceV2
      }).packet_plan_trace
    ).toEqual(packetPlanTraceV2);
  });

  it("rejects private content, evaluator gold, and unapproved scalar fields", () => {
    const forbiddenRootFields = [
      { content_preview: "private" },
      { evaluator_gold: true },
      { relevance_score: 0.9 }
    ];
    for (const forbidden of forbiddenRootFields) {
      expect(() => BenchRecallDiagnosticsSchema.parse({
        ...benchDiagnostics(),
        packet_plan_trace: { ...packetPlanTraceV2, ...forbidden }
      })).toThrow();
    }

    for (const forbidden of [
      { content_preview: "private" },
      { evaluator_gold: true },
      { embedding_similarity: 0.9 }
    ]) {
      expect(() => BenchRecallDiagnosticsSchema.parse({
        ...benchDiagnostics(),
        packet_plan_trace: {
          ...packetPlanTraceV2,
          embedding_head: [{ ...packetPlanTraceV2.embedding_head[0], ...forbidden }]
        }
      })).toThrow();
    }
  });

  it.each([
    ["accepted", {
      ...packetPlanTraceV2,
      actual_candidate_keys: packetPlanTraceV2.baseline_candidate_keys
    }],
    ["rejected", {
      ...rejectedPacketPlanTraceV2,
      actual_candidate_keys: rejectedPacketPlanTraceV2.planned_candidate_keys
    }],
    ["no-op", {
      ...noOpPacketPlanTraceV2,
      planned_candidate_keys: packetPlanTraceV2.planned_candidate_keys
    }]
  ] as const)("rejects an inconsistent %s outcome", (_status, packetPlanTrace) => {
    expect(() => BenchRecallDiagnosticsSchema.parse({
      ...benchDiagnostics(),
      packet_plan_trace: packetPlanTrace
    })).toThrow();
  });

  it("rejects a causal decision that contradicts the observed proposal", () => {
    expect(() => BenchRecallDiagnosticsSchema.parse({
      ...benchDiagnostics(),
      packet_plan_trace: {
        ...noOpPacketPlanTraceV2,
        decision: {
          status: "rejected",
          reason: "behavior_guard_full_abort"
        }
      }
    })).toThrow();
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
