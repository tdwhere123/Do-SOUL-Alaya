import {
  QUERY_FACT_FRAME_EXTRACTION_CAPTURE_OPERATOR_ID,
  verifyRecallQueryFactFrameExtractionCapture,
  type RecallQueryFactFrameCaptureFrame,
  type RecallQueryFactFrameExtractionCapture
} from "../../../field/query-attribution/query-fact-frame-attribution-producer.js";
import {
  cleanFactFrameDemandFactor,
  projectFactFrameSemanticFactors,
  semanticDemandKindForRole,
  type FactFrameSemanticFactor
} from "../../../field/fact-frame-semantic-factors.js";
import { digestRecallFieldIdentity } from "../../../field/field-identity.js";
import type { RecallQueryProbes } from "../../recall-query-probes.js";
import type {
  CanonicalAnswerProgramV1,
  CanonicalConstantV1,
  CanonicalPredicateV1
} from "../types.js";
import {
  captureDigest,
  entityConstantsFrom,
  naryPredicate,
  pushSupportedQuery,
  pushUnresolved,
  type AdapterSink
} from "./phi.js";

const PRODUCER = QUERY_FACT_FRAME_EXTRACTION_CAPTURE_OPERATOR_ID;

export function adaptFactFrameCapture(
  capture: unknown,
  answer: CanonicalAnswerProgramV1 | null,
  sink: AdapterSink,
  probes: Readonly<RecallQueryProbes>
): void {
  if (capture === undefined || capture === null) return;
  const verified = verifiedFactFrameCapture(capture);
  if (verified === null) {
    pushUnadapted(capture as object, sink);
    return;
  }
  if (verified.query_text_digest !== digestRecallFieldIdentity({
    query_text: probes.normalized_query
  })) {
    pushUnadapted(verified, sink);
    return;
  }
  if (verified.status !== "returned" || verified.frames.length === 0) {
    pushUnadapted(verified, sink);
    return;
  }
  if (verified.frames.length > 1) {
    // v1 has no join lattice, so source order cannot pick one frame.
    pushUnresolved(sink.unresolved, {
      code: "unknown_correlation",
      source: "fact_frame",
      capture_digest: captureDigest(verified)
    });
  }
  if (answer === null) return;
  const adapted = adaptReturnedFrames(verified, answer, sink);
  if (!adapted) pushUnadapted(verified, sink);
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
  const relations = factors.filter((factor) =>
    semanticDemandKindForRole(factor.role) === "relation" && factor.normalized_text.length > 0
  );
  if (relations.length !== 1) return null;
  const relation = relations[0]!;
  const constants = entityConstantsFrom(factors.flatMap((factor) =>
    semanticDemandKindForRole(factor.role) === "entity" ? [factor.normalized_text] : []
  ));
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

function verifiedFactFrameCapture(
  value: unknown
): RecallQueryFactFrameExtractionCapture | null {
  try {
    verifyRecallQueryFactFrameExtractionCapture(
      value as RecallQueryFactFrameExtractionCapture
    );
    return value as RecallQueryFactFrameExtractionCapture;
  } catch {
    return null;
  }
}
