import {
  createCaptureParityView,
  mapCaptureParityChannels,
  requireRetrievalFieldCaptures,
  type CaptureParityView
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
  return createCaptureParityView({
    question_id: result.questionId,
    channels: mapCaptureParityChannels(
      requireRetrievalFieldCaptures(
        result.questionId,
        result.diagnostics.retrieval_field_captures
      )
    ),
    geometry: {
      answer_shape_plan: result.diagnostics.answer_shape_plan,
      probes
    },
    membership: result.diagnostics.delivered_results.map((row) => ({
      object_kind: row.object_kind ?? "memory_entry",
      object_id: row.object_id
    })),
    assessment_path: result.diagnostics.packet_plan_trace?.assessment_path ?? null
  });
}
