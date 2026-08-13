import {
  compileRecallQueryDemand,
  createCaptureParityView,
  type CaptureParityView,
  type RecallQueryProbes
} from "@do-soul/alaya-core";
import type { RecallEvalQuestionResult } from
  "../lifecycle/recall-eval/recall-eval-contract.js";

export function extractCaptureParityViewFromEval(
  result: RecallEvalQuestionResult
): Readonly<CaptureParityView> {
  const probes = result.diagnostics.query_probes;
  if (probes === null || probes === undefined) {
    throw new Error(
      `capture parity query probes missing (question_id=${result.questionId})`
    );
  }
  const captures = result.diagnostics.retrieval_field_captures ?? [];
  return createCaptureParityView({
    question_id: result.questionId,
    channels: captures.map((capture) => ({
      channel_id: capture.channel.channel_id,
      status: capture.channel.status,
      observation_keys: capture.channel.observations.map((row) => row.candidate_key)
    })),
    geometry: {
      answer_shape_plan: result.diagnostics.answer_shape_plan,
      probes,
      demand: compileRecallQueryDemand(
        toQueryProbes(probes),
        { soughtFacets: result.diagnostics.query_sought_facets ?? [] }
      )
    },
    membership: result.diagnostics.delivered_results.map((row) => ({
      object_kind: row.object_kind ?? "memory_entry",
      object_id: row.object_id
    })),
    assessment_path: result.diagnostics.packet_plan_trace?.assessment_path ?? null
  });
}

function toQueryProbes(probes: NonNullable<RecallEvalQuestionResult["diagnostics"]["query_probes"]>): RecallQueryProbes {
  return {
    normalized_query: probes.normalized_query ?? null,
    subject_hints: (probes.subject_hints ?? []) as RecallQueryProbes["subject_hints"],
    object_ids: probes.object_ids ?? [],
    evidence_refs: probes.evidence_refs ?? [],
    run_ids: probes.run_ids ?? [],
    surface_ids: probes.surface_ids ?? [],
    file_paths: probes.file_paths ?? [],
    command_names: probes.command_names ?? [],
    package_names: probes.package_names ?? [],
    task_refs: probes.task_refs ?? [],
    dimensions: (probes.dimensions ?? []) as RecallQueryProbes["dimensions"],
    scope_classes: (probes.scope_classes ?? []) as RecallQueryProbes["scope_classes"],
    domain_tags: probes.domain_tags ?? [],
    lexical_terms: probes.lexical_terms ?? [],
    expanded_terms: probes.expanded_terms ?? [],
    phrases: probes.phrases ?? [],
    char_ngrams: probes.char_ngrams ?? [],
    date_terms: probes.date_terms ?? []
  };
}
