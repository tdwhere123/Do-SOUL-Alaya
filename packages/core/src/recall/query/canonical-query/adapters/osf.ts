import {
  OPEN_SEMANTIC_FACTOR_FORMATION_OPERATOR_ID,
  type OpenSemanticFactorFormationCapture,
  type OpenSemanticFactorGraph,
  type OpenSemanticProposition
} from "@do-soul/alaya-protocol";
import type { CanonicalAnswerProgramV1 } from "../types.js";
import {
  captureDigest,
  pushSupportedQuery,
  pushUnresolved,
  unaryPredicate,
  type AdapterSink
} from "./phi.js";

export function adaptOsfCapture(
  capture: unknown,
  answer: CanonicalAnswerProgramV1,
  sink: AdapterSink
): void {
  if (capture === undefined || capture === null) return;
  if (!isOsfCapture(capture)) {
    pushUnadapted(capture, sink);
    return;
  }
  if (capture.status !== "formed" || capture.graph === null) {
    pushUnadapted(capture, sink);
    return;
  }
  const adapted = adaptGraph(capture, capture.graph, answer, sink);
  if (capture.graph.propositions.length > 1) {
    // Flattening a 2+ proposition graph would invent a v1 correlation partition.
    pushUnresolved(sink.unresolved, {
      code: "unknown_correlation",
      source: "osf",
      capture_digest: captureDigest(capture)
    });
  }
  if (!adapted) pushUnadapted(capture, sink);
}

function adaptGraph(
  capture: OpenSemanticFactorFormationCapture,
  graph: OpenSemanticFactorGraph,
  answer: CanonicalAnswerProgramV1,
  sink: AdapterSink
): boolean {
  const producer = capture.producer_operator_id
    ?? capture.operator_id
    ?? OPEN_SEMANTIC_FACTOR_FORMATION_OPERATOR_ID;
  let adapted = false;
  for (const proposition of graph.propositions) {
    if (adaptProposition(proposition, graph, producer, answer, sink)) adapted = true;
  }
  return adapted;
}

function adaptProposition(
  proposition: OpenSemanticProposition,
  graph: OpenSemanticFactorGraph,
  producer: string,
  answer: CanonicalAnswerProgramV1,
  sink: AdapterSink
): boolean {
  const factor = graph.factors.find((item) =>
    item.factor_id === proposition.predicate_factor_id
  );
  if (factor === undefined || factor.semantic_identity.length === 0) return false;
  return pushSupportedQuery(
    [unaryPredicate(
      `osf_${proposition.proposition_id}`,
      factor.semantic_identity,
      {
        source_id: `osf.relation.${proposition.proposition_id}`,
        producer
      }
    )],
    answer,
    { source_id: `osf.${proposition.proposition_id}`, producer },
    sink,
    "osf"
  );
}

function pushUnadapted(capture: object, sink: AdapterSink): void {
  pushUnresolved(sink.unresolved, {
    code: "unadapted_osf",
    source: "osf",
    capture_digest: captureDigest(capture),
    detail: (capture as { readonly status?: string }).status
  });
}

function isOsfCapture(value: object): value is OpenSemanticFactorFormationCapture {
  return "schema_version" in value
    && "graph" in value
    && "operator_id" in value
    && "status" in value
    && "capture_digest" in value;
}
