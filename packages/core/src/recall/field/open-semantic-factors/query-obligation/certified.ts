import {
  QUERY_FACT_FRAME_OSF_OBLIGATION_OPERATOR_ID,
  RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID,
  QueryFactFrameOsfObligationSchema,
  queryFactFrameOsfObligationPreimage,
  type QueryFactFrameOsfObligation
} from "@do-soul/alaya-protocol";
import { traceRuleBasedQueryFactFrame } from
  "../../../../shared/query-fact-frame-extraction-rules.js";
import {
  verifyRecallQueryFactFrameExtractionCapture,
  type RecallQueryFactFrameExtractionCapture
} from "../../query-attribution/query-fact-frame-attribution-producer.js";
import { captureMatchesTrace, digestQueryFactFrame } from "./identity.js";

export { captureMatchesTrace, digestQueryFactFrame };

export function deriveQueryFactFrameOsfObligation(input: Readonly<{
  query_text: string;
  fact_frame_capture: Readonly<RecallQueryFactFrameExtractionCapture>;
}>): QueryFactFrameOsfObligation | null {
  verifyRecallQueryFactFrameExtractionCapture(input.fact_frame_capture);
  const capture = input.fact_frame_capture;
  const trace = traceRuleBasedQueryFactFrame(input.query_text);
  if (capture.status !== "returned" || capture.frames.length !== 1 ||
      capture.producer_operator_id !== RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID ||
      trace?.osfLayout === null || trace?.osfLayout === undefined ||
      !captureMatchesTrace(capture.frames[0]!, trace.frame)) {
    return null;
  }
  const body = {
    schema_version: 2 as const,
    operator_id: QUERY_FACT_FRAME_OSF_OBLIGATION_OPERATOR_ID,
    query_digest: digestQueryFactFrame(input.query_text),
    fact_frame_producer_operator_id: capture.producer_operator_id,
    fact_frame_capture_digest: capture.capture_digest,
    predicate: obligationSlot(trace.osfLayout.predicate, 0),
    subject: obligationSlot(trace.osfLayout.subject, 0),
    constraints: trace.osfLayout.constraints.map((constraint, index) =>
      obligationSlot(constraint, index + 1)),
    value: obligationSlot(
      trace.osfLayout.value, trace.osfLayout.constraints.length + 1
    ),
    arity: trace.osfLayout.constraints.length + 2
  };
  return QueryFactFrameOsfObligationSchema.parse({
    ...body,
    obligation_digest: digestQueryFactFrame(queryFactFrameOsfObligationPreimage(body))
  });
}

function obligationSlot(
  slot: Readonly<{ surface: string; source_span: readonly [number, number] }>,
  position: number
) {
  return {
    surface: slot.surface,
    source_span: [slot.source_span[0], slot.source_span[1]] as [number, number],
    position
  };
}
