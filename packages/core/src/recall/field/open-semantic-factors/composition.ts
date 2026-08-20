import { createHash } from "node:crypto";
import {
  verifyOpenSemanticFactorFormationCapture,
  type OpenSemanticFactorFormationCapture
} from "@do-soul/alaya-protocol";
import { digestRecallFieldIdentity, type RecallFieldDigest } from
  "../field-identity.js";
import {
  verifyOpenSemanticFactorCompatibilityTrace,
  type OpenSemanticFactorCompatibilityTrace
} from "./compatibility-trace.js";
import {
  emptyOpenSemanticFactorSearch,
  OPEN_SEMANTIC_FACTOR_BINDING_LIMIT,
  OPEN_SEMANTIC_FACTOR_SOLUTION_LIMIT,
  searchOpenSemanticFactorCompositions,
  uniqueSortedStrings,
  type OpenSemanticFactorBindingObservation,
  type OpenSemanticFactorCompositionSolution,
  type OpenSemanticFactorSolutionBinding
} from "./composition-search.js";
import {
  classifyOpenSemanticFactorCompositionStatus,
  type OpenSemanticFactorCompositionStatus
} from "./composition-status.js";
import { compareText } from "../../../shared/compare-text.js";

export const OPEN_SEMANTIC_FACTOR_COMPOSITION_OPERATOR_ID =
  "open_semantic_factor_composition_v2";
export {
  OPEN_SEMANTIC_FACTOR_BINDING_LIMIT,
  OPEN_SEMANTIC_FACTOR_SOLUTION_LIMIT
};
export type {
  OpenSemanticFactorBindingObservation,
  OpenSemanticFactorCompositionSolution,
  OpenSemanticFactorSolutionBinding
};
export type { OpenSemanticFactorCompositionStatus };

export type OpenSemanticFactorVariableValue = Readonly<{
  readonly semantic_identity: string;
  readonly surfaces: readonly string[];
  readonly evidence_ids: readonly string[];
}>;

export type OpenSemanticFactorVariableCollection = Readonly<{
  readonly variable_id: string;
  readonly observation_count: number;
  readonly distinct_value_count: number;
  readonly values: readonly Readonly<OpenSemanticFactorVariableValue>[];
}>;

export type OpenSemanticFactorCompositionReceipt = Readonly<{
  readonly schema_version: 2;
  readonly operator_id: typeof OPEN_SEMANTIC_FACTOR_COMPOSITION_OPERATOR_ID;
  readonly status: OpenSemanticFactorCompositionStatus;
  readonly compatibility_trace_digest: RecallFieldDigest;
  readonly query_capture_digest: string;
  readonly result_variable_ids: readonly string[];
  readonly search_step_count: number;
  readonly solution_count: number;
  readonly observed_binding_count: number;
  readonly binding_observation_count: number;
  readonly truncated: boolean;
  readonly bindings: readonly Readonly<OpenSemanticFactorBindingObservation>[];
  readonly solutions: readonly Readonly<OpenSemanticFactorCompositionSolution>[];
  readonly variable_collections: readonly Readonly<OpenSemanticFactorVariableCollection>[];
  readonly receipt_digest: RecallFieldDigest;
}>;

export function materializeOpenSemanticFactorComposition(params: Readonly<{
  readonly trace: Readonly<OpenSemanticFactorCompatibilityTrace>;
  readonly query_capture: Readonly<OpenSemanticFactorFormationCapture>;
}>): OpenSemanticFactorCompositionReceipt {
  const trace = verifyOpenSemanticFactorCompatibilityTrace(params.trace);
  const query = verifyCapture(params.query_capture);
  if (trace.query_capture_digest !== query.capture_digest) {
    throw new Error("open semantic factor composition query identity mismatch");
  }
  const search = query.status === "formed" && query.graph?.source_kind === "query"
    ? searchOpenSemanticFactorCompositions(query.graph, trace)
    : emptyOpenSemanticFactorSearch(trace.truncated);
  const bindings = Object.freeze(
    search.observations.slice(0, OPEN_SEMANTIC_FACTOR_BINDING_LIMIT)
  );
  const solutions = Object.freeze(
    search.solutions.slice(0, OPEN_SEMANTIC_FACTOR_SOLUTION_LIMIT)
  );
  const truncated = search.truncated ||
    search.observations.length > bindings.length ||
    search.solutions.length > solutions.length;
  const body = Object.freeze({
    schema_version: 2 as const,
    operator_id: OPEN_SEMANTIC_FACTOR_COMPOSITION_OPERATOR_ID,
    status: classifyOpenSemanticFactorCompositionStatus({
      query, trace, solutionCount: solutions.length, truncated
    }),
    compatibility_trace_digest: trace.trace_digest,
    query_capture_digest: query.capture_digest,
    result_variable_ids: Object.freeze([...(query.graph?.result_variable_ids ?? [])]),
    search_step_count: search.searchStepCount,
    solution_count: solutions.length,
    observed_binding_count: search.observations.length,
    binding_observation_count: bindings.length,
    truncated,
    bindings,
    solutions,
    variable_collections: collectVariableCollections(solutions)
  });
  return Object.freeze({
    ...body,
    receipt_digest: digestRecallFieldIdentity(body)
  });
}

export function verifyOpenSemanticFactorComposition(params: Readonly<{
  readonly receipt: Readonly<OpenSemanticFactorCompositionReceipt>;
  readonly trace: Readonly<OpenSemanticFactorCompatibilityTrace>;
  readonly query_capture: Readonly<OpenSemanticFactorFormationCapture>;
}>): OpenSemanticFactorCompositionReceipt {
  const expected = materializeOpenSemanticFactorComposition(params);
  if (expected.receipt_digest !== params.receipt.receipt_digest ||
      digestCompositionBody(params.receipt) !== params.receipt.receipt_digest) {
    throw new Error("open semantic factor composition receipt digest mismatch");
  }
  return params.receipt as OpenSemanticFactorCompositionReceipt;
}

function collectVariableCollections(
  solutions: readonly Readonly<OpenSemanticFactorCompositionSolution>[]
): readonly Readonly<OpenSemanticFactorVariableCollection>[] {
  const bindings = solutions.flatMap(({ result_bindings: resultBindings }) => resultBindings);
  const byVariable = groupByStringKey(bindings, ({ variable_id: variableId }) => variableId);
  return Object.freeze([...byVariable].sort(([left], [right]) => compareText(left, right))
    .map(([variableId, variableBindings]) => {
      const byValue = groupByStringKey(
        variableBindings,
        ({ semantic_identity: semanticIdentity }) => semanticIdentity
      );
      const values = [...byValue].sort(([left], [right]) => compareText(left, right))
        .map(([semanticIdentity, valueBindings]) => Object.freeze({
          semantic_identity: semanticIdentity,
          surfaces: uniqueSortedStrings(valueBindings.flatMap(({ surfaces }) => surfaces)),
          evidence_ids: uniqueSortedStrings(valueBindings.flatMap(({ evidence_ids: ids }) => ids))
        }));
      return Object.freeze({
        variable_id: variableId,
        observation_count: variableBindings.length,
        distinct_value_count: values.length,
        values: Object.freeze(values)
      });
    }));
}

function verifyCapture(
  capture: Readonly<OpenSemanticFactorFormationCapture>
): OpenSemanticFactorFormationCapture {
  return verifyOpenSemanticFactorFormationCapture(capture, sha256);
}

function digestCompositionBody(
  receipt: Readonly<OpenSemanticFactorCompositionReceipt>
): RecallFieldDigest {
  const { receipt_digest: _digest, ...body } = receipt;
  return digestRecallFieldIdentity(body);
}

function groupByStringKey<T>(
  values: readonly T[],
  keyOf: (value: T) => string
): ReadonlyMap<string, readonly T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const key = keyOf(value);
    const group = grouped.get(key);
    if (group === undefined) grouped.set(key, [value]);
    else group.push(value);
  }
  return grouped;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
