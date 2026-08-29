import {
  QUERY_FACT_FRAME_EXTRACTION_CAPTURE_OPERATOR_ID,
  type RecallQueryFactFrameCaptureFrame,
  type RecallQueryFactFrameExtractionCapture
} from "../../../field/query-attribution/query-fact-frame-attribution-producer.js";
import {
  cleanFactFrameDemandFactor,
  projectFactFrameSemanticFactors,
  semanticDemandKindForRole,
  type FactFrameSemanticFactor
} from "../../../field/fact-frame-semantic-factors.js";
import type {
  CanonicalAnswerProgramV1,
  CanonicalConstantV1,
  CanonicalPredicateV1
} from "../types.js";
import {
  captureDigest,
  naryPredicate,
  pushSupportedQuery,
  pushUnresolved,
  type AdapterSink
} from "./phi.js";

const PRODUCER = QUERY_FACT_FRAME_EXTRACTION_CAPTURE_OPERATOR_ID;

export function adaptFactFrameCapture(
  capture: unknown,
  answer: CanonicalAnswerProgramV1 | null,
  sink: AdapterSink
): void {
  if (capture === undefined || capture === null) return;
  if (!isFactFrameCapture(capture)) {
    pushUnadapted(capture, sink);
    return;
  }
  if (capture.status !== "returned" || capture.frames.length === 0) {
    pushUnadapted(capture, sink);
    return;
  }
  if (capture.frames.length > 1) {
    // v1 has no join lattice, so source order cannot pick one frame.
    pushUnresolved(sink.unresolved, {
      code: "unknown_correlation",
      source: "fact_frame",
      capture_digest: captureDigest(capture)
    });
  }
  if (answer === null) return;
  const adapted = adaptReturnedFrames(capture, answer, sink);
  if (!adapted) pushUnadapted(capture, sink);
}

function adaptReturnedFrames(
  capture: RecallQueryFactFrameExtractionCapture,
  answer: CanonicalAnswerProgramV1,
  sink: AdapterSink
): boolean {
  let adapted = false;
  capture.frames.forEach((frame, frameIndex) => {
    if (adaptFrame(frame, frameIndex, capture, answer, sink)) adapted = true;
  });
  return adapted;
}

function adaptFrame(
  frame: Readonly<RecallQueryFactFrameCaptureFrame>,
  frameIndex: number,
  capture: RecallQueryFactFrameExtractionCapture,
  answer: CanonicalAnswerProgramV1,
  sink: AdapterSink
): boolean {
  const factors = cleanedFactors(frame, frameIndex);
  pushTimeHoles(frame, sink);
  const program = frameProgram(factors, frameIndex, producerOf(capture));
  if (program === null) return false;
  return pushSupportedQuery(
    program.predicates,
    answer,
    { source_id: `fact_frame.${frameIndex}`, producer: producerOf(capture) },
    sink,
    "fact_frame",
    { constants: program.constants }
  );
}

function cleanedFactors(
  frame: Readonly<RecallQueryFactFrameCaptureFrame>,
  frameIndex: number
): readonly FactFrameSemanticFactor[] {
  return projectFactFrameSemanticFactors(frame.slots, frameIndex).flatMap((factor) => {
    const cleaned = cleanFactFrameDemandFactor(factor);
    return cleaned === null ? [] : [cleaned];
  });
}

function frameProgram(
  factors: readonly FactFrameSemanticFactor[],
  frameIndex: number,
  producer: string
): {
  readonly predicates: readonly CanonicalPredicateV1[];
  readonly constants: readonly CanonicalConstantV1[];
} | null {
  const relation = factors.find((factor) => semanticDemandKindForRole(factor.role) === "relation");
  if (relation === undefined || relation.normalized_text.length === 0) return null;
  const constants = constantsFromEntities(factors);
  const arguments_ = [...constants.map((constant) => constant.name), "x0"];
  return {
    constants,
    predicates: [naryPredicate(
      `ff${frameIndex}`,
      relation.normalized_text,
      arguments_,
      {
        source_id: `fact_frame.relation.${frameIndex}.${relation.slot_index}`,
        producer
      }
    )]
  };
}

function constantsFromEntities(
  factors: readonly FactFrameSemanticFactor[]
): CanonicalConstantV1[] {
  const seen = new Set<string>();
  const constants: CanonicalConstantV1[] = [];
  for (const factor of factors) {
    if (semanticDemandKindForRole(factor.role) !== "entity") continue;
    if (factor.normalized_text.length === 0 || seen.has(factor.normalized_text)) continue;
    seen.add(factor.normalized_text);
    constants.push(Object.freeze({
      name: factor.normalized_text,
      sort: "entity" as const,
      value: factor.normalized_text
    }));
  }
  return constants;
}

function pushTimeHoles(
  frame: Readonly<RecallQueryFactFrameCaptureFrame>,
  sink: AdapterSink
): void {
  // Time slots without a typed time variable never compile to recency-to-now.
  if (!frame.slots.some((slot) => slot.role === "time")) return;
  pushUnresolved(sink.unresolved, { code: "unknown_time_basis", source: "fact_frame" });
  pushUnresolved(sink.unresolved, {
    code: "latest_without_typed_time_key",
    source: "fact_frame"
  });
}

function pushUnadapted(capture: object, sink: AdapterSink): void {
  pushUnresolved(sink.unresolved, {
    code: "unadapted_fact_frame",
    source: "fact_frame",
    capture_digest: captureDigest(capture),
    detail: (capture as { readonly status?: string }).status
  });
}

function producerOf(capture: RecallQueryFactFrameExtractionCapture): string {
  return capture.operator_id.length > 0 ? capture.operator_id : PRODUCER;
}

function isFactFrameCapture(value: object): value is RecallQueryFactFrameExtractionCapture {
  return "schema_version" in value
    && "frames" in value
    && Array.isArray((value as { readonly frames?: unknown }).frames)
    && "operator_id" in value
    && "status" in value
    && "capture_digest" in value;
}
