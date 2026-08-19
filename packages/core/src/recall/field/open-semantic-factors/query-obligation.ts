import { createHash } from "node:crypto";
import {
  QUERY_FACT_FRAME_OSF_OBLIGATION_OPERATOR_ID,
  QueryFactFrameOsfObligationSchema,
  queryFactFrameOsfObligationPreimage,
  type QueryFactFrameOsfObligation
} from "@do-soul/alaya-protocol";
import {
  RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID,
  traceRuleBasedQueryFactFrame
} from "../../../shared/query-fact-frame-extraction-rules.js";
import {
  verifyRecallQueryFactFrameExtractionCapture,
  type RecallQueryFactFrameExtractionCapture
} from "../query-attribution/query-fact-frame-attribution-producer.js";

export function deriveQueryFactFrameOsfObligation(input: Readonly<{
  query_text: string;
  fact_frame_capture: Readonly<RecallQueryFactFrameExtractionCapture>;
}>): QueryFactFrameOsfObligation | null {
  verifyRecallQueryFactFrameExtractionCapture(input.fact_frame_capture);
  const capture = input.fact_frame_capture;
  const trace = traceRuleBasedQueryFactFrame(input.query_text);
  if (capture.status !== "returned" || capture.frames.length !== 1 ||
      capture.producer_operator_id !== RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID ||
      trace?.binaryLayout === null || trace?.binaryLayout === undefined ||
      !captureMatchesTrace(capture.frames[0]!, trace.frame)) {
    return null;
  }
  const body = {
    schema_version: 1 as const,
    operator_id: QUERY_FACT_FRAME_OSF_OBLIGATION_OPERATOR_ID,
    query_digest: digest(input.query_text),
    fact_frame_producer_operator_id: capture.producer_operator_id,
    fact_frame_capture_digest: capture.capture_digest,
    predicate: obligationSlot(trace.binaryLayout.predicate, 0),
    subject: obligationSlot(trace.binaryLayout.subject, 0),
    value: obligationSlot(trace.binaryLayout.value, 1),
    arity: 2 as const
  };
  return QueryFactFrameOsfObligationSchema.parse({
    ...body,
    obligation_digest: digest(queryFactFrameOsfObligationPreimage(body))
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

function captureMatchesTrace(
  captured: RecallQueryFactFrameExtractionCapture["frames"][number],
  parsed: NonNullable<ReturnType<typeof traceRuleBasedQueryFactFrame>>["frame"]
): boolean {
  return captured.slots.length === parsed.slots.length &&
    captured.slots.every((slot, index) => {
      const expected = parsed.slots[index];
      return expected?.role === slot.role && expected.text === slot.text;
    });
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
