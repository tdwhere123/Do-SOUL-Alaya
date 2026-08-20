import type { z } from "zod";
import {
  OpenSemanticFactorGraphProposalSchema,
  groundOpenSemanticFactorGraph,
  type OpenSemanticFactorGraphProposal
} from "@do-soul/alaya-protocol";

type SemanticGraphCardinalitySubject =
  | "arguments"
  | "factors"
  | "field"
  | "propositions"
  | "result_variables"
  | "variables";

export type OfficialApiSemanticFactorGraphProjectionReason =
  | "semantic_factor_graph_missing"
  | `semantic_factor_graph_invalid_${SemanticGraphCardinalitySubject}_${"too_few" | "too_many"}`
  | "semantic_factor_graph_invalid_identity"
  | "semantic_factor_graph_invalid_reference"
  | "semantic_factor_graph_invalid_shape"
  | "semantic_factor_graph_invalid_structure"
  | "semantic_factor_graph_invalid_unbound"
  | "semantic_factor_graph_not_source_grounded";

export interface OfficialApiSemanticFactorGraphProjectionAudit {
  readonly status: "unavailable" | "rejected";
  readonly reason: OfficialApiSemanticFactorGraphProjectionReason;
}

const REJECTED_SEMANTIC_FACTOR_GRAPH_PROJECTION_REASONS = new Set<string>([
  "semantic_factor_graph_invalid_arguments_too_few",
  "semantic_factor_graph_invalid_arguments_too_many",
  "semantic_factor_graph_invalid_factors_too_few",
  "semantic_factor_graph_invalid_factors_too_many",
  "semantic_factor_graph_invalid_field_too_few",
  "semantic_factor_graph_invalid_field_too_many",
  "semantic_factor_graph_invalid_propositions_too_few",
  "semantic_factor_graph_invalid_propositions_too_many",
  "semantic_factor_graph_invalid_result_variables_too_few",
  "semantic_factor_graph_invalid_result_variables_too_many",
  "semantic_factor_graph_invalid_variables_too_few",
  "semantic_factor_graph_invalid_variables_too_many",
  "semantic_factor_graph_invalid_identity",
  "semantic_factor_graph_invalid_reference",
  "semantic_factor_graph_invalid_shape",
  "semantic_factor_graph_invalid_structure",
  "semantic_factor_graph_invalid_unbound",
  "semantic_factor_graph_not_source_grounded"
]);

export type OfficialApiSemanticFactorGraphProjection = Readonly<
  | {
    readonly graph: OpenSemanticFactorGraphProposal;
    readonly audit?: never;
  }
  | {
    readonly graph?: never;
    readonly audit: OfficialApiSemanticFactorGraphProjectionAudit;
  }
>;

export function inspectOfficialApiSemanticFactorGraphProjection(
  value: unknown
): OfficialApiSemanticFactorGraphProjection {
  if (value === undefined || value === null) {
    return Object.freeze({
      audit: Object.freeze({
        status: "unavailable",
        reason: "semantic_factor_graph_missing"
      })
    });
  }
  const parsed = OpenSemanticFactorGraphProposalSchema.safeParse(value);
  return parsed.success
    ? Object.freeze({ graph: parsed.data })
    : Object.freeze({
      audit: Object.freeze({
        status: "rejected",
        reason: classifySemanticFactorGraphRejection(parsed.error)
      })
    });
}

export type OfficialApiSemanticFactorGraphFields = Readonly<{
  readonly semantic_factor_graph?: OpenSemanticFactorGraphProposal;
  readonly semantic_factor_graph_projection?: OfficialApiSemanticFactorGraphProjectionAudit;
}>;

export function projectOfficialApiSemanticFactorGraph(
  graph: unknown,
  assertion: string | null
): OfficialApiSemanticFactorGraphFields {
  const inspected = inspectOfficialApiSemanticFactorGraphProjection(graph);
  if (inspected.audit !== undefined) {
    return Object.freeze({ semantic_factor_graph_projection: inspected.audit });
  }
  if (assertion === null) return notSourceGrounded();
  const grounded = groundOpenSemanticFactorGraph(inspected.graph, assertion);
  if (grounded === null || grounded.source_kind !== "evidence") {
    return notSourceGrounded();
  }
  return Object.freeze({ semantic_factor_graph: inspected.graph });
}

function notSourceGrounded(): OfficialApiSemanticFactorGraphFields {
  return Object.freeze({
    semantic_factor_graph_projection: Object.freeze({
      status: "rejected" as const,
      reason: "semantic_factor_graph_not_source_grounded" as const
    })
  });
}

export function parseOfficialApiSemanticFactorGraphProjectionAudit(
  value: unknown
): OfficialApiSemanticFactorGraphProjectionAudit | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const projection = value as Record<string, unknown>;
  const reason = projection.reason;
  if (projection.status === "unavailable" &&
      reason === "semantic_factor_graph_missing") {
    return Object.freeze({ status: projection.status, reason });
  }
  if (projection.status === "rejected" && typeof reason === "string" &&
      REJECTED_SEMANTIC_FACTOR_GRAPH_PROJECTION_REASONS.has(reason)) {
    return Object.freeze({
      status: projection.status,
      reason: reason as OfficialApiSemanticFactorGraphProjectionReason
    });
  }
  return null;
}

function classifySemanticFactorGraphRejection(
  error: z.ZodError
): OfficialApiSemanticFactorGraphProjectionReason {
  const messages = error.issues.map(({ message }) => message);
  if (messages.includes("semantic factor graph has unbound values")) {
    return "semantic_factor_graph_invalid_unbound";
  }
  if (messages.some((message) => /reference|predicate factor is missing/iu.test(message))) {
    return "semantic_factor_graph_invalid_reference";
  }
  if (error.issues.some(({ path, message }) =>
    path.at(-1) === "semantic_identity" || path.at(-1) === "binding_identity" ||
      /semantic identity/iu.test(message))) {
    return "semantic_factor_graph_invalid_identity";
  }
  const cardinality = error.issues.find(
    ({ code }) => code === "too_big" || code === "too_small"
  );
  if (cardinality !== undefined &&
      (cardinality.code === "too_big" || cardinality.code === "too_small")) {
    const subject = semanticGraphCardinalitySubject(cardinality.path);
    const direction = cardinality.code === "too_big" ? "too_many" : "too_few";
    return `semantic_factor_graph_invalid_${subject}_${direction}`;
  }
  if (messages.some((message) => /unique|contiguous|evidence graph cannot/iu.test(message))) {
    return "semantic_factor_graph_invalid_structure";
  }
  return "semantic_factor_graph_invalid_shape";
}

function semanticGraphCardinalitySubject(
  path: readonly PropertyKey[]
): SemanticGraphCardinalitySubject {
  if (path.includes("factors")) return "factors";
  if (path.includes("variables")) return "variables";
  if (path.includes("result_variable_ids")) return "result_variables";
  if (path.includes("propositions")) {
    return path.includes("arguments") ? "arguments" : "propositions";
  }
  return "field";
}
