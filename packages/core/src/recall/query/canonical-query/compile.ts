import type { OpenSemanticFactorFormationCapture } from "@do-soul/alaya-protocol";
import type { RecallQueryFactFrameExtractionCapture } from
  "../../field/query-attribution/query-fact-frame-attribution-producer.js";
import { compileRecallAnswerShapePlan, type RecallAnswerShapePlan } from
  "../recall-answer-shape-plan.js";
import { compileRecallQueryDemand, type RecallQueryDemand } from
  "../recall-query-demand.js";
import type { RecallQueryProbes } from "../recall-query-probes.js";
import { adaptFactFrameCapture } from "./adapters/fact-frame.js";
import { adaptOsfCapture } from "./adapters/osf.js";
import {
  normalizeRelationToken,
  pushUnresolved,
  type AdapterSink,
  type AdapterUnresolved
} from "./adapters/phi.js";
import {
  collectProbeHoles,
  rejectUnsupportedShape,
  SHAPE_PRODUCER,
  shapePredicates
} from "./adapters/shape.js";
import {
  CanonicalQueryContractError,
  type CanonicalAnswerProgramV1,
  type CanonicalEvidenceProvenanceV1,
  type CanonicalQueryV1
} from "./types.js";
import {
  bindAllObservableCompletion,
  digestCanonicalQueryV1,
  validateCanonicalQueryV1
} from "./validate.js";

export type CanonicalQueryCaptureEvidenceV1 = Readonly<{
  readonly status?: string;
  readonly capture_digest?: string;
}>;

export type CanonicalQueryEvidenceV1 = Readonly<{
  readonly probes: Readonly<RecallQueryProbes>;
  readonly demand?: Readonly<RecallQueryDemand>;
  readonly shape?: Readonly<RecallAnswerShapePlan>;
  readonly factFrameCapture?:
    | RecallQueryFactFrameExtractionCapture
    | CanonicalQueryCaptureEvidenceV1
    | null;
  readonly osfCapture?:
    | OpenSemanticFactorFormationCapture
    | CanonicalQueryCaptureEvidenceV1
    | null;
  readonly observer?: Readonly<{
    readonly principal: string;
    readonly scope: string;
    readonly observer_universe: readonly string[];
  }>;
  readonly query_identity?: Readonly<{
    readonly condition_identity: string;
    readonly query_operator_id: string;
    readonly generation_id: string;
    readonly query_cache_key: string;
  }>;
}>;

export type CanonicalQueryUnresolvedV1 = Readonly<AdapterUnresolved>;

export type CanonicalQueryCompileV1 = Readonly<{
  readonly hypotheses: readonly CanonicalQueryV1[];
  readonly unresolved: readonly CanonicalQueryUnresolvedV1[];
  readonly provenance: readonly string[];
  readonly hypothesis_provenance: readonly CanonicalEvidenceProvenanceV1[];
}>;

export function compileCanonicalQueryEvidence(
  evidence: CanonicalQueryEvidenceV1
): CanonicalQueryCompileV1 {
  const sink = createSink(evidence);
  const answer = resolveAnswer(sink.shape, evidence, sink.unresolved);
  collectProbeHoles(evidence.probes, sink.unresolved);
  pushShapePrograms(sink, answer);
  const adapterAnswer = answer ?? { kind: "scalar" as const, variable: "x0" };
  adaptFactFrameCapture(evidence.factFrameCapture, adapterAnswer, sink);
  adaptOsfCapture(evidence.osfCapture, adapterAnswer, sink);
  pushOrderingHoles(sink.demand, sink.unresolved);
  sink.unresolved.push(...unadaptedDemandAtoms(sink.demand, sink.hypotheses));
  sink.unresolved.push(...unboundTargetTerms(sink.shape, sink.hypotheses));
  pushUnknownAnswerHole(sink);
  pushRelationConflicts(sink);
  return freezeCompile(dedupeQueries(sink));
}

function createSink(evidence: CanonicalQueryEvidenceV1): AdapterSink & {
  readonly demand: Readonly<RecallQueryDemand>;
  readonly shape: Readonly<RecallAnswerShapePlan>;
} {
  return {
    demand: evidence.demand ?? compileRecallQueryDemand(evidence.probes),
    shape: evidence.shape ?? compileRecallAnswerShapePlan(evidence.probes),
    hypotheses: [],
    hypothesis_provenance: [],
    unresolved: [],
    provenance: ["probes", "demand", "shape"]
  };
}

function resolveAnswer(
  shape: Readonly<RecallAnswerShapePlan>,
  evidence: CanonicalQueryEvidenceV1,
  unresolved: AdapterUnresolved[]
): CanonicalAnswerProgramV1 | null {
  if (shape.shape !== "distinct_entities") {
    return { kind: "scalar", variable: "x0" };
  }
  const answer = distinctAnswer(evidence);
  if (answer === null) {
    pushUnresolved(unresolved, { code: "unknown_scope", source: "observer" });
  }
  return answer;
}

function pushShapePrograms(
  sink: AdapterSink & { readonly shape: Readonly<RecallAnswerShapePlan> },
  answer: CanonicalAnswerProgramV1 | null
): void {
  if (rejectUnsupportedShape(sink.shape, sink.unresolved)) return;
  if (answer === null) return;
  if (sink.shape.status !== "high_confidence") return;
  const predicates = shapePredicates(sink.shape);
  if (predicates.length === 0 && sink.shape.shape !== "distinct_entities") return;
  const result = validateCanonicalQueryV1({
    variables: [{ name: "x0", sort: "entity" }],
    predicates,
    answer
  });
  if (result.status !== "supported") {
    pushUnresolved(sink.unresolved, { code: result.reason_code, source: "validator" });
    return;
  }
  sink.hypotheses.push(result.query);
  sink.hypothesis_provenance.push(Object.freeze({
    source_id: "shape.relation_terms",
    producer: SHAPE_PRODUCER
  }));
  sink.provenance.push("shape.relation_terms");
}

function pushOrderingHoles(
  demand: Readonly<RecallQueryDemand>,
  unresolved: AdapterUnresolved[]
): void {
  for (const atom of demand.atoms) {
    if (atom.kind !== "ordering") continue;
    if (atom.value === "latest" || atom.value === "earliest") {
      pushUnresolved(unresolved, {
        code: "latest_without_typed_time_key",
        source: "demand"
      });
      pushUnresolved(unresolved, { code: "unknown_time_basis", source: "demand" });
    }
    if (atom.value === "sequence") {
      pushUnresolved(unresolved, { code: "unsupported_nesting", source: "demand" });
    }
  }
}

function distinctAnswer(
  evidence: CanonicalQueryEvidenceV1
): CanonicalAnswerProgramV1 | null {
  const observer = evidence.observer;
  if (observer === undefined) return null;
  try {
    return {
      kind: "distinct",
      variable: "x0",
      completion: bindAllObservableCompletion({
        principal: observer.principal,
        scope: observer.scope,
        observer_universe: observer.observer_universe
      })
    };
  } catch (error) {
    if (error instanceof CanonicalQueryContractError) return null;
    throw error;
  }
}

function unadaptedDemandAtoms(
  demand: Readonly<RecallQueryDemand>,
  hypotheses: readonly CanonicalQueryV1[]
): CanonicalQueryUnresolvedV1[] {
  const used = usedHypothesisTokens(hypotheses);
  return demand.atoms.flatMap((atom) => {
    if (atom.kind === "ordering") return [];
    if (atom.kind === "lexical_term" && used.has(atom.value)) return [];
    return [{
      code: `unadapted_demand_${atom.kind}`,
      source: "demand",
      detail: atom.id
    }];
  });
}

function unboundTargetTerms(
  shape: Readonly<RecallAnswerShapePlan>,
  hypotheses: readonly CanonicalQueryV1[]
): CanonicalQueryUnresolvedV1[] {
  const used = usedHypothesisTokens(hypotheses);
  return shape.target_terms.flatMap((term) => used.has(term)
    ? []
    : [{ code: "unbound_target_term", source: "shape", detail: term }]);
}

function usedHypothesisTokens(hypotheses: readonly CanonicalQueryV1[]): Set<string> {
  const used = new Set<string>();
  for (const query of hypotheses) {
    for (const predicate of query.predicates) {
      used.add(predicate.relation);
      for (const argument of predicate.arguments) used.add(argument);
    }
  }
  return used;
}

function pushUnknownAnswerHole(
  sink: AdapterSink & { readonly shape: Readonly<RecallAnswerShapePlan> }
): void {
  const shape = sink.shape;
  if (shape.shape === "count" || shape.shape === "sum" || shape.shape === "duration") {
    return;
  }
  if (shape.status !== "unknown" && shape.target_terms.length > 0) return;
  pushUnresolved(sink.unresolved, { code: "unknown_answer_variable", source: "shape" });
}

function pushRelationConflicts(sink: AdapterSink): void {
  const shape = relationSet(sink.hypotheses, "shape.relation_terms");
  const frames = relationSet(sink.hypotheses, "fact_frame.relation.");
  const osf = relationSet(sink.hypotheses, "osf.relation.");
  if (conflicted(shape, frames) || conflicted(shape, osf) || conflicted(frames, osf)) {
    pushUnresolved(sink.unresolved, { code: "conflicting_demand_shape", source: "shape" });
    pushUnresolved(sink.unresolved, { code: "conflicting_shape", source: "shape" });
  }
}

function relationSet(
  hypotheses: readonly CanonicalQueryV1[],
  sourcePrefix: string
): ReadonlySet<string> {
  const tokens = new Set<string>();
  for (const query of hypotheses) {
    for (const predicate of query.predicates) {
      const source = predicate.provenance?.source_id ?? "";
      if (!source.startsWith(sourcePrefix)) continue;
      const token = normalizeRelationToken(predicate.relation);
      if (token.length > 0) tokens.add(token);
    }
  }
  return tokens;
}

function conflicted(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>
): boolean {
  if (left.size === 0 || right.size === 0) return false;
  if (left.size !== right.size) return true;
  return [...left].some((token) => !right.has(token));
}

function dedupeQueries(sink: AdapterSink): AdapterSink {
  const seen = new Set<string>();
  const hypotheses: CanonicalQueryV1[] = [];
  const provenance: CanonicalEvidenceProvenanceV1[] = [];
  sink.hypotheses.forEach((query, index) => {
    const key = digestCanonicalQueryV1(query);
    if (seen.has(key)) return;
    seen.add(key);
    hypotheses.push(query);
    const row = sink.hypothesis_provenance[index];
    if (row !== undefined) provenance.push(row);
  });
  sink.hypotheses.splice(0, sink.hypotheses.length, ...hypotheses);
  sink.hypothesis_provenance.splice(
    0,
    sink.hypothesis_provenance.length,
    ...provenance
  );
  return sink;
}

function freezeCompile(sink: AdapterSink): CanonicalQueryCompileV1 {
  return Object.freeze({
    hypotheses: Object.freeze([...sink.hypotheses]),
    unresolved: Object.freeze([...sink.unresolved]),
    provenance: Object.freeze([...sink.provenance]),
    hypothesis_provenance: Object.freeze([...sink.hypothesis_provenance])
  });
}
