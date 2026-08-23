import { createHash } from "node:crypto";
import {
  QUERY_FACT_FRAME_OSF_FACET_RECEIPT_OPERATOR_ID,
  QUERY_OBLIGATION_FACET_CONSTRAINT_CLASS,
  QUERY_OBLIGATION_FACET_IDS,
  QueryFactFrameOsfFacetReceiptSchema,
  RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID,
  queryFactFrameOsfFacetReceiptPreimage,
  type QueryFactFrameOsfFacetReceipt,
  type QueryObligationFacet,
  type QueryObligationFacetId,
  type QueryObligationFacetReason,
  type QueryObligationFacetStatus
} from "@do-soul/alaya-protocol";
import { traceRuleBasedQueryFactFrame } from
  "../../../shared/query-fact-frame-extraction-rules.js";
import {
  extractAnswerOperatorSlot,
  extractTypeConstraintSlot,
  isTimeAnswerOperator,
  scanInterrogativeCues,
  type InterrogativeCueScan
} from "../../../shared/fact-frame-grammar/interrogative-cues.js";
import {
  verifyRecallQueryFactFrameExtractionCapture,
  type RecallQueryFactFrameCaptureFrame,
  type RecallQueryFactFrameExtractionCapture,
  type RecallQueryFactFrameSlotCapture
} from "../query-attribution/query-fact-frame-attribution-producer.js";
import { deriveQueryFactFrameOsfObligation } from "./query-obligation.js";

// Certified OSF stays fail-closed; this sibling records partial facet status.

type RuleBasedTrace = NonNullable<ReturnType<typeof traceRuleBasedQueryFactFrame>>;
type FacetSlot = Readonly<{ surface: string; source_span: readonly [number, number] }>;
type FallbackFill = Readonly<{
  readonly facet_id: QueryObligationFacetId;
  readonly surface: string;
  readonly source_span: readonly [number, number];
}>;

export function deriveQueryFactFrameOsfFacetReceipt(input: Readonly<{
  query_text: string;
  fact_frame_capture: Readonly<RecallQueryFactFrameExtractionCapture>;
}>): QueryFactFrameOsfFacetReceipt {
  verifyRecallQueryFactFrameExtractionCapture(input.fact_frame_capture);
  const certified = deriveQueryFactFrameOsfObligation(input);
  return sealFacetReceipt({
    query_digest: digest(input.query_text),
    fact_frame_producer_operator_id: input.fact_frame_capture.producer_operator_id,
    fact_frame_capture_digest: input.fact_frame_capture.capture_digest,
    certified_obligation_digest: certified?.obligation_digest ?? null,
    facets: deriveFacets(input.query_text, input.fact_frame_capture)
  });
}

export function applyQueryObligationFacetFallback(input: Readonly<{
  receipt: Readonly<QueryFactFrameOsfFacetReceipt>;
  producer_operator_id: string;
  fills: readonly FallbackFill[];
}>): QueryFactFrameOsfFacetReceipt {
  const receipt = QueryFactFrameOsfFacetReceiptSchema.parse(input.receipt);
  const impersonating =
    input.producer_operator_id === RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID;
  const filledIds = new Set(input.fills.map((fill) => fill.facet_id));
  const fills = new Map(input.fills.map((fill) => [fill.facet_id, fill]));
  const facets = QUERY_OBLIGATION_FACET_IDS.map((id) => {
    const current = receipt.facets.find((facet) => facet.facet_id === id)!;
    return applyFallbackFacet(
      current, fills.get(id), input.producer_operator_id, impersonating
    );
  });
  const filled = !impersonating &&
    receipt.facets.some((facet) =>
      facet.status === "unavailable" && filledIds.has(facet.facet_id));
  return sealFacetReceipt({
    query_digest: receipt.query_digest,
    fact_frame_producer_operator_id: receipt.fact_frame_producer_operator_id,
    fact_frame_capture_digest: receipt.fact_frame_capture_digest,
    certified_obligation_digest: filled ? null : receipt.certified_obligation_digest,
    facets
  });
}

function deriveFacets(
  query: string,
  capture: Readonly<RecallQueryFactFrameExtractionCapture>
): readonly QueryObligationFacet[] {
  const cues = scanInterrogativeCues(query);
  if (capture.status === "ineligible") {
    return allFacets("ineligible", "query_ineligible");
  }
  if (capture.status === "unavailable") {
    return allFacets("unavailable", "capture_unavailable");
  }
  if (capture.frames.length > 1) {
    return facetsFromMultipleFrames(cues);
  }
  if (capture.producer_operator_id !== RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID) {
    return facetsFromForeignCapture(query, capture, cues);
  }
  return facetsFromRuleBasedCapture(query, capture, cues);
}

function facetsFromRuleBasedCapture(
  query: string,
  capture: Readonly<RecallQueryFactFrameExtractionCapture>,
  cues: InterrogativeCueScan
): readonly QueryObligationFacet[] {
  const trace = traceRuleBasedQueryFactFrame(query);
  const frame = capture.frames[0];
  if (frame === undefined || trace === null) return facetsFromNoParse(cues);
  if (!captureMatchesTrace(frame, trace.frame)) {
    return facetsFromMismatch(cues);
  }
  if (trace.osfLayout !== null) {
    return facetsFromLayout(query, trace.osfLayout, cues);
  }
  return facetsFromParsedFrame(query, frame, cues, "missing_osf_layout");
}

function facetsFromForeignCapture(
  query: string,
  capture: Readonly<RecallQueryFactFrameExtractionCapture>,
  cues: InterrogativeCueScan
): readonly QueryObligationFacet[] {
  const frame = capture.frames[0];
  if (frame === undefined) return facetsFromNoParse(cues);
  return facetsFromParsedFrame(
    query, frame, cues, "no_parse", capture.producer_operator_id!
  );
}

function facetsFromLayout(
  query: string,
  layout: NonNullable<RuleBasedTrace["osfLayout"]>,
  cues: InterrogativeCueScan
): readonly QueryObligationFacet[] {
  const producer = RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID;
  const answer = operatorAndType(query, layout.value.source_span);
  return [
    formedFacet("predicate", layout.predicate, producer, "rule_based"),
    formedFacet("subject", layout.subject, producer, "rule_based"),
    answer.operator === "ambiguous"
      ? pendingFacet("answer_variable", "ambiguous", "ambiguous_wh")
      : formedFacet("answer_variable", layout.value, producer, "rule_based"),
    answer.type === null
      ? pendingFacet("type_constraint", "ineligible", "not_requested")
      : formedFacet("type_constraint", answer.type, producer, "rule_based"),
    timeFromAnswer(answer.operator, layout.value, cues, producer, "rule_based"),
    answerOperatorFacet(answer.operator, producer, "rule_based")
  ];
}

function facetsFromParsedFrame(
  query: string,
  frame: Readonly<RecallQueryFactFrameCaptureFrame>,
  cues: InterrogativeCueScan,
  missingReason: QueryObligationFacetReason,
  producer: string = RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID
): readonly QueryObligationFacet[] {
  const kind = producer === RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID
    ? "rule_based" as const
    : "model_fallback" as const;
  const predicate = uniqueRoleSlot(frame, "relation");
  const subject = uniqueRoleSlot(frame, "subject");
  const value = uniqueRoleSlot(frame, "value");
  const time = uniqueRoleSlot(frame, "time");
  const answer = value === null || value === "ambiguous"
    ? { operator: value, type: null }
    : operatorAndType(query, value.source_span);
  return [
    parsedSlotFacet("predicate", predicate, producer, kind, cues, missingReason),
    parsedSlotFacet("subject", subject, producer, kind, cues, missingReason),
    parsedAnswerVariable(value, answer.operator, producer, kind, cues, missingReason),
    answer.type === null
      ? cueFacet("type_constraint", cues.type_requested, missingReason)
      : formedFacet("type_constraint", answer.type, producer, kind),
    time === null
      ? timeFromAnswer(answer.operator, value === "ambiguous" ? null : value,
        cues, producer, kind, missingReason)
      : timeFacet(time, cues, producer, kind, missingReason),
    answerOperatorFacet(answer.operator, producer, kind, missingReason, cues)
  ];
}

function facetsFromNoParse(cues: InterrogativeCueScan): readonly QueryObligationFacet[] {
  if (!cues.interrogative) return allFacets("ineligible", "query_ineligible");
  return [
    pendingFacet("predicate", "unavailable", "no_parse"),
    pendingFacet("subject", "unavailable", "no_parse"),
    pendingFacet(
      "answer_variable",
      cues.ambiguous_wh ? "ambiguous" : "unavailable",
      cues.ambiguous_wh ? "ambiguous_wh" : "no_parse"
    ),
    cueFacet("type_constraint", cues.type_requested, "no_parse"),
    cueFacet("time", cues.time_requested, "no_parse"),
    pendingFacet(
      "answer_operator",
      cues.ambiguous_wh ? "ambiguous" : "unavailable",
      cues.ambiguous_wh ? "ambiguous_wh" : "no_parse"
    )
  ];
}

function facetsFromMultipleFrames(
  cues: InterrogativeCueScan
): readonly QueryObligationFacet[] {
  return [
    pendingFacet("predicate", "ambiguous", "multiple_frames"),
    pendingFacet("subject", "ambiguous", "multiple_frames"),
    pendingFacet("answer_variable", "ambiguous", "multiple_frames"),
    cueFacet("type_constraint", cues.type_requested, "multiple_frames"),
    cueFacet("time", cues.time_requested, "multiple_frames"),
    pendingFacet("answer_operator", "ambiguous", "multiple_frames")
  ];
}

function facetsFromMismatch(
  cues: InterrogativeCueScan
): readonly QueryObligationFacet[] {
  return [
    pendingFacet("predicate", "rejected", "capture_mismatch"),
    pendingFacet("subject", "rejected", "capture_mismatch"),
    pendingFacet("answer_variable", "rejected", "capture_mismatch"),
    cueFacet("type_constraint", cues.type_requested, "capture_mismatch"),
    cueFacet("time", cues.time_requested, "capture_mismatch"),
    pendingFacet("answer_operator", "rejected", "capture_mismatch")
  ];
}

function applyFallbackFacet(
  current: QueryObligationFacet,
  fill: FallbackFill | undefined,
  producer: string,
  impersonating: boolean
): QueryObligationFacet {
  if (fill === undefined || current.status !== "unavailable") return current;
  if (impersonating) {
    return pendingFacet(
      current.facet_id, "rejected", "model_fallback_rule_based_impersonation"
    );
  }
  return formedFacet(current.facet_id, fill, producer, "model_fallback");
}

function operatorAndType(query: string, valueSpan: readonly [number, number]) {
  return {
    operator: extractAnswerOperatorSlot(query, valueSpan),
    type: extractTypeConstraintSlot(query, valueSpan)
  };
}

function parsedSlotFacet(
  id: QueryObligationFacetId,
  slot: FacetSlot | "ambiguous" | null,
  producer: string,
  kind: "rule_based" | "model_fallback",
  cues: InterrogativeCueScan,
  missingReason: QueryObligationFacetReason
): QueryObligationFacet {
  if (slot === "ambiguous") return pendingFacet(id, "ambiguous", "ambiguous_wh");
  if (slot !== null) return formedFacet(id, slot, producer, kind);
  return pendingFacet(
    id,
    cues.interrogative ? "unavailable" : "ineligible",
    cues.interrogative ? missingReason : "query_ineligible"
  );
}

function parsedAnswerVariable(
  value: FacetSlot | "ambiguous" | null,
  operator: FacetSlot | "ambiguous" | null,
  producer: string,
  kind: "rule_based" | "model_fallback",
  cues: InterrogativeCueScan,
  missingReason: QueryObligationFacetReason
): QueryObligationFacet {
  if (value === "ambiguous" || operator === "ambiguous") {
    return pendingFacet("answer_variable", "ambiguous", "ambiguous_wh");
  }
  return parsedSlotFacet("answer_variable", value, producer, kind, cues, missingReason);
}

function timeFromAnswer(
  operator: FacetSlot | "ambiguous" | null,
  value: FacetSlot | null,
  cues: InterrogativeCueScan,
  producer: string,
  kind: "rule_based" | "model_fallback",
  missingReason: QueryObligationFacetReason = "not_requested"
): QueryObligationFacet {
  if (operator !== "ambiguous" && operator !== null &&
      isTimeAnswerOperator(operator.surface)) {
    return formedFacet("time", value ?? operator, producer, kind);
  }
  return timeFacet(null, cues, producer, kind, missingReason);
}

function timeFacet(
  slot: FacetSlot | "ambiguous" | null,
  cues: InterrogativeCueScan,
  producer: string,
  kind: "rule_based" | "model_fallback" = "rule_based",
  missingReason: QueryObligationFacetReason = "no_parse"
): QueryObligationFacet {
  if (slot === "ambiguous") return pendingFacet("time", "ambiguous", "ambiguous_wh");
  if (slot !== null) return formedFacet("time", slot, producer, kind);
  return cueFacet("time", cues.time_requested, missingReason);
}

function answerOperatorFacet(
  operator: FacetSlot | "ambiguous" | null,
  producer: string,
  kind: "rule_based" | "model_fallback",
  missingReason: QueryObligationFacetReason = "not_requested",
  cues?: InterrogativeCueScan
): QueryObligationFacet {
  if (operator === "ambiguous") {
    return pendingFacet("answer_operator", "ambiguous", "ambiguous_wh");
  }
  if (operator !== null) return formedFacet("answer_operator", operator, producer, kind);
  if (cues === undefined) return pendingFacet("answer_operator", "ineligible", "not_requested");
  return pendingFacet(
    "answer_operator",
    cues.interrogative ? "unavailable" : "ineligible",
    cues.interrogative ? missingReason : "query_ineligible"
  );
}

function cueFacet(
  id: QueryObligationFacetId,
  requested: boolean,
  requestedReason: QueryObligationFacetReason
): QueryObligationFacet {
  return pendingFacet(
    id,
    requested ? "unavailable" : "ineligible",
    requested ? requestedReason : "not_requested"
  );
}

function formedFacet(
  id: QueryObligationFacetId,
  slot: FacetSlot,
  producer: string,
  kind: "rule_based" | "model_fallback"
): QueryObligationFacet {
  return Object.freeze({
    facet_id: id,
    status: "formed",
    constraint_class: QUERY_OBLIGATION_FACET_CONSTRAINT_CLASS[id],
    producer_kind: kind,
    producer_operator_id: producer,
    surface: slot.surface,
    source_span: [slot.source_span[0], slot.source_span[1]] as [number, number],
    reason: null
  });
}

function pendingFacet(
  id: QueryObligationFacetId,
  status: Exclude<QueryObligationFacetStatus, "formed">,
  reason: QueryObligationFacetReason
): QueryObligationFacet {
  return Object.freeze({
    facet_id: id,
    status,
    constraint_class: QUERY_OBLIGATION_FACET_CONSTRAINT_CLASS[id],
    producer_kind: "absent",
    producer_operator_id: null,
    surface: null,
    source_span: null,
    reason
  });
}

function allFacets(
  status: Exclude<QueryObligationFacetStatus, "formed" | "ambiguous">,
  reason: QueryObligationFacetReason
): readonly QueryObligationFacet[] {
  return QUERY_OBLIGATION_FACET_IDS.map((id) => pendingFacet(id, status, reason));
}

function uniqueRoleSlot(
  frame: Readonly<RecallQueryFactFrameCaptureFrame>,
  role: RecallQueryFactFrameSlotCapture["role"]
): FacetSlot | "ambiguous" | null {
  const slots = frame.slots.filter((slot) => slot.role === role);
  if (slots.length === 0) return null;
  if (slots.length > 1) return "ambiguous";
  const slot = slots[0]!;
  return Object.freeze({
    surface: slot.text,
    source_span: slot.source_offset
  });
}

function captureMatchesTrace(
  captured: RecallQueryFactFrameCaptureFrame,
  parsed: RuleBasedTrace["frame"]
): boolean {
  return captured.slots.length === parsed.slots.length &&
    captured.slots.every((slot, index) => {
      const expected = parsed.slots[index];
      return expected?.role === slot.role && expected.text === slot.text;
    });
}

function sealFacetReceipt(body: Omit<QueryFactFrameOsfFacetReceipt, "schema_version" |
  "operator_id" | "receipt_digest">): QueryFactFrameOsfFacetReceipt {
  const unsigned = {
    schema_version: 1 as const,
    operator_id: QUERY_FACT_FRAME_OSF_FACET_RECEIPT_OPERATOR_ID,
    ...body
  };
  return QueryFactFrameOsfFacetReceiptSchema.parse({
    ...unsigned,
    receipt_digest: digest(queryFactFrameOsfFacetReceiptPreimage(unsigned))
  });
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
