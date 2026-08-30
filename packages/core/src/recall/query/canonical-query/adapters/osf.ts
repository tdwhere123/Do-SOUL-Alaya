import {
  OPEN_SEMANTIC_FACTOR_FORMATION_OPERATOR_ID,
  verifyOpenSemanticFactorFormationCapture,
  type OpenSemanticFactorFormationCapture,
  type OpenSemanticFactorGraph,
  type OpenSemanticProposition
} from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "../../../../shared/field-hash.js";
import type { RecallQueryProbes } from "../../recall-query-probes.js";
import type {
  CanonicalAnswerProgramV1,
  CanonicalConstantV1,
  CanonicalVariableV1
} from "../types.js";
import {
  captureDigest,
  entityConstantsFrom,
  naryPredicate,
  pushSupportedQuery,
  pushUnresolved,
  type AdapterSink
} from "./phi.js";

export function adaptOsfCapture(
  capture: unknown,
  answer: CanonicalAnswerProgramV1 | null,
  sink: AdapterSink,
  probes: Readonly<RecallQueryProbes>
): void {
  if (capture === undefined || capture === null) return;
  const verified = verifiedCurrentQueryOsfCapture(capture, probes);
  if (verified === null) {
    pushUnadapted(capture as object, sink);
    return;
  }
  if (verified.status !== "formed" || verified.graph === null) {
    pushUnadapted(verified, sink);
    return;
  }
  if (verified.graph.result_variable_ids.length !== 1) {
    pushUnresolved(sink.unresolved, {
      code: verified.graph.result_variable_ids.length === 0
        ? "unknown_answer_variable"
        : "unknown_correlation",
      source: "osf",
      capture_digest: captureDigest(verified)
    });
    return;
  }
  if (verified.graph.propositions.length > 1) {
    // Flattening a 2+ proposition graph would invent a v1 correlation partition.
    pushUnresolved(sink.unresolved, {
      code: "unknown_correlation",
      source: "osf",
      capture_digest: captureDigest(verified)
    });
  }
  if (answer === null) return;
  const adapted = adaptGraph(verified, verified.graph, answer, sink);
  if (!adapted) pushUnadapted(verified, sink);
}

export function verifiedCurrentQueryOsfCapture(
  capture: unknown,
  probes: Readonly<Pick<RecallQueryProbes, "normalized_query">>,
  ownerQueryText: string | null = probes.normalized_query
): OpenSemanticFactorFormationCapture | null {
  if (probes.normalized_query !== ownerQueryText) return null;
  const verified = verifiedOsfCapture(capture);
  if (verified === null) return null;
  const expectedSource = ownerQueryText === null
    ? null
    : `sha256:${fieldContractSha256(ownerQueryText)}`;
  return verified.source_sha256 === expectedSource ? verified : null;
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
  if (factor === undefined || factor.semantic_identity.length === 0) {
    pushUnknownRelation(sink, proposition.proposition_id);
    return false;
  }
  const bound = bindPropositionArguments(proposition, graph);
  if (bound === null) {
    pushUnknownRelation(sink, proposition.proposition_id);
    return false;
  }
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
  const factorValues: string[] = [];
  const variables: CanonicalVariableV1[] = [{ name: "x0", sort: "entity" }];
  const variableNames = new Set<string>(["x0"]);
  for (const argument of ordered) {
    if (argument.reference_kind === "factor") {
      const referenced = graph.factors.find((item) => item.factor_id === argument.reference_id);
      if (referenced === undefined || referenced.semantic_identity.length === 0) return null;
      factorValues.push(referenced.semantic_identity);
      arguments_.push(referenced.semantic_identity);
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
  return { arguments: arguments_, variables, constants: entityConstantsFrom(factorValues) };
}

function pushUnknownRelation(sink: AdapterSink, propositionId: string): void {
  pushUnresolved(sink.unresolved, {
    code: "unknown_relation",
    source: "osf",
    detail: propositionId
  });
}

function pushUnadapted(capture: object, sink: AdapterSink): void {
  pushUnresolved(sink.unresolved, {
    code: "unadapted_osf",
    source: "osf",
    capture_digest: captureDigest(capture),
    detail: (capture as { readonly status?: string }).status
  });
}

function verifiedOsfCapture(value: unknown): OpenSemanticFactorFormationCapture | null {
  try {
    return verifyOpenSemanticFactorFormationCapture(value, fieldContractSha256);
  } catch {
    return null;
  }
}
