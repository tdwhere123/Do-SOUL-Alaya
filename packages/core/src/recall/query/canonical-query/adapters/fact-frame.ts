import {
  QUERY_FACT_FRAME_EXTRACTION_CAPTURE_OPERATOR_ID,
  verifyRecallQueryFactFrameExtractionCapture,
  type RecallQueryFactFrameCaptureFrame,
  type RecallQueryFactFrameExtractionCapture
} from "../../../field/query-attribution/query-fact-frame-attribution-producer.js";
import {
  cleanFactFrameDemandFactor,
  isFactFrameAnswerFactor,
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
  const factors = projectFactFrameSemanticFactors(frame.slots, frameIndex);
  pushTimeHoles(frame, sink);
  const program = frameProgram(factors, frameIndex, producerOf(capture));
  if (program.status === "unbound_answer") {
    pushUnresolved(sink.unresolved, {
      code: "unknown_answer_variable",
      source: "fact_frame",
      detail: String(frameIndex)
    });
    return false;
  }
  if (program.status === "unsupported_relation") return false;
  return pushSupportedQuery(
    program.predicates,
    answer,
    { source_id: `fact_frame.${frameIndex}`, producer: producerOf(capture) },
    sink,
    "fact_frame",
    { constants: program.constants }
  );
}

function frameProgram(
  factors: readonly FactFrameSemanticFactor[],
  frameIndex: number,
  producer: string
): FrameProgramResult {
  const relations = cleanedRelationFactors(factors);
  if (relations.length !== 1) return { status: "unsupported_relation" };
  const bindings = bindFrameArguments(factors);
  if (bindings === null) return { status: "unbound_answer" };
  const relation = relations[0]!;
  return {
    status: "supported",
    constants: bindings.constants,
    predicates: [naryPredicate(
      `ff${frameIndex}`,
      relation.normalized_text,
      bindings.arguments,
      {
        source_id: `fact_frame.relation.${frameIndex}.${relation.slot_index}`,
        producer
      }
    )]
  };
}

type FrameProgramResult =
  | Readonly<{ readonly status: "unsupported_relation" }>
  | Readonly<{ readonly status: "unbound_answer" }>
  | Readonly<{
      readonly status: "supported";
      readonly predicates: readonly CanonicalPredicateV1[];
      readonly constants: readonly CanonicalConstantV1[];
    }>;

function cleanedRelationFactors(
  factors: readonly FactFrameSemanticFactor[]
): readonly FactFrameSemanticFactor[] {
  return factors.flatMap((factor) => {
    if (semanticDemandKindForRole(factor.role) !== "relation") return [];
    const cleaned = cleanFactFrameDemandFactor(factor);
    return cleaned === null ? [] : [cleaned];
  });
}

function bindFrameArguments(
  factors: readonly FactFrameSemanticFactor[]
): Readonly<{
  readonly arguments: readonly string[];
  readonly constants: readonly CanonicalConstantV1[];
}> | null {
  const answers = factors.filter(isFactFrameAnswerFactor);
  if (answers.length !== 1) return null;
  const answer = answers[0]!;
  const rows = factors.flatMap((factor) => frameArgument(factor, answer));
  rows.sort((left, right) => left.role_order - right.role_order ||
    left.slot_index - right.slot_index);
  const arguments_ = rows.map((row) => row.argument);
  const constants = entityConstantsFrom(arguments_.filter((argument) => argument !== "x0"));
  return {
    arguments: Object.freeze(arguments_),
    constants
  };
}

function frameArgument(
  factor: Readonly<FactFrameSemanticFactor>,
  answer: Readonly<FactFrameSemanticFactor>
): readonly Readonly<{ readonly argument: string; readonly role_order: number;
  readonly slot_index: number }>[] {
  if (factor.slot_index === answer.slot_index) {
    return [{ argument: "x0", role_order: roleOrder(answer), slot_index: factor.slot_index }];
  }
  const cleaned = cleanFactFrameDemandFactor(factor);
  if (cleaned === null || semanticDemandKindForRole(cleaned.role) !== "entity") return [];
  return [{
    argument: cleaned.normalized_text,
    role_order: roleOrder(cleaned),
    slot_index: cleaned.slot_index
  }];
}

function roleOrder(factor: Readonly<FactFrameSemanticFactor>): number {
  if (factor.role === "subject") return 0;
  if (factor.role === "value") return 1;
  return 2;
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
