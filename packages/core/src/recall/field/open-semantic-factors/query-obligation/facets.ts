import {
  MODEL_QUERY_OBLIGATION_FACET_FALLBACK_OPERATOR_ID,
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
  "../../../../shared/query-fact-frame-extraction-rules.js";
import {
  extractAnswerOperatorSlot,
  extractTypeConstraintSlot,
  isTimeAnswerOperator,
  scanInterrogativeCues,
  type InterrogativeCueScan
} from "../../../../shared/fact-frame-grammar/interrogative-cues.js";
import {
  verifyRecallQueryFactFrameExtractionCapture,
  type RecallQueryFactFrameCaptureFrame,
  type RecallQueryFactFrameExtractionCapture,
  type RecallQueryFactFrameSlotCapture
} from "../../query-attribution/query-fact-frame-attribution-producer.js";
import { captureMatchesTrace, digestQueryFactFrame } from "./identity.js";

// Certified OSF stays fail-closed; this sibling records partial facet status.

type RuleBasedTrace = NonNullable<ReturnType<typeof traceRuleBasedQueryFactFrame>>;
type FacetSlot = Readonly<{ surface: string; source_span: readonly [number, number] }>;
type FallbackFill = Readonly<{
  readonly facet_id: QueryObligationFacetId;
  readonly surface: string;
  readonly source_span: readonly [number, number];
}>;
type PendingStatus = Exclude<QueryObligationFacetStatus, "formed">;
type FacetProducerKind = "rule_based" | "model_fallback";

export function deriveQueryFactFrameOsfFacetReceipt(input: Readonly<{
  query_text: string;
  fact_frame_capture: Readonly<RecallQueryFactFrameExtractionCapture>;
}>): QueryFactFrameOsfFacetReceipt {
  verifyRecallQueryFactFrameExtractionCapture(input.fact_frame_capture);
  return sealFacetReceipt({
    query_digest: digestQueryFactFrame(input.query_text),
    fact_frame_producer_operator_id: input.fact_frame_capture.producer_operator_id,
    fact_frame_capture_digest: input.fact_frame_capture.capture_digest,
    facets: deriveFacets(input.query_text, input.fact_frame_capture)
  });
}

export function verifyQueryFactFrameOsfFacetReceipt(
  receipt: Readonly<QueryFactFrameOsfFacetReceipt>
): QueryFactFrameOsfFacetReceipt {
  const parsed = QueryFactFrameOsfFacetReceiptSchema.parse(receipt);
  const { receipt_digest, ...body } = parsed;
  if (receipt_digest !== digestQueryFactFrame(
    queryFactFrameOsfFacetReceiptPreimage(body)
  )) {
    throw new Error("query fact-frame OSF facet receipt digest mismatch");
  }
  return parsed;
}

export function applyQueryObligationFacetFallback(input: Readonly<{
  receipt: Readonly<QueryFactFrameOsfFacetReceipt>;
  query_text: string;
  producer_operator_id: string;
  fills: readonly FallbackFill[];
}>): QueryFactFrameOsfFacetReceipt {
  const receipt = verifyQueryFactFrameOsfFacetReceipt(input.receipt);
  const rejection = fallbackRejection(input.producer_operator_id);
  const fills = new Map(input.fills.map((fill) => [fill.facet_id, fill]));
  return sealFacetReceipt({
    query_digest: receipt.query_digest,
    fact_frame_producer_operator_id: receipt.fact_frame_producer_operator_id,
    fact_frame_capture_digest: receipt.fact_frame_capture_digest,
    facets: QUERY_OBLIGATION_FACET_IDS.map((id) => applyFallbackFacet(
      receipt.facets.find((facet) => facet.facet_id === id)!,
      fills.get(id),
      input.query_text,
      rejection
    ))
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
    return pendingHardCensus(
      { status: "ambiguous", reason: "multiple_frames" }, cues, "multiple_frames"
    );
  }
  if (capture.producer_operator_id !== RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID) {
    return facetsFromNoParse(cues);
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
    return pendingHardCensus(
      { status: "rejected", reason: "capture_mismatch" }, cues, "capture_mismatch"
    );
  }
  if (trace.osfLayout !== null) return facetsFromLayout(query, trace.osfLayout, cues);
  return facetsFromParsedFrame(query, frame, cues, "missing_osf_layout");
}

function facetsFromNoParse(cues: InterrogativeCueScan): readonly QueryObligationFacet[] {
  if (!cues.interrogative) return allFacets("ineligible", "query_ineligible");
  return pendingHardCensus(
    { status: "unavailable", reason: "no_parse" },
    cues,
    "no_parse",
    cues.ambiguous_wh ? { status: "ambiguous", reason: "ambiguous_wh" } : undefined
  );
}

function facetsFromLayout(
  query: string,
  layout: NonNullable<RuleBasedTrace["osfLayout"]>,
  cues: InterrogativeCueScan
): readonly QueryObligationFacet[] {
  const producer = RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID;
  const answer = operatorAndType(query, layout.value.source_span);
  return facetCensus({
    predicate: formedFacet("predicate", layout.predicate, producer, "rule_based"),
    subject: formedFacet("subject", layout.subject, producer, "rule_based"),
    answer_variable: answer.operator === "ambiguous"
      ? pendingFacet("answer_variable", "ambiguous", "ambiguous_wh")
      : formedFacet("answer_variable", layout.value, producer, "rule_based"),
    type_constraint: answer.type === null
      ? pendingForRequest("type_constraint", false, "not_requested")
      : formedFacet("type_constraint", answer.type, producer, "rule_based"),
    time: timeFromAnswer(
      answer.operator, layout.value, cues, producer, "rule_based", "not_requested"
    ),
    answer_operator: answerOperatorFacet(
      answer.operator, producer, "rule_based", false, "not_requested"
    )
  });
}

function facetsFromParsedFrame(
  query: string,
  frame: Readonly<RecallQueryFactFrameCaptureFrame>,
  cues: InterrogativeCueScan,
  missingReason: QueryObligationFacetReason
): readonly QueryObligationFacet[] {
  const producer = RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID;
  const kind = "rule_based" as const;
  const predicate = uniqueRoleSlot(frame, "relation");
  const subject = uniqueRoleSlot(frame, "subject");
  const value = uniqueRoleSlot(frame, "value");
  const time = uniqueRoleSlot(frame, "time");
  const answer = value === null || value === "ambiguous"
    ? { operator: value, type: null as FacetSlot | null }
    : operatorAndType(query, value.source_span);
  return facetCensus({
    predicate: parsedSlotFacet("predicate", predicate, producer, kind, cues, missingReason),
    subject: parsedSlotFacet("subject", subject, producer, kind, cues, missingReason),
    answer_variable: parsedAnswerVariable(
      value, answer.operator, producer, kind, cues, missingReason
    ),
    type_constraint: answer.type === null
      ? pendingForRequest("type_constraint", cues.type_requested, missingReason)
      : formedFacet("type_constraint", answer.type, producer, kind),
    time: parsedTimeFacet(
      time, answer.operator, value === "ambiguous" ? null : value,
      cues, producer, kind, missingReason
    ),
    answer_operator: answerOperatorFacet(
      answer.operator, producer, kind, cues.interrogative, missingReason
    )
  });
}

function applyFallbackFacet(
  current: QueryObligationFacet,
  fill: FallbackFill | undefined,
  query: string,
  rejection: QueryObligationFacetReason | null
): QueryObligationFacet {
  if (fill === undefined || current.status !== "unavailable") return current;
  if (rejection !== null) {
    return pendingFacet(current.facet_id, "rejected", rejection);
  }
  if (!fillIsSourceExact(query, fill)) {
    return pendingFacet(current.facet_id, "rejected", "ungrounded_fill");
  }
  return formedFacet(
    current.facet_id, fill,
    MODEL_QUERY_OBLIGATION_FACET_FALLBACK_OPERATOR_ID, "model_fallback"
  );
}

function fallbackRejection(producer: string): QueryObligationFacetReason | null {
  if (producer === MODEL_QUERY_OBLIGATION_FACET_FALLBACK_OPERATOR_ID) return null;
  return producer === RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID
    ? "model_fallback_rule_based_impersonation"
    : "model_fallback_certified_producer";
}

function fillIsSourceExact(query: string, fill: FallbackFill): boolean {
  const [start, end] = fill.source_span;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) &&
    start >= 0 && end <= query.length && end > start &&
    query.slice(start, end) === fill.surface;
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
  kind: FacetProducerKind,
  cues: InterrogativeCueScan,
  missingReason: QueryObligationFacetReason
): QueryObligationFacet {
  if (slot === "ambiguous") return pendingFacet(id, "ambiguous", "ambiguous_role");
  if (slot !== null) return formedFacet(id, slot, producer, kind);
  return pendingForRequest(id, cues.interrogative, missingReason, "query_ineligible");
}

function parsedAnswerVariable(
  value: FacetSlot | "ambiguous" | null,
  operator: FacetSlot | "ambiguous" | null,
  producer: string,
  kind: FacetProducerKind,
  cues: InterrogativeCueScan,
  missingReason: QueryObligationFacetReason
): QueryObligationFacet {
  if (value === "ambiguous") {
    return pendingFacet("answer_variable", "ambiguous", "ambiguous_role");
  }
  if (operator === "ambiguous") {
    return pendingFacet("answer_variable", "ambiguous", "ambiguous_wh");
  }
  return parsedSlotFacet("answer_variable", value, producer, kind, cues, missingReason);
}

function parsedTimeFacet(
  slot: FacetSlot | "ambiguous" | null,
  operator: FacetSlot | "ambiguous" | null,
  value: FacetSlot | null,
  cues: InterrogativeCueScan,
  producer: string,
  kind: FacetProducerKind,
  missingReason: QueryObligationFacetReason
): QueryObligationFacet {
  if (slot === "ambiguous") return pendingFacet("time", "ambiguous", "ambiguous_role");
  if (slot !== null) return formedFacet("time", slot, producer, kind);
  return timeFromAnswer(operator, value, cues, producer, kind, missingReason);
}

function timeFromAnswer(
  operator: FacetSlot | "ambiguous" | null,
  value: FacetSlot | null,
  cues: InterrogativeCueScan,
  producer: string,
  kind: FacetProducerKind,
  missingReason: QueryObligationFacetReason
): QueryObligationFacet {
  if (operator !== "ambiguous" && operator !== null &&
      isTimeAnswerOperator(operator.surface)) {
    return formedFacet("time", value ?? operator, producer, kind);
  }
  return pendingForRequest("time", cues.time_requested, missingReason);
}

function answerOperatorFacet(
  operator: FacetSlot | "ambiguous" | null,
  producer: string,
  kind: FacetProducerKind,
  requested: boolean,
  missingReason: QueryObligationFacetReason
): QueryObligationFacet {
  if (operator === "ambiguous") {
    return pendingFacet("answer_operator", "ambiguous", "ambiguous_wh");
  }
  if (operator !== null) return formedFacet("answer_operator", operator, producer, kind);
  return pendingForRequest(
    "answer_operator", requested, missingReason, "query_ineligible"
  );
}

function pendingHardCensus(
  hard: Readonly<{ status: PendingStatus; reason: QueryObligationFacetReason }>,
  cues: InterrogativeCueScan,
  cueReason: QueryObligationFacetReason,
  answer?: Readonly<{ status: PendingStatus; reason: QueryObligationFacetReason }>
): readonly QueryObligationFacet[] {
  const answerState = answer ?? hard;
  return facetCensus({
    predicate: pendingFacet("predicate", hard.status, hard.reason),
    subject: pendingFacet("subject", hard.status, hard.reason),
    answer_variable: pendingFacet(
      "answer_variable", answerState.status, answerState.reason
    ),
    type_constraint: pendingForRequest(
      "type_constraint", cues.type_requested, cueReason
    ),
    time: pendingForRequest("time", cues.time_requested, cueReason),
    answer_operator: pendingFacet(
      "answer_operator", answerState.status, answerState.reason
    )
  });
}

function facetCensus(slots: Readonly<Record<
  QueryObligationFacetId, QueryObligationFacet
>>): readonly QueryObligationFacet[] {
  return QUERY_OBLIGATION_FACET_IDS.map((id) => slots[id]);
}

function pendingForRequest(
  id: QueryObligationFacetId,
  requested: boolean,
  requestedReason: QueryObligationFacetReason,
  unrequestedReason: QueryObligationFacetReason = "not_requested"
): QueryObligationFacet {
  return requested
    ? pendingFacet(id, "unavailable", requestedReason)
    : pendingFacet(id, "ineligible", unrequestedReason);
}

function formedFacet(
  id: QueryObligationFacetId,
  slot: FacetSlot,
  producer: string,
  kind: FacetProducerKind
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
  status: PendingStatus,
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
  status: Exclude<PendingStatus, "ambiguous">,
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

function sealFacetReceipt(body: Omit<QueryFactFrameOsfFacetReceipt, "schema_version" |
  "operator_id" | "receipt_digest">): QueryFactFrameOsfFacetReceipt {
  const unsigned = {
    schema_version: 1 as const,
    operator_id: QUERY_FACT_FRAME_OSF_FACET_RECEIPT_OPERATOR_ID,
    ...body
  };
  return QueryFactFrameOsfFacetReceiptSchema.parse({
    ...unsigned,
    receipt_digest: digestQueryFactFrame(queryFactFrameOsfFacetReceiptPreimage(unsigned))
  });
}
