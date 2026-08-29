import {
  OPEN_SEMANTIC_FACTOR_FORMATION_OPERATOR_ID,
  type OpenSemanticFactorFormationCapture,
  type OpenSemanticFactorGraph,
  type OpenSemanticProposition
} from "@do-soul/alaya-protocol";
import type {
  CanonicalAnswerProgramV1,
  CanonicalConstantV1,
  CanonicalVariableV1
} from "../types.js";
import {
  captureDigest,
  naryPredicate,
  pushSupportedQuery,
  pushUnresolved,
  type AdapterSink
} from "./phi.js";

export function adaptOsfCapture(
  capture: unknown,
  answer: CanonicalAnswerProgramV1 | null,
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
  if (capture.graph.propositions.length > 1) {
    // Flattening a 2+ proposition graph would invent a v1 correlation partition.
    pushUnresolved(sink.unresolved, {
      code: "unknown_correlation",
      source: "osf",
      capture_digest: captureDigest(capture)
    });
  }
  if (answer === null) return;
  const adapted = adaptGraph(capture, capture.graph, answer, sink);
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
  const bound = bindPropositionArguments(proposition, graph);
  if (bound === null) return false;
  return pushSupportedQuery(
    [naryPredicate(
      `osf_${proposition.proposition_id}`,
      factor.semantic_identity,
      bound.arguments,
      {
        source_id: `osf.relation.${proposition.proposition_id}`,
        producer
      }
    )],
    answer,
    { source_id: `osf.${proposition.proposition_id}`, producer },
    sink,
    "osf",
    { variables: bound.variables, constants: bound.constants }
  );
}

function bindPropositionArguments(
  proposition: OpenSemanticProposition,
  graph: OpenSemanticFactorGraph
): {
  readonly arguments: readonly string[];
  readonly variables: readonly CanonicalVariableV1[];
  readonly constants: readonly CanonicalConstantV1[];
} | null {
  const ordered = [...proposition.arguments].sort((left, right) => left.position - right.position);
  const arguments_: string[] = [];
  const constants: CanonicalConstantV1[] = [];
  const variables: CanonicalVariableV1[] = [{ name: "x0", sort: "entity" }];
  const constantNames = new Set<string>();
  const variableNames = new Set<string>(["x0"]);
  for (const argument of ordered) {
    if (argument.reference_kind === "factor") {
      const referenced = graph.factors.find((item) => item.factor_id === argument.reference_id);
      if (referenced === undefined || referenced.semantic_identity.length === 0) return null;
      const name = referenced.semantic_identity;
      if (!constantNames.has(name)) {
        constantNames.add(name);
        constants.push(Object.freeze({ name, sort: "entity" as const, value: name }));
      }
      arguments_.push(name);
      continue;
    }
    if (graph.result_variable_ids.includes(argument.reference_id)) {
      arguments_.push("x0");
      continue;
    }
    if (!variableNames.has(argument.reference_id)) {
      variableNames.add(argument.reference_id);
      variables.push({ name: argument.reference_id, sort: "entity" });
    }
    arguments_.push(argument.reference_id);
  }
  return { arguments: arguments_, variables, constants };
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
